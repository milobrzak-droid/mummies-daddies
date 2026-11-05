import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'

// Next komponenty mimo běžící aplikaci nahradíme prostým HTML; router zachytí push.
const push = vi.fn()
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => <a href={href} {...rest}>{children}</a>,
}))
vi.mock('next/image', async () => {
  const { createElement } = await import('react')
  // Vlastnosti, které zná jen next/image, do <img> nepatří.
  const props = (p: Record<string, unknown>) => {
    const rest = { ...p }
    for (const k of ['fill', 'preload', 'quality']) delete rest[k]
    return { ...rest, srcSet: `${String(p.src)} 1x` }
  }
  return {
    // createElement: náhrada next/image musí vykreslit holý <img> (alt přichází v props).
    default: (p: Record<string, unknown>) => createElement('img', props(p)),
    getImageProps: (p: Record<string, unknown>) => ({ props: props(p) }),
  }
})
vi.mock('next/navigation', () => ({
  usePathname: () => '/poptavka',
  useRouter: () => ({ push, replace: vi.fn(), prefetch: vi.fn(), back: vi.fn() }),
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND')
  },
}))

import InquiryPage from '@/app/(web)/poptavka/page'
import ConfirmationPage from '@/app/(web)/poptavka/odeslano/page'
import FaqPage from '@/app/(web)/caste-dotazy/page'
import TermsPage from '@/app/(web)/obchodni-podminky/page'
import PrivacyPage from '@/app/(web)/ochrana-osobnich-udaju/page'
import CookiesPage from '@/app/(web)/cookies/page'
import WebNotFound from '@/app/(web)/not-found'
import UnknownPage from '@/app/(web)/[...nenalezeno]/page'
import sitemap from '@/app/(web)/sitemap'
import robots from '@/app/robots'
import CheesecakePage from '@/app/(web)/cheesecaky/[slug]/page'
import { InquiryWizard } from '@/components/web/poptavka'
import { withResponseClaim } from '@/lib/web/claims'
import { submitInquiry } from '@/lib/web/api'
import { allPages, getPage, microcopy, parseCta, parseItem } from '@/lib/web/content'
import { isoDate } from '@/lib/web/format'
import { parseInquiryParams } from '@/lib/web/inquiry-link'
import { BLOG_ARTICLES } from '@/lib/web/duvera/blog'
import { confirmationCopy, faqGroups, legalPageCopy, wizardLabels } from '@/lib/web/poptavka/copy'
import { draftFromPrefill, emptyDraft, initialStep, toWebInquiry, type InquiryDraft } from '@/lib/web/poptavka/draft'
import { firstStepWithError, validateDraft } from '@/lib/web/poptavka/schema'
import { CONFIRMATION_STORAGE_KEY, DRAFT_STORAGE_KEY } from '@/lib/web/poptavka/types'
import { legacyRedirectConfig, parseRedirectLines } from '@/lib/web/redirects'
import { MESSAGES, validateInquiry } from '@/lib/web/validation'
import { installWebApiFake } from '../helpers/webApiFake'

const TODAY = '2026-11-05'
const norm = (s: string | null | undefined) => (s ?? '').replace(/\s+/g, ' ').trim()

function render(node: ReactNode): Document {
  const doc = document.implementation.createHTMLDocument('t')
  doc.body.innerHTML = renderToStaticMarkup(node)
  return doc
}
const text = (doc: Document) => norm(doc.body.textContent)

const KNOWN_PATHS = new Set([
  ...allPages().map((p) => p.path),
  ...BLOG_ARTICLES.map((a) => `/blog/${a.slug}`),
  '/poptavka/odeslano',
])

function expectBasics(doc: Document) {
  expect(doc.querySelectorAll('h1')).toHaveLength(1)
  const ids = Array.from(doc.querySelectorAll('[id]')).map((e) => e.id)
  expect(new Set(ids).size, `duplicitní id: ${ids.filter((x, i) => ids.indexOf(x) !== i)}`).toBe(ids.length)
  for (const el of Array.from(doc.querySelectorAll('[aria-labelledby]'))) {
    expect(doc.getElementById(el.getAttribute('aria-labelledby')!), el.getAttribute('aria-labelledby')!).not.toBeNull()
  }
  for (const img of Array.from(doc.querySelectorAll('img'))) expect((img.getAttribute('alt') ?? '').length).toBeGreaterThan(0)
  for (const f of Array.from(doc.querySelectorAll('input:not([type=hidden]), select, textarea'))) {
    expect(doc.querySelector(`label[for="${f.id}"]`), `pole ${f.getAttribute('name')} bez popisku`).not.toBeNull()
  }
  for (const a of Array.from(doc.querySelectorAll('a[href]'))) {
    const href = a.getAttribute('href')!
    if (/^(tel:|mailto:|https:)/.test(href) || href.startsWith('#')) continue
    expect(KNOWN_PATHS.has(href.split(/[?#]/)[0]), `neznámá cesta ${href}`).toBe(true)
  }
}

function jsonLd(doc: Document): Record<string, unknown>[] {
  return Array.from(doc.querySelectorAll('script[type="application/ld+json"]')).map((s) => JSON.parse(s.textContent ?? '{}'))
}

/** Vyplněný stav průvodce (svatba, 80 hostů, za firmu). */
function filledDraft(over: Partial<InquiryDraft> = {}): InquiryDraft {
  return {
    ...emptyDraft({ channel: 'formular', page: '/catering/svatby', ref: null }),
    eventType: 'svatba',
    guests: '80',
    eventDate: '2027-06-12',
    address: 'Zámek, 120 00 Praha',
    customerKind: 'firma',
    companyName: 'Firma s.r.o.',
    companyIco: '12345678',
    name: 'Jana Nováková',
    email: 'jana@firma.cz',
    phone: '+420 737 000 000',
    consent: true,
    ...over,
  }
}

// ── validace (zod) a převod na kontrakt ─────────────────────────────────────

// Napojení na systém (P6): fetch na /api/web/** jde do serverových funkcí se Supabase mockem.
beforeEach(() => { installWebApiFake() })
afterEach(() => { vi.unstubAllGlobals() })

describe('validace průvodce (zod)', () => {
  it('prázdný průvodce hlásí povinná pole doslova z mikrotextů', () => {
    const e = validateDraft(emptyDraft(), undefined, TODAY)
    expect(e.eventType).toBe(microcopy('CHYBA — povinné pole'))
    expect(e.customerKind).toBe(MESSAGES.required)
    expect(e.guests).toBe(MESSAGES.required)
    expect(e['venue.address']).toBe(MESSAGES.required)
    expect(e['contact.email']).toBe(MESSAGES.required)
    expect(e.consent).toBe(microcopy('CHYBA — souhlas'))
    expect(firstStepWithError(e)).toBe('typ')
  })

  it('kontroluje jen pole daného kroku', () => {
    expect(Object.keys(validateDraft(emptyDraft(), 'hoste', TODAY))).toEqual(['guests'])
    expect(validateDraft({ ...emptyDraft(), eventType: 'oslava' }, 'typ', TODAY)).toEqual({})
  })

  it('minimum osob podle typu akce (mikrotext s {minimum})', () => {
    const e = validateDraft({ ...emptyDraft(), eventType: 'coffee-break', guests: '10' }, 'hoste', TODAY)
    expect(e.guests).toBe(microcopy('CHYBA — počet osob pod minimem', { minimum: 15 }))
    expect(validateDraft({ ...emptyDraft(), eventType: 'coffee-break', guests: '15' }, 'hoste', TODAY)).toEqual({})
  })

  it('konzultace nepotřebuje počet osob ani místo', () => {
    const e = validateDraft({ ...emptyDraft(), eventType: 'konzultace' }, undefined, TODAY)
    expect(e.guests).toBeUndefined()
    expect(e['venue.address']).toBeUndefined()
  })

  it('datum v minulosti, e-mail, telefon a IČO (jen u firmy)', () => {
    const e = validateDraft(filledDraft({ eventDate: '2026-01-01', email: 'jana@', phone: '737', companyIco: '123' }), undefined, TODAY)
    expect(e.eventDate).toBe(MESSAGES.pastDate)
    expect(e['contact.email']).toBe(microcopy('CHYBA — e-mail'))
    expect(e['contact.phone']).toBe(microcopy('CHYBA — telefon'))
    expect(e['company.ico']).toBe(microcopy('CHYBA — IČO'))
    expect(validateDraft(filledDraft({ customerKind: 'soukrome', companyIco: '123' }), undefined, TODAY)['company.ico']).toBeUndefined()
  })

  it('„Hledám prostor“ nahradí adresu', () => {
    expect(validateDraft(filledDraft({ address: '', needsVenue: true }), 'misto', TODAY)).toEqual({})
  })

  it('vyplněný průvodce → WebInquiry, kterou přijme validace kontraktu i server', async () => {
    const draft = filledDraft({ diets: ['vegan'], extras: ['sladky-bar'], budget: '900' })
    expect(validateDraft(draft, undefined, TODAY)).toEqual({})
    const x = toWebInquiry(draft)
    expect(x).toMatchObject({
      eventType: 'svatba', customerKind: 'firma', segment: 'b2b', guests: 80, budgetPerPerson: 900,
      company: { name: 'Firma s.r.o.', ico: '12345678' }, venue: { address: 'Zámek, 120 00 Praha', needsVenue: false },
      contact: { name: 'Jana Nováková', email: 'jana@firma.cz', phone: '+420 737 000 000' }, source: { channel: 'formular', page: '/catering/svatby' },
    })
    expect(validateInquiry(x, TODAY)).toEqual({})
    const res = await submitInquiry(x)
    expect(res.ok && res.outcome).toBe('na-miru')
  })

  it('soukromá akce neposílá firmu; předvyplnění určuje první krok', () => {
    expect(toWebInquiry(filledDraft({ customerKind: 'soukrome' })).company).toBeNull()
    const p = parseInquiryParams({ typ: 'svatba', osob: '80', zdroj: '/catering/svatby', doplnek: 'cheesecaky' })
    const d = draftFromPrefill(p)
    expect(d).toMatchObject({ eventType: 'svatba', guests: '80', extras: ['cheesecaky'] })
    expect(initialStep(p.prefilled)).toBe('datum')
    expect(initialStep([])).toBe('typ')
  })
})

// ── /poptavka ───────────────────────────────────────────────────────────────

describe('/poptavka (server render)', () => {
  it('úvod, volba, co bude dál, člověk a důvěra doslova; předvyplnění z odkazu', async () => {
    const doc = render(await InquiryPage({ searchParams: Promise.resolve({ typ: 'svatba', osob: '80', zdroj: '/catering/svatby' }) }))
    expectBasics(doc)
    const t = text(doc)
    const page = getPage('/poptavka')
    for (const s of page.sections.filter((x) => x.id !== 'formular')) {
      expect(t).toContain(norm(s.heading))
      if (s.id !== 'volba') expect(t).toContain(norm(s.body))
    }
    for (const raw of page.sections.find((s) => s.id === 'co-bude-dal')!.items!) expect(t).toContain(norm(parseItem(raw).text))
    expect(doc.querySelector('h1')!.textContent).toBe('Řekněte nám o své akci')
    expect(t).toContain('Máme předvyplněno: Svatba, 80 osob. Můžete to změnit.')
    // začíná krokem 3 (Datum a čas), protože typ a počet osob už známe
    expect(doc.getElementById('pop-krok-datum')).not.toBeNull()
    expect(doc.querySelector('#pop-datum')!.getAttribute('min')).toBe(isoDate())
    // zástupci jsou vidět jako odznak
    expect(doc.querySelectorAll('.md-fill').length).toBeGreaterThan(0)
    // honeypot je skrytý pro čtečky i klávesnici
    const hp = doc.getElementById('pop-web')!
    expect(hp.getAttribute('tabindex')).toBe('-1')
    expect(hp.closest('[aria-hidden="true"]')).not.toBeNull()
    expect(jsonLd(doc).some((l) => l['@type'] === 'BreadcrumbList')).toBe(true)
  })

  it('bez parametrů začíná typem akce se všemi možnostmi z mikrotextu', async () => {
    const doc = render(await InquiryPage({ searchParams: Promise.resolve({}) }))
    expectBasics(doc)
    const legend = norm(doc.querySelector('#pop-typ legend')?.textContent)
    expect(legend).toContain(microcopy('POPTÁVKA — pole Typ akce'))
    const labels = Array.from(doc.querySelectorAll('#pop-typ label')).map((l) => norm(l.querySelector('span span')?.textContent))
    expect(labels).toEqual(microcopy('POPTÁVKA — možnosti typu akce').split(' · '))
    expect(text(doc)).not.toContain('Máme předvyplněno')
  })
})

// ── průvodce interaktivně ───────────────────────────────────────────────────

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

async function mount(node: ReactNode) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => root.render(node))
}
function setValue(el: Element | null, value: string) {
  if (!el) throw new Error('pole nenalezeno')
  const input = el as HTMLInputElement
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}
const type = (el: Element | null, v: string) => act(async () => setValue(el, v))
async function click(el: Element | null) {
  if (!el) throw new Error('prvek nenalezen')
  await act(async () => (el as HTMLElement).click())
}
const wait = (ms: number) => act(() => new Promise<void>((r) => setTimeout(r, ms)))
const $ = (sel: string) => container.querySelector(sel)
const submitForm = () => act(async () => void $('form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })))
const heading = () => norm($('form h2')?.textContent)

describe('průvodce poptávkou (interakce)', () => {
  const labels = wizardLabels()
  beforeEach(() => {
    push.mockReset()
    window.sessionStorage.clear()
  })
  afterEach(async () => {
    await act(async () => root.unmount())
    container.remove()
  })

  it('projde všech 7 kroků, ukáže orientační cenu, odešle a přesměruje na potvrzení', async () => {
    await mount(<InquiryWizard labels={labels} prefill={{ prefilled: [], source: { channel: 'formular', page: null, ref: null } }} today={TODAY} />)
    expect(heading()).toBe(microcopy('POPTÁVKA — nadpis kroku 1'))

    // krok 1 bez výběru → chyba u typu akce, fokus zůstává v kroku
    await submitForm()
    expect(norm($('#pop-typ')?.textContent)).toContain(MESSAGES.required)
    expect($('#pop-typ')!.getAttribute('aria-invalid')).toBe('true')
    await click($('#pop-typ-coffee-break'))
    expect($('#pop-typ')!.getAttribute('aria-invalid')).toBeNull()
    await submitForm()

    // krok 2: pod minimem → hláška s minimem; pak orientační cena s rozpětím
    expect(heading()).toBe('Počet osob')
    await type($('#pop-osob'), '10')
    await submitForm()
    expect(norm($('#pop-osob')?.parentElement?.textContent)).toContain(MESSAGES.belowMinimum(15))
    await type($('#pop-osob'), '20')
    await wait(260)
    const estimate = norm(container.querySelector('aside')?.textContent)
    expect(estimate).toContain('Orientačně')
    expect(estimate).toMatch(/300–2\s000\sKč\/os\./)
    expect(estimate).toMatch(/Pro 20 osob zhruba 6\s000–40\s000\sKč/)
    await submitForm()

    // krok 3 datum (nepovinné) → krok 4 místo
    expect(heading()).toBe('Datum a čas')
    await type($('#pop-datum'), '2026-12-10')
    await submitForm()
    expect(heading()).toBe('Místo')
    await submitForm()
    expect(norm($('#pop-adresa')?.parentElement?.textContent)).toContain(MESSAGES.required)
    await click($('#pop-prostor'))
    await submitForm()

    // krok 5 styl a dieta (vše nepovinné)
    expect(heading()).toBe('Formát servisu')
    await click($('#pop-format-bufet'))
    await click($('#pop-diety-bezlepkove'))
    await type($('#pop-diety-pocty'), '3× bezlepkové')
    await submitForm()

    // krok 6 kontakt + segment; firma ukáže IČO
    expect(heading()).toBe(microcopy('POPTÁVKA — nadpis kroku Kontakt'))
    expect($('#pop-ico')).toBeNull()
    await click($('#pop-segment-firma'))
    expect($('label[for="pop-ico"]')?.textContent).toContain(microcopy('POPTÁVKA — pole IČO'))
    await type($('#pop-ico'), '123')
    await type($('#pop-jmeno'), 'Jana Nováková')
    await type($('#pop-email'), 'jana@firma.cz')
    await type($('#pop-telefon'), '+420 737 000 000')
    await submitForm()
    expect(norm($('#pop-ico')?.parentElement?.textContent)).toContain(MESSAGES.ico)
    expect(document.activeElement?.id).toBe('pop-ico')
    await type($('#pop-ico'), '12345678')
    await submitForm()

    // krok 7 souhrn: hodnoty, souhlas, odeslání
    expect(heading()).toBe('Souhrn')
    const summary = norm($('dl')?.textContent)
    for (const v of ['Coffee break', '20', '10. 12. 2026', microcopy('POPTÁVKA — zaškrtávátko'), 'Bufet', 'Bezlepkové · 3× bezlepkové', 'Za firmu', 'jana@firma.cz']) {
      expect(summary).toContain(norm(v))
    }
    await submitForm()
    expect(norm($('#pop-souhlas')?.closest('div')?.parentElement?.textContent)).toContain(MESSAGES.consent)
    expect(push).not.toHaveBeenCalled()
    await click($('#pop-souhlas'))
    expect($('button[type=submit]')!.textContent).toContain(microcopy('POPTÁVKA — tlačítko odeslat'))
    await submitForm()
    await wait(10)

    // Server (P6) rozhoduje stejně jako agent: dieta bez počtu porcí do mapy
    // nepasuje → poptávku vyřídí člověk („na míru").
    expect(push).toHaveBeenCalledWith('/poptavka/odeslano?vysledek=na-miru')
    const stored = JSON.parse(window.sessionStorage.getItem(CONFIRMATION_STORAGE_KEY)!)
    expect(stored).toMatchObject({ outcome: 'na-miru', email: 'jana@firma.cz', guests: 20, estimate: { od: 300, do: 2000, binding: false } })
    expect(window.sessionStorage.getItem(DRAFT_STORAGE_KEY)).toBeNull()
  })

  it('honeypot: vyplněné skryté pole nic neodešle', async () => {
    const p = parseInquiryParams({ typ: 'oslava', osob: '6', datum: '2026-12-01' })
    await mount(<InquiryWizard labels={labels} prefill={p} today={TODAY} />)
    expect(heading()).toBe('Místo')
    await type($('#pop-adresa'), 'Praha 2')
    await submitForm()
    await submitForm()
    await click($('#pop-segment-soukrome'))
    await type($('#pop-jmeno'), 'Robot')
    await type($('#pop-email'), 'bot@spam.cz')
    await type($('#pop-telefon'), '+420 777 000 000')
    await submitForm()
    await click($('#pop-souhlas'))
    ;($('#pop-web') as HTMLInputElement).value = 'http://spam.example'
    await submitForm()
    expect(push).toHaveBeenCalledWith('/poptavka/odeslano?vysledek=ceka-na-cenik')
    expect(window.sessionStorage.getItem(CONFIRMATION_STORAGE_KEY)).toBeNull()
  })

  it('volba asistenta: úvodní zpráva a rychlé volby pokračují průvodcem', async () => {
    await mount(<InquiryWizard labels={labels} prefill={{ prefilled: [] }} today={TODAY} />)
    const [assistant] = Array.from(container.querySelectorAll('button[aria-pressed]'))
    expect(norm(assistant.textContent)).toContain('Napsat asistentovi')
    await click(assistant)
    expect(assistant.getAttribute('aria-pressed')).toBe('true')
    expect(norm($('#pop-asistent')?.textContent)).toContain(microcopy('ASISTENT — úvodní zpráva'))
    const svatba = Array.from(container.querySelectorAll('#pop-asistent button')).find((b) => b.textContent === 'Svatba')
    await click(svatba!)
    expect(heading()).toBe('Počet osob')
    expect(($('input[name=typ]:checked') ?? null)).toBeNull()
  })

  it('rozpracovaná poptávka přežije obnovení stránky', async () => {
    await mount(<InquiryWizard labels={labels} prefill={{ prefilled: [] }} today={TODAY} />)
    await click($('#pop-typ-teambuilding'))
    await submitForm()
    await type($('#pop-osob'), '12')
    await act(async () => root.unmount())
    container.remove()
    await mount(<InquiryWizard labels={labels} prefill={{ prefilled: [] }} today={TODAY} />)
    expect(heading()).toBe('Počet osob')
    expect(($('#pop-osob') as HTMLInputElement).value).toBe('12')
  })
})

// ── potvrzení ───────────────────────────────────────────────────────────────

describe('/poptavka/odeslano', () => {
  it.each(['standard', 'na-miru', 'ceka-na-cenik', 'konzultace'] as const)('výsledek %s: texty z mikrotextů POTVRZENÍ', async (outcome) => {
    const doc = render(await ConfirmationPage({ searchParams: Promise.resolve({ vysledek: outcome }) }))
    expectBasics(doc)
    const c = confirmationCopy(outcome)
    expect(norm(doc.querySelector('h1')?.textContent)).toBe(c.heading)
    const t = text(doc)
    expect(t).toContain(microcopy('POTVRZENÍ — další krok'))
    expect(t).not.toContain('[Použít')
    if (outcome === 'standard') expect(t).toContain(withResponseClaim('Nabídku s cenou vám pošleme na váš e-mail do pár minut.'))
    if (outcome === 'na-miru') expect(doc.querySelector('.md-fill')?.textContent).toBe('[DOPLNÍ KLIENT: potvrdit lhůtu]')
    if (outcome === 'ceka-na-cenik') expect(t).toContain('Nabídku připravujeme a pošleme vám ji co nejdřív, obvykle ještě týž pracovní den.')
    if (outcome === 'konzultace') expect(c.heading).toBe('Děkujeme!')
  })

  it('neznámý výsledek = varianta do schválení ceníku', async () => {
    const doc = render(await ConfirmationPage({ searchParams: Promise.resolve({ vysledek: '<script>' }) }))
    expect(norm(doc.querySelector('h1')?.textContent)).toBe('Děkujeme, poptávku máme!')
  })
})

// ── časté dotazy ────────────────────────────────────────────────────────────

describe('/caste-dotazy', () => {
  const doc = render(<FaqPage />)
  const t = text(doc)

  it('všechny sekce a položky doslova, zástupci viditelní', () => {
    expectBasics(doc)
    for (const s of getPage('/caste-dotazy').sections) {
      expect(t).toContain(norm(s.heading))
      if (s.body) expect(t).toContain(norm(s.body))
      for (const raw of s.items ?? []) for (const part of raw.split(' — ')) expect(t).toContain(norm(part))
      if (s.cta) expect(t).toContain(parseCta(s.cta).label)
    }
    expect(doc.querySelectorAll('details').length).toBe(faqGroups().groups.flatMap((g) => g.questions).length)
    expect(doc.querySelectorAll('.md-fill').length).toBeGreaterThan(5)
    expect(doc.querySelector('a[href="/poptavka?zdroj=%2Fcaste-dotazy#asistent"]')).not.toBeNull()
  })

  it('jedna FAQPage bez otázek se zástupci + drobečky', () => {
    const lds = jsonLd(doc)
    const faq = lds.filter((l) => l['@type'] === 'FAQPage')
    expect(faq).toHaveLength(1)
    const entities = faq[0].mainEntity as { name: string; acceptedAnswer: { text: string } }[]
    expect(entities.length).toBeGreaterThan(5)
    expect(JSON.stringify(entities)).not.toContain('DOPLNÍ')
    expect(entities.map((e) => e.name)).toContain('Kolik stojí catering na osobu?')
    expect(lds.some((l) => l['@type'] === 'BreadcrumbList')).toBe(true)
  })
})

// ── právní stránky ──────────────────────────────────────────────────────────

describe('právní stránky', () => {
  it.each([
    ['/obchodni-podminky', TermsPage],
    ['/ochrana-osobnich-udaju', PrivacyPage],
    ['/cookies', CookiesPage],
  ] as const)('%s: šablona doslova, zástupci [DOPLNÍ …] jako odznak', (path, Page) => {
    const doc = render(<Page />)
    expectBasics(doc)
    const t = text(doc)
    const { title } = legalPageCopy(path)
    expect(norm(doc.querySelector('h1')?.textContent)).toBe(title)
    for (const s of getPage(path).sections) {
      expect(t).toContain(norm(s.heading))
      expect(t).toContain(norm(s.body))
      for (const m of s.body.match(/\[DOPLNÍ[^\]]*\]/g) ?? []) {
        expect(Array.from(doc.querySelectorAll('.md-fill')).map((e) => e.textContent)).toContain(m)
      }
    }
  })

  it('/cookies má tlačítko Nastavit cookies, které vyšle událost pro lištu', async () => {
    const doc = render(<CookiesPage />)
    const btn = Array.from(doc.querySelectorAll('button')).find((b) => b.textContent === 'Nastavit cookies')
    expect(btn).toBeDefined()
    expect(doc.querySelectorAll('h1')).toHaveLength(1)
    expect(norm(doc.querySelector('h1')?.textContent)).toBe('Cookies')
  })
})

// ── 404, sitemap, robots, přesměrování ──────────────────────────────────────

describe('404', () => {
  it('nadpis, text a tlačítka z mikrotextů 404', () => {
    const doc = render(<WebNotFound />)
    expectBasics(doc)
    expect(norm(doc.querySelector('h1')?.textContent)).toBe(microcopy('404 — nadpis'))
    const t = text(doc)
    expect(t).toContain(microcopy('404 — text'))
    expect(doc.querySelector('a[href="/"]')?.textContent).toBe('Na úvod')
    expect(norm(doc.querySelector('a[href="/poptavka"]')?.textContent)).toBe('Chci nabídku')
  })

  it('neznámá adresa vyvolá notFound()', () => {
    expect(() => UnknownPage()).toThrow('NEXT_NOT_FOUND')
  })
})

describe('sitemap.xml a robots.txt', () => {
  const urls = sitemap().map((e) => e.url)
  it('veřejné stránky ano, košík, Cockpit, /en a šablony ne', () => {
    expect(urls).toContain('https://www.mummiesdaddies.com')
    for (const p of ['/poptavka', '/catering/svatby', '/caste-dotazy', '/cheesecaky/daddy-vanilkovy', '/reference/svatba-katka-a-jirka', '/obchodni-podminky']) {
      expect(urls).toContain(`https://www.mummiesdaddies.com${p}`)
    }
    for (const a of BLOG_ARTICLES) expect(urls).toContain(`https://www.mummiesdaddies.com/blog/${a.slug}`)
    for (const bad of ['/kosik', '/cockpit', '/en', '[slug]', '/poptavka/odeslano']) expect(urls.some((u) => u.includes(bad))).toBe(false)
    expect(new Set(urls).size).toBe(urls.length)
  })
  it('robots odkazuje na sitemapu a zakazuje košík a potvrzení', () => {
    const r = robots()
    expect(r.sitemap).toBe('https://www.mummiesdaddies.com/sitemap.xml')
    expect(JSON.stringify(r.rules)).toContain('/poptavka/odeslano')
  })
})

describe('přesměrování starých URL (strategy.redirects)', () => {
  const all = legacyRedirectConfig()
  const generic = all.filter((r) => !r.has)
  const to = (source: string) => generic.find((r) => r.source === source)?.destination

  it('mapa cest podle strategie', () => {
    expect(to('/wedding')).toBe('/catering/svatby')
    expect(to('/home')).toBe('/')
    expect(to('/book-online')).toBe('/poptavka?typ=konzultace')
    expect(to('/product-page/cheesecake')).toBe('/cheesecaky/mini-cheesecaky-10-ks')
    expect(to('/privacy-policy')).toBe('/ochrana-osobnich-udaju')
    // BVLGARI jen po schválení klientem → zatím /reference
    expect(to('/single-project')).toBe('/reference')
    // kategorie blogu i účty jako celé podcesty
    expect(to('/blog/categories/:path*')).toBe('/blog')
    expect(to('/account/:path*')).toBe('/')
    expect(to('/members')).toBe('/')
    expect(to('/plans-pricing')).toBe('/')
    // existující článek zůstává, chybějící článek → /blog
    expect(to('/post/svatba-catering')).toBe('/blog/jak-vybrat-svatebni-catering')
    expect(to('/post/1-narozeniny-1')).toBe('/blog')
  })

  it('adresy s diakritikou v původní i procentové podobě', () => {
    expect(to('/post/vánoce-vánoce-přicházejí')).toBe('/vanoce')
    expect(to(`/post/${encodeURIComponent('vánoce-vánoce-přicházejí')}`)).toBe('/vanoce')
  })

  it('stará subdoména cs. → www (známé cesty jedním skokem)', () => {
    const cs = all.filter((r) => r.has?.[0].value === 'cs.mummiesdaddies.com')
    expect(cs.find((r) => r.source === '/wedding')?.destination).toBe('https://www.mummiesdaddies.com/catering/svatby')
    expect(cs.at(-1)).toEqual({ source: '/:path*', destination: 'https://www.mummiesdaddies.com/:path*', permanent: true, has: [{ type: 'host', value: 'cs.mummiesdaddies.com' }] })
  })

  it('každý cíl na webu existuje, žádná smyčka ani duplicita', () => {
    for (const r of generic) {
      expect(KNOWN_PATHS.has(r.destination.split('?')[0]), r.destination).toBe(true)
      expect(r.source).not.toBe(r.destination)
    }
    expect(new Set(generic.map((r) => r.source)).size).toBe(generic.length)
    expect(parseRedirectLines(['popis bez adresy → /blog', '/a (poznámka) → /b'])).toEqual([{ from: '/a', to: '/b' }])
  })
})

describe('Product na detailu cheesecaku', () => {
  it('potvrzená cena v Offer, nepotvrzená cena bez Offer', async () => {
    const ok = render(await CheesecakePage({ params: Promise.resolve({ slug: 'daddy-vanilkovy' }) }))
    const product = jsonLd(ok).find((l) => l['@type'] === 'Product') as Record<string, unknown> & { offers?: { price: string; priceCurrency: string } }
    expect(product).toMatchObject({ name: 'Daddy vanilkový', url: 'https://www.mummiesdaddies.com/cheesecaky/daddy-vanilkovy' })
    expect(product.offers).toMatchObject({ price: '790', priceCurrency: 'CZK' })
    expect(JSON.stringify(product)).not.toContain('DOPLNÍ')

    const unconfirmed = render(await CheesecakePage({ params: Promise.resolve({ slug: 'daddy-vanilkovo-karamelovy' }) }))
    const p2 = jsonLd(unconfirmed).find((l) => l['@type'] === 'Product')!
    expect(p2.offers).toBeUndefined()
  })
})
