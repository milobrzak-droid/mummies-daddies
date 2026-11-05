import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { CATERING_SLUGS, CATERING_TYPES, type CateringSlug } from '@/lib/web/catering'
import { getPage, parseItem, stripPlaceholders, type SectionCopy } from '@/lib/web/content'
import { contextHref, splitCtas, splitInternalLinks, splitPriceFacts, splitStepNumber } from '@/components/web/catering/parse'

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

const { CateringTypePage, CateringOverview } = await import('@/components/web/catering')

function render(node: ReactNode) {
  const html = renderToStaticMarkup(node)
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, 'text/html')
  const text = (doc.body.textContent ?? '').replace(/\s+/g, ' ')
  return { html, doc, text }
}

const norm = (s: string) => s.replace(/\s+/g, ' ').trim()

/** Každá část textu sekce musí být na stránce doslova (cena/minimum se jen přesunou do štítků). */
function expectSectionVerbatim(text: string, s: SectionCopy, opts: { skipBody?: boolean } = {}) {
  expect(text).toContain(norm(s.heading))
  if (s.body && !opts.skipBody) expectVerbatim(text, s.body)
  for (const raw of s.items ?? []) {
    const it = parseItem(raw)
    if (it.title) expect(text).toContain(norm(it.title.replace(/^\d+\.\s+/, '')))
    if (it.label) expect(text).toContain(norm(it.label))
    expectVerbatim(text, it.text)
  }
}

/** Text doslova; když ho stránka rozdělila (cena a minimum do štítků), pak každá část doslova. */
function pieces(t: string): string[] {
  const f = splitPriceFacts(t)
  return [f.price, f.guests, f.rest].filter((x): x is string => !!x).map(norm)
}

/** Jak text z copy čte návštěvník: zápis odkazu „[text](/cesta)“ se ukáže jen jako text odkazu. */
const readable = (t: string) => splitInternalLinks(t).map((p) => p.text).join('')

function expectVerbatim(text: string, raw: string) {
  const t = readable(raw)
  if (text.includes(norm(t))) return
  for (const part of pieces(t)) expect(text).toContain(part)
}

function links(doc: Document) {
  return [...doc.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')!)
}

describe('catering: pomocné funkce', () => {
  it('splitPriceFacts vytáhne cenu a minimum, zbytek nechá doslova', () => {
    expect(splitPriceFacts('od 4 osob · od [DOPLNÍ KLIENT] Kč/os. Čerstvé sendviče a wrapy.')).toEqual({
      guests: 'od 4 osob',
      price: 'od [DOPLNÍ KLIENT] Kč/os.',
      rest: 'Čerstvé sendviče a wrapy.',
    })
    expect(splitPriceFacts('Krátká přestávka na 15 až 45 minut. Od 15 osob · od [DOPLNÍ KLIENT] Kč/os.')).toEqual({
      guests: 'Od 15 osob',
      price: 'od [DOPLNÍ KLIENT] Kč/os.',
      rest: 'Krátká přestávka na 15 až 45 minut.',
    })
    expect(splitPriceFacts('8 až 30 osob · od [DOPLNÍ KLIENT] Kč/os. Velké mísy.')).toMatchObject({ guests: '8 až 30 osob', rest: 'Velké mísy.' })
    expect(splitPriceFacts('od [DOPLNÍ KLIENT] Kč/os. · minimum [DOPLNÍ KLIENT]')).toEqual({ price: 'od [DOPLNÍ KLIENT] Kč/os.', guests: 'minimum [DOPLNÍ KLIENT]', rest: '' })
    expect(splitPriceFacts('Ovoce a smoothie. Od [DOPLNÍ KLIENT] Kč/os.')).toEqual({ price: 'Od [DOPLNÍ KLIENT] Kč/os.', guests: null, rest: 'Ovoce a smoothie.' })
    expect(splitPriceFacts('Bez ceny · s tečkou.')).toEqual({ price: null, guests: null, rest: 'Bez ceny · s tečkou.' })
  })

  it('contextHref doplní typ a zdroj, hodnoty z copy mají přednost', () => {
    expect(contextHref('/poptavka?segment=firma', { typ: 'firemni', zdroj: '/catering/firemni' })).toBe('/poptavka?typ=firemni&segment=firma&zdroj=%2Fcatering%2Ffiremni')
    expect(contextHref('/poptavka?typ=konzultace', { typ: 'svatba', zdroj: '/catering/svatby' })).toBe('/poptavka?typ=konzultace&zdroj=%2Fcatering%2Fsvatby')
    expect(contextHref('/poptavka?segment=firma&zdroj=/catering/firemni', { typ: 'firemni', zdroj: '/x' })).toContain('zdroj=%2Fcatering%2Ffiremni')
    expect(contextHref('/poptavka?typ=neznamy', { zdroj: '/catering' })).toBe('/poptavka?zdroj=%2Fcatering')
    expect(contextHref('/reference', { typ: 'svatba', zdroj: '/catering/svatby' })).toBe('/reference')
  })

  it('splitCtas, splitStepNumber, splitInternalLinks', () => {
    expect(splitCtas('Domluvit konzultaci zdarma → /poptavka?typ=konzultace · Poptat svatbu → /poptavka?typ=svatba')).toEqual([
      'Domluvit konzultaci zdarma → /poptavka?typ=konzultace',
      'Poptat svatbu → /poptavka?typ=svatba',
    ])
    expect(splitCtas('Objednat oběd → /poptavka?typ=obed')).toHaveLength(1)
    expect(splitStepNumber('3. Včas')).toEqual({ n: 3, title: 'Včas' })
    expect(splitInternalLinks('Drinky a koktejly. [Více o teambuildingu](/catering/teambuilding).')).toEqual([
      { text: 'Drinky a koktejly. ', href: null },
      { text: 'Více o teambuildingu', href: '/catering/teambuilding' },
      { text: '.', href: null },
    ])
    // Holá cesta v textu zůstává odkazem (starší zápis copy).
    expect(splitInternalLinks('Více na /catering/teambuilding.')).toEqual([
      { text: 'Více na ', href: null },
      { text: '/catering/teambuilding', href: '/catering/teambuilding' },
      { text: '.', href: null },
    ])
    // Zástupce ani externí adresa v hranatých závorkách odkazem nejsou.
    expect(splitInternalLinks('Od [DOPLNÍ KLIENT] Kč · [web](https://x.cz)')).toEqual([{ text: 'Od [DOPLNÍ KLIENT] Kč · [web](https://x.cz)', href: null }])
    expect(splitInternalLinks('od 300 Kč/os.')).toEqual([{ text: 'od 300 Kč/os.', href: null }])
  })
})

describe('catering: konfigurace odpovídá copy.json', () => {
  it('9 typů akcí, každý má stránku a položku v přehledu služeb', () => {
    expect(CATERING_TYPES.map((t) => t.slug)).toEqual([...CATERING_SLUGS])
    const sluzby = getPage('/catering').sections.find((s) => s.id === 'sluzby')!.items!.map((i) => parseItem(i).title)
    for (const t of CATERING_TYPES) {
      expect(sluzby).toContain(t.overviewTitle)
      const ids = getPage(t.path).sections.map((s) => s.id)
      expect(ids).toContain('hero')
      expect(ids).toContain('cta')
      // Konfigurace neodkazuje na sekci, která v copy není (překlep by sekci tiše přepnul na výchozí vzhled).
      for (const id of Object.keys(t.sections)) expect(ids).toContain(id)
      for (const b of t.bands ?? []) expect(ids).toContain(b.after)
    }
  })
})

describe.each(CATERING_SLUGS.map((s) => [s] as [CateringSlug]))('stránka /catering/%s', (slug) => {
  const cfg = CATERING_TYPES.find((t) => t.slug === slug)!
  const page = getPage(cfg.path)
  const { doc, text } = render(<CateringTypePage slug={slug} />)

  it('jeden h1 = nadpis hero z copy, drobečky', () => {
    const h1 = doc.querySelectorAll('h1')
    expect(h1).toHaveLength(1)
    expect(norm(h1[0].textContent ?? '')).toBe(page.sections.find((s) => s.id === 'hero')!.heading)
    const crumbs = [...doc.querySelectorAll('nav[aria-label="Drobečková navigace"] li')].map((li) => norm(li.textContent ?? ''))
    expect(crumbs).toEqual(['Úvod', 'Catering', cfg.breadcrumb])
  })

  it('všechny sekce a položky doslova z copy.json', () => {
    for (const s of page.sections) expectSectionVerbatim(text, s)
  })

  it('cena od a minimum osob z přehledu služeb; zástupci [DOPLNÍ KLIENT] jsou vidět', () => {
    const item = parseItem(getPage('/catering').sections.find((s) => s.id === 'sluzby')!.items!.find((i) => i.startsWith(cfg.overviewTitle + ' — '))!)
    const facts = splitPriceFacts(item.text)
    expect(facts.price).toMatch(/Kč\/os\.$/)
    expect(text).toContain(facts.price!)
    expect(text).toContain(facts.guests!)
    const fills = [...doc.querySelectorAll('.md-fill')]
    expect(fills.length).toBeGreaterThan(0)
    for (const f of fills) expect(f.textContent).toMatch(/^\[DOPLNÍ KLIENT/)
    // Cena se nikdy nevymýšlí: žádná konkrétní částka Kč/os. mimo copy.
    const amounts = text.match(/\d[\d\s]*\s?Kč\/os\./g) ?? []
    const copyText = norm(JSON.stringify(page))
    for (const a of amounts) expect(copyText).toContain(norm(a))
  })

  it('CTA do průvodce poptávkou nesou typ akce a zdroj', () => {
    const inquiry = links(doc).filter((h) => h.startsWith('/poptavka'))
    expect(inquiry.length).toBeGreaterThanOrEqual(2)
    for (const h of inquiry) {
      const q = new URLSearchParams(h.split('?')[1])
      expect(q.get('typ')).toBeTruthy()
      expect(q.get('zdroj')).toBe(cfg.path)
    }
    const typs = inquiry.map((h) => new URLSearchParams(h.split('?')[1]).get('typ'))
    // Hlavní CTA nese typ stránky (svatby: konzultace zdarma + poptávka svatby).
    if (slug === 'svatby') expect(typs).toEqual(expect.arrayContaining(['konzultace', 'svatba']))
    else expect(typs).toContain(cfg.eventType)
  })

  it('fotky mají alt, hero se načítá přednostně, jen jeden preload', () => {
    const imgs = [...doc.querySelectorAll('img')]
    expect(imgs.length).toBeGreaterThan(0)
    for (const img of imgs) expect((img.getAttribute('alt') ?? '').trim().length).toBeGreaterThan(0)
    for (const img of imgs) expect(img.getAttribute('src') ?? '').not.toMatch(/^https?:/)
    // Jediná nelíná fotka = hero (LCP; <Hero> přes fetchPriority, dělený hero přes preload).
    const eager = imgs.filter((img) => img.getAttribute('loading') !== 'lazy')
    expect(eager).toHaveLength(1)
    expect(eager[0]).toBe(imgs[0])
  })

  it('nadpisy sekcí jsou h2 a sekce na ně odkazují (aria-labelledby)', () => {
    for (const sec of doc.querySelectorAll('section[aria-labelledby]')) {
      const id = sec.getAttribute('aria-labelledby')!
      expect(doc.getElementById(id), id).not.toBeNull()
    }
    const ids = [...doc.querySelectorAll('[id]')].map((e) => e.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('JSON-LD: drobečky (a FAQ, kde je sekce faq)', () => {
    const ld = [...doc.querySelectorAll('script[type="application/ld+json"]')].map((s) => JSON.parse(s.textContent ?? '{}'))
    expect(ld.some((x) => x['@type'] === 'BreadcrumbList')).toBe(true)
    const hasFaq = page.sections.some((s) => s.id === 'faq')
    expect(ld.some((x) => x['@type'] === 'FAQPage')).toBe(hasFaq)
    for (const x of ld) expect(JSON.stringify(x)).not.toContain('[DOPLNÍ KLIENT')
  })
})

describe('přehled /catering', () => {
  const page = getPage('/catering')
  const { doc, text } = render(<CateringOverview />)

  it('h1 a všechny sekce doslova', () => {
    expect(doc.querySelectorAll('h1')).toHaveLength(1)
    expect(norm(doc.querySelector('h1')!.textContent ?? '')).toBe(page.sections[0].heading)
    for (const s of page.sections) expectSectionVerbatim(text, s)
  })

  it('karty všech 9 služeb vedou na stránky typů a nesou cenu i minimum', () => {
    const hrefs = links(doc)
    for (const t of CATERING_TYPES) expect(hrefs).toContain(t.path)
    expect(doc.querySelectorAll('#sluzby li article')).toHaveLength(9)
    expect(text).toContain('od 15 osob')
    expect(text).toContain('minimum podle objednávky')
  })

  it('CTA na poptávku nese zdroj /catering; metadata title doslova', () => {
    const inquiry = links(doc).filter((h) => h.startsWith('/poptavka'))
    expect(inquiry.length).toBeGreaterThan(0)
    for (const h of inquiry) expect(new URLSearchParams(h.split('?')[1]).get('zdroj')).toBe('/catering')
    expect(stripPlaceholders(page.metaTitle)).toBe(page.metaTitle)
  })
})

const PAGE_MODULES: Record<string, () => Promise<{ metadata: import('next').Metadata }>> = {
  '/catering': () => import('@/app/(web)/catering/page'),
  '/catering/firemni': () => import('@/app/(web)/catering/firemni/page'),
  '/catering/snidane': () => import('@/app/(web)/catering/snidane/page'),
  '/catering/coffee-break': () => import('@/app/(web)/catering/coffee-break/page'),
  '/catering/obedy': () => import('@/app/(web)/catering/obedy/page'),
  '/catering/vecere-a-bankety': () => import('@/app/(web)/catering/vecere-a-bankety/page'),
  '/catering/spolecenske-akce': () => import('@/app/(web)/catering/spolecenske-akce/page'),
  '/catering/teambuilding': () => import('@/app/(web)/catering/teambuilding/page'),
  '/catering/svatby': () => import('@/app/(web)/catering/svatby/page'),
  '/catering/oslavy-a-piknik': () => import('@/app/(web)/catering/oslavy-a-piknik/page'),
}

describe('balíčky pro firmy: čitelný odkaz na teambuilding', () => {
  it('copy nese „Více o teambuildingu“ jako odkaz na /catering/teambuilding, ne holou cestu', () => {
    const { doc, text } = render(<CateringTypePage slug="firemni" />)
    const a = [...doc.querySelectorAll('a[href="/catering/teambuilding"]')].map((x) => norm(x.textContent ?? ''))
    expect(a).toContain('Více o teambuildingu')
    expect(text).toContain('drinky a koktejly. Více o teambuildingu.')
    expect(text).not.toContain('Více na /catering')
    expect(text).not.toContain('](')
    expect(JSON.stringify(getPage('/catering/firemni'))).not.toContain('Více na /catering')
  })
})

describe('metadata stránek cateringu', () => {
  it('title a description doslova z copy, canonical', async () => {
    expect(Object.keys(PAGE_MODULES).sort()).toEqual(['/catering', ...CATERING_TYPES.map((t) => t.path)].sort())
    for (const [path, load] of Object.entries(PAGE_MODULES)) {
      const { metadata } = await load()
      const page = getPage(path)
      expect(metadata.title).toEqual({ absolute: stripPlaceholders(page.metaTitle) })
      expect(metadata.description).toBe(stripPlaceholders(page.metaDescription))
      expect(metadata.alternates?.canonical).toBe(path)
    }
  })
})
