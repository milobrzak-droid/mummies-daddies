import { describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

// Next komponenty mimo běžící aplikaci (router, optimalizace obrázků) nahradíme prostým HTML.
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => <a href={href} {...rest}>{children}</a>,
}))
vi.mock('next/form', () => ({
  default: ({ action, children, ...rest }: { action: string; children: ReactNode }) => (
    <form action={action} method="get" {...rest}>
      {children}
    </form>
  ),
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
vi.mock('next/navigation', () => ({ usePathname: () => '/' }))

import HomePage from '@/app/(web)/page'
import ContactPage from '@/app/(web)/kontakt/page'
import {
  contactLine,
  keepTogether,
  lastSegment,
  splitEventCardText,
  splitProduct,
  splitStepNumber,
} from '@/components/web/uvod/copy-helpers'
import { withResponseClaim } from '@/lib/web/claims'
import { allPages, getPage, getSection } from '@/lib/web/content'
import { parseInquiryParams } from '@/lib/web/inquiry-link'

function render(node: ReactNode): Document {
  const html = renderToStaticMarkup(node)
  const doc = document.implementation.createHTMLDocument('t')
  doc.body.innerHTML = html
  return doc
}

const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
const KNOWN_PATHS = new Set(allPages().map((p) => p.path))

/** Interní odkaz vede na stránku z mapy webu (nebo /poptavka s parametry). */
function expectKnownLinks(doc: Document) {
  for (const a of Array.from(doc.querySelectorAll('a[href]'))) {
    const href = a.getAttribute('href')!
    if (/^(tel:|mailto:|https:)/.test(href) || href.startsWith('#')) continue
    const path = href.split(/[?#]/)[0]
    expect(KNOWN_PATHS.has(path), `neznámá cesta ${href}`).toBe(true)
  }
}

function expectAccessibleBasics(doc: Document) {
  // přesně jeden h1
  expect(doc.querySelectorAll('h1')).toHaveLength(1)
  // unikátní id
  const ids = Array.from(doc.querySelectorAll('[id]')).map((e) => e.id)
  expect(new Set(ids).size, `duplicitní id: ${ids.filter((x, i) => ids.indexOf(x) !== i)}`).toBe(ids.length)
  // aria-labelledby míří na existující nadpis
  for (const el of Array.from(doc.querySelectorAll('[aria-labelledby]'))) {
    expect(doc.getElementById(el.getAttribute('aria-labelledby')!), el.getAttribute('aria-labelledby')!).not.toBeNull()
  }
  // každý obrázek má alt (prázdný jen čistě dekorativní výřez uvnitř aria-hidden), každé pole formuláře popisek
  for (const img of Array.from(doc.querySelectorAll('img'))) {
    if (img.closest('[aria-hidden="true"]')) expect(img.getAttribute('alt')).toBe('')
    else expect((img.getAttribute('alt') ?? '').length, img.getAttribute('src') ?? '').toBeGreaterThan(0)
  }
  for (const f of Array.from(doc.querySelectorAll('input:not([type=hidden]), select, textarea'))) {
    expect(doc.querySelector(`label[for="${f.id}"]`), `pole ${f.getAttribute('name')} bez popisku`).not.toBeNull()
  }
  // odkazy mají přístupný text
  for (const a of Array.from(doc.querySelectorAll('a'))) expect(text(a).length + (a.getAttribute('aria-label')?.length ?? 0)).toBeGreaterThan(0)
}

describe('úvodní stránka', () => {
  const doc = render(<HomePage />)
  const body = text(doc.body)

  it('má hero s H1 a CTA na poptávku s kontextem', () => {
    const h1 = doc.querySelector('h1')!
    expect(text(h1)).toBe(getSection('/', 'hero').heading)
    const primary = Array.from(doc.querySelectorAll('a')).find((a) => text(a) === withResponseClaim('Chci nabídku do pár minut'))!
    expect(primary.getAttribute('href')).toBe('/poptavka?zdroj=%2F')
    expect(doc.querySelector('a[href="/catering"]')).not.toBeNull()
    expect(body).toContain('Vaříme od roku 2018')
  })

  it('vykreslí sekce v pořadí webu v2 (docs/web-v2-design.md §6) a texty doslova z copy', () => {
    // v2: za typy akcí přibyly „Formáty“ a obří pruh (bez nadpisu, aria-label), cheesecaky jsou před prostory.
    const ids = ['rychly-start', 'typy-akci', 'proc-my', 'reference', 'z-kuchyne', 'jak-to-funguje', 'cheesecaky', 'prostory', 'tym', 'faq', 'zaverecna-poptavka']
    const h2 = Array.from(doc.querySelectorAll('h2')).map(text)
    const expected = ids.map((id) => getSection('/', id).heading)
    expected.splice(2, 0, 'Vyberte si formát')
    expect(h2).toEqual(expected)
    expect(doc.querySelector('section[aria-label="Catering a cheesecaky"]')).not.toBeNull()
    for (const id of ids) {
      const s = getSection('/', id)
      if (s.body && !s.body.includes('[DOPLNÍ KLIENT')) expect(body).toContain(s.body)
    }
  })

  it('rychlý start = GET formulář na /poptavka, jehož pole přečte parseInquiryParams', () => {
    const form = doc.querySelector('form')!
    expect(form.getAttribute('action')).toBe('/poptavka')
    const names = Array.from(form.querySelectorAll('[name]')).map((e) => e.getAttribute('name'))
    expect(names).toEqual(['zdroj', 'typ', 'datum', 'osob'])
    const options = Array.from(form.querySelectorAll('select option')).map(text)
    expect(options).toEqual(['Vyberte…', 'Firemní catering', 'Snídaně', 'Coffee break', 'Oběd', 'Večeře a banket', 'Společenská akce', 'Teambuilding', 'Svatba', 'Oslava a piknik', 'Ještě nevím'])
    expect(text(form.querySelector('button[type=submit]'))).toBe('Spočítat nabídku')
    const parsed = parseInquiryParams(new URLSearchParams('zdroj=%2F&typ=svatba&datum=2027-06-12&osob=80'))
    expect(parsed).toMatchObject({ eventType: 'svatba', eventDate: '2027-06-12', guests: 80, source: { page: '/' } })
  })

  it('řada kategorií: 3 klíčové typy akcí s fotkou, cenou se zástupcem a minimem osob + odkaz na všechny', () => {
    const grid = doc.getElementById('typy-akci')!
    const cards = Array.from(grid.querySelectorAll('article'))
    expect(cards).toHaveLength(3)
    expect(cards.map((c) => c.querySelector('h3 a')?.getAttribute('href'))).toEqual(['/catering/firemni', '/catering/svatby', '/catering/oslavy-a-piknik'])
    for (const c of cards) {
      expect(c.querySelector('img, [role=img]')).not.toBeNull()
      expect(c.querySelector('.md-fill'), 'cena bez zástupce').not.toBeNull()
    }
    expect(text(cards[0])).toContain('od 4 osob')
    expect(grid.querySelector('a[href="/catering"]')?.textContent).toContain('Všechny typy akcí (9)')
    // žádná vymyšlená cena v mřížce: jediné „Kč“ jsou zástupci „Od [DOPLNÍ KLIENT] Kč/os.“
    expect(text(grid).match(/\d[\d\s]*Kč/g)).toBeNull()
    expect(grid.querySelector('a[href="/poptavka?typ=nevim&zdroj=%2F"]')).not.toBeNull()
  })

  it('reference, cheesecaky a závěr nesou správné odkazy a ověřené ceny', () => {
    for (const href of ['/reference/bvlgari-luxury-party', '/reference/svatba-jitka-a-rostislav', '/reference/svatba-katka-a-jirka', '/reference']) {
      expect(doc.querySelector(`#reference a[href="${href}"]`), href).not.toBeNull()
    }
    const cakes = text(doc.getElementById('cheesecaky'))
    expect(cakes).toContain('790 Kč')
    expect(cakes).toContain('1 290 Kč')
    expect(cakes).toContain('575 Kč')
    expect(doc.querySelector('#cheesecaky a[href="/cheesecaky"]')).not.toBeNull()
    expect(doc.querySelector('#cheesecaky a[href="/poptavka?zdroj=%2F&doplnek=sladky-bar"]')).not.toBeNull()
    const final = doc.getElementById('zaverecna-poptavka')!
    expect(final.querySelector('a[href="tel:+420737818694"]')).not.toBeNull()
    expect(final.querySelector('a[href="mailto:info@mummiesdaddies.com"]')).not.toBeNull()
    expect(final.querySelector('a[href="/poptavka?typ=svatba&zdroj=%2F"]')).not.toBeNull()
    expect(text(final)).toContain('Dobrý den, jsem digitální asistent Mummies & Daddies.')
  })

  it('jak to funguje = seřazený seznam 4 kroků, FAQ jako <details>', () => {
    const steps = doc.querySelectorAll('#jak-to-funguje ol > li')
    expect(steps).toHaveLength(4)
    expect(text(steps[0].querySelector('h3'))).toBe('Řeknete nám o akci')
    expect(doc.querySelectorAll('#faq details')).toHaveLength(5)
  })

  it('zástupci [DOPLNÍ KLIENT] zůstávají viditelní, nic se nevymýšlí', () => {
    expect(doc.querySelectorAll('.md-fill').length).toBeGreaterThanOrEqual(12)
    expect(body).not.toContain('stovky akcí')
  })

  it('strukturovaná data: FAQPage a Product cheesecaků', () => {
    const ld = Array.from(doc.querySelectorAll('script[type="application/ld+json"]')).map((s) => JSON.parse(s.textContent!))
    expect(ld.some((x) => x['@type'] === 'FAQPage')).toBe(true)
    const list = ld.find((x) => x['@type'] === 'ItemList')
    expect(list.itemListElement.map((i: { item: { name: string; offers: { price: string } } }) => [i.item.name, i.item.offers.price])).toEqual([
      ['Daddy vanilkový', '790'],
      ['Daddy pistáciovo-malinový', '1290'],
      ['Mini cheesecaky mix, 10 ks', '575'],
    ])
  })

  it('přístupnost a odkazy jen na stránky z mapy webu', () => {
    expectAccessibleBasics(doc)
    expectKnownLinks(doc)
  })
})

describe('/kontakt', () => {
  const doc = render(<ContactPage />)
  const body = text(doc.body)

  it('lidé s klikacími telefony a e-maily, role Moniky jako zástupce', () => {
    expect(text(doc.querySelector('h1'))).toBe('Ozvěte se nám')
    for (const href of ['tel:+420737818694', 'tel:+420737301679', 'mailto:info@mummiesdaddies.com', 'mailto:rudolf.nikolai@mummiesdaddies.com']) {
      expect(doc.querySelector(`a[href="${href}"]`), href).not.toBeNull()
    }
    expect(body).toContain('majitel a šéfkuchař')
    expect(Array.from(doc.querySelectorAll('.md-fill')).map(text)).toContain('[DOPLNÍ KLIENT: role]')
  })

  it('Zavolat / Poptat, rychlá poptávka se zdrojem /kontakt', () => {
    const links = Array.from(doc.querySelectorAll('a'))
    expect(links.find((a) => text(a) === 'Zavolat')?.getAttribute('href')).toBe('tel:+420737818694')
    expect(links.find((a) => text(a) === 'Poptat')?.getAttribute('href')).toBe('/poptavka?zdroj=%2Fkontakt')
    const form = doc.querySelector('form')!
    expect(form.getAttribute('action')).toBe('/poptavka')
    expect(form.querySelector('input[name=zdroj]')?.getAttribute('value')).toBe('/kontakt')
    expect(text(form.querySelector('button[type=submit]'))).toBe('Chci nabídku')
  })

  it('fakturační údaje, provozovna a sítě doslova z copy', () => {
    for (const line of getSection('/kontakt', 'fakturace').items!) expect(body).toContain(line)
    expect(body).toContain('[DOPLNÍ KLIENT: adresa kuchyně a výdejního místa, otevírací doba]')
    expect(doc.querySelector('a[href="https://www.instagram.com/mummiesdaddies1/"]')).not.toBeNull()
    expect(doc.querySelector('a[href="https://www.instagram.com/mummiesdaddies.catering/"]')).not.toBeNull()
    expect(doc.querySelector('a[href="https://www.facebook.com/mummiesdaddies2"]')).not.toBeNull()
    // LinkedIn klient nedodal → žádný odkaz, jen zástupce
    expect(Array.from(doc.querySelectorAll('a')).some((a) => /linkedin/i.test(a.getAttribute('href') ?? ''))).toBe(false)
    expect(body).toContain('[DOPLNÍ KLIENT: odkaz]')
  })

  it('přístupnost a odkazy jen na stránky z mapy webu', () => {
    expectAccessibleBasics(doc)
    expectKnownLinks(doc)
    expect(getPage('/kontakt').metaTitle).toContain('Kontakt')
  })
})

describe('copy-helpers', () => {
  it('splitEventCardText', () => {
    expect(splitEventCardText('Obědy do kanceláře, porady, konference i večírky. Od [DOPLNÍ KLIENT] Kč/os. · od 4 osob')).toEqual({
      description: 'Obědy do kanceláře, porady, konference i večírky.',
      price: 'Od [DOPLNÍ KLIENT] Kč/os.',
      minimum: 'od 4 osob',
    })
    expect(splitEventCardText('Svatební hostina podle vašeho příběhu. Konzultace zdarma. Od [DOPLNÍ KLIENT] Kč/os.')).toEqual({
      description: 'Svatební hostina podle vašeho příběhu. Konzultace zdarma.',
      price: 'Od [DOPLNÍ KLIENT] Kč/os.',
      minimum: null,
    })
    expect(splitEventCardText('Jen popis · od 2 osob')).toEqual({ description: 'Jen popis', price: null, minimum: 'od 2 osob' })
  })

  it('splitProduct, splitStepNumber, lastSegment, keepTogether', () => {
    expect(splitProduct('Daddy vanilkový — vanilka a máslové sušenky · 790 Kč')).toEqual({ name: 'Daddy vanilkový', note: 'vanilka a máslové sušenky', price: '790 Kč' })
    expect(splitProduct('Mini cheesecaky mix, 10 ks · 575 Kč')).toEqual({ name: 'Mini cheesecaky mix, 10 ks', note: null, price: '575 Kč' })
    expect(splitStepNumber('2. Dostanete nabídku')).toEqual({ n: 2, title: 'Dostanete nabídku' })
    expect(splitStepNumber('Bez čísla')).toEqual({ n: null, title: 'Bez čísla' })
    expect(lastSegment('/catering/firemni/')).toBe('firemni')
    expect(lastSegment(null)).toBeNull()
    expect(keepTogether('1 290 Kč')).toBe('1 290 Kč')
  })

  it('contactLine', () => {
    expect(contactLine('+420 737 301 679')).toEqual({ kind: 'phone', text: '+420 737 301 679', href: 'tel:+420737301679' })
    expect(contactLine('info@mummiesdaddies.com')).toMatchObject({ kind: 'email', href: 'mailto:info@mummiesdaddies.com' })
    expect(contactLine('majitel a šéfkuchař')).toEqual({ kind: 'text', text: 'majitel a šéfkuchař' })
  })
})
