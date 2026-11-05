import { act, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { getPage, parseItem, parseCta, splitDots, splitPlaceholders, type SectionCopy } from '@/lib/web/content'
import { BLOG_ARTICLES, PLANNED_ARTICLE_TAGS, blogSlugFromHref } from '@/lib/web/duvera/blog'
import { contextInquiryHref, slugify } from '@/lib/web/duvera/links'
import { REFERENCE_CASES } from '@/lib/web/duvera/references'
import { VENUES } from '@/lib/web/duvera/venues'
import { parseInquiryParams } from '@/lib/web/inquiry-link'

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
}))

const duvera = await import('@/components/web/duvera')
const { FilterGrid, splitPrices } = duvera
const ReferenceRoute = await import('@/app/(web)/reference/page')
const ReferenceSlugRoute = await import('@/app/(web)/reference/[slug]/page')
const ProstoryRoute = await import('@/app/(web)/prostory/page')
const ONasRoute = await import('@/app/(web)/o-nas/page')
const BlogRoute = await import('@/app/(web)/blog/page')
const BlogSlugRoute = await import('@/app/(web)/blog/[slug]/page')
const VanoceRoute = await import('@/app/(web)/vanoce/page')

const norm = (s: string) => s.replace(/\s+/g, ' ').trim()

function render(node: ReactNode) {
  const html = renderToStaticMarkup(node)
  const doc = new DOMParser().parseFromString(`<!doctype html><body>${html}</body>`, 'text/html')
  return { html, doc, text: norm(doc.body.textContent ?? '') }
}

function links(doc: Document) {
  return [...doc.querySelectorAll('a[href]')].map((a) => a.getAttribute('href')!)
}

const sec = (path: string, id: string): SectionCopy => getPage(path).sections.find((s) => s.id === id)!

/** Nadpis, text a položky sekce jsou na stránce doslova. */
function expectVerbatim(text: string, s: SectionCopy, { body = true, items = true } = {}) {
  expect(text).toContain(norm(s.heading))
  if (body && s.body) expect(text).toContain(norm(s.body))
  if (items)
    for (const raw of s.items ?? []) {
      const it = parseItem(raw)
      if (it.title) expect(text).toContain(norm(it.title))
      if (it.label) expect(text).toContain(norm(it.label))
      expect(text).toContain(norm(it.text))
    }
  if (s.cta) expect(text).toContain(parseCta(s.cta).label)
}

/** Společné kontroly: jeden h1, zástupci jsou vidět, obrázky mají alt, max. jeden preload. */
function expectBasics(doc: Document, html: string) {
  expect(doc.querySelectorAll('h1')).toHaveLength(1)
  for (const f of doc.querySelectorAll('.md-fill')) expect(f.textContent).toMatch(/^\[DOPLNÍ KLIENT/)
  for (const img of doc.querySelectorAll('img')) expect(img.getAttribute('alt')?.length).toBeGreaterThan(3)
  for (const ph of doc.querySelectorAll('[role="img"]')) expect(ph.getAttribute('aria-label')?.length).toBeGreaterThan(3)
  const eager = [...doc.querySelectorAll('img')].filter((i) => i.getAttribute('fetchpriority') === 'high' || i.getAttribute('loading') === 'eager')
  expect(eager.length).toBeLessThanOrEqual(1)
  // Žádný ID se neopakuje (aria-labelledby musí mířit jednoznačně).
  const ids = [...doc.querySelectorAll('[id]')].map((e) => e.id)
  expect(new Set(ids).size).toBe(ids.length)
  for (const el of doc.querySelectorAll('[aria-labelledby]')) expect(doc.getElementById(el.getAttribute('aria-labelledby')!)).toBeTruthy()
  // Ceny jen z copy: žádná vymyšlená částka.
  expect(html).not.toMatch(/\bNaN\b|undefined/)
}

/** Odkazy na poptávku nesou zdroj (a parametry projdou čtením na /poptavka). */
function inquiryLinks(doc: Document) {
  return links(doc)
    .filter((h) => h.startsWith('/poptavka'))
    .map((h) => ({ href: h, q: new URLSearchParams(h.split('?')[1] ?? ''), parsed: parseInquiryParams(new URLSearchParams(h.split('?')[1] ?? '')) }))
}

// ── pomocné funkce ──────────────────────────────────────────────────────────

describe('důvěra: pomocné funkce', () => {
  it('contextInquiryHref: copy má přednost, doplní zdroj, zahodí prázdné a nečitelné hodnoty', () => {
    expect(contextInquiryHref('/poptavka?typ=svatba&vzor=svatba-katka-a-jirka', { zdroj: '/reference/svatba-katka-a-jirka' })).toBe(
      '/poptavka?typ=svatba&zdroj=%2Freference%2Fsvatba-katka-a-jirka&vzor=svatba-katka-a-jirka',
    )
    expect(contextInquiryHref('/poptavka?prostor=', { zdroj: '/prostory' })).toBe('/poptavka?zdroj=%2Fprostory')
    expect(contextInquiryHref('/poptavka?zdroj=blog', { typ: 'svatba', zdroj: '/blog/x' })).toBe('/poptavka?typ=svatba&zdroj=%2Fblog%2Fx')
    expect(contextInquiryHref('/poptavka?typ=neznamy', { typ: 'oslava' })).toBe('/poptavka?typ=oslava')
    expect(contextInquiryHref('/cheesecaky/x', { zdroj: '/vanoce' })).toBe('/cheesecaky/x')
    expect(contextInquiryHref(null, { zdroj: '/o-nas' })).toBe('/poptavka?zdroj=%2Fo-nas')
  })

  it('slugify a zvýraznění cen (text zůstává doslova)', () => {
    expect(slugify('Firemní akce')).toBe('firemni-akce')
    expect(slugify('Z kuchyně')).toBe('z-kuchyne')
    const t = 'Raut, bufet, finger food nebo banket. Od 15 osob · od [DOPLNÍ KLIENT] Kč/os. Prosince je málo.'
    const parts = splitPrices(t)
    expect(parts.map((p) => p.text).join('')).toBe(t)
    expect(parts.filter((p) => p.price).map((p) => p.text)).toEqual(['od [DOPLNÍ KLIENT] Kč/os.'])
    expect(splitPrices('Cheesecake za 1 290 Kč. Pro klienty.').filter((p) => p.price).map((p) => p.text)).toEqual(['1 290 Kč'])
  })

  it('konfigurace odpovídá copy.json (případovky, prostory, články)', () => {
    const refHrefs = sec('/reference', 'pripadovky').items!.map((i) => parseItem(i).href).filter(Boolean)
    expect(refHrefs).toEqual(REFERENCE_CASES.map((c) => c.path))
    for (const c of REFERENCE_CASES) expect(getPage(c.path).sections.map((s) => s.id)).toEqual(['shrnuti', 'zadani', 'menu', 'galerie', 'citace', 'cta'])
    const venueNames = sec('/prostory', 'prostory').items!.map((i) => parseItem(i).title!)
    expect(venueNames).toHaveLength(VENUES.length)
    for (const v of VENUES) expect(venueNames.some((n) => n.startsWith(v.match))).toBe(true)
    const recommended = sec('/blog', 'doporucene').items!.map((i) => blogSlugFromHref(parseItem(i).href))
    for (const a of BLOG_ARTICLES) expect(recommended).toContain(a.slug)
    for (const s of recommended) expect(BLOG_ARTICLES.some((a) => a.slug === s) || s! in PLANNED_ARTICLE_TAGS).toBe(true)
    const tags = sec('/blog', 'stitky').items!
    for (const a of BLOG_ARTICLES) expect(tags).toContain(a.tag)
    for (const t of Object.values(PLANNED_ARTICLE_TAGS)) expect(tags).toContain(t)
  })

  it('články: 3 převzaté, meta description do 155 znaků, kroky a odstavce bez zástupců šablony', () => {
    expect(BLOG_ARTICLES).toHaveLength(3)
    for (const a of BLOG_ARTICLES) {
      expect(a.excerpt.length).toBeLessThanOrEqual(155)
      expect(a.published).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(JSON.stringify(a.blocks)).not.toMatch(/\[(Název|Text|Jméno)/)
      // Žádné ceny v článcích (nic nevymýšlíme).
      expect(JSON.stringify(a.blocks)).not.toMatch(/Kč/)
    }
  })
})

// ── /reference ──────────────────────────────────────────────────────────────

describe('/reference', () => {
  const { doc, html, text } = render(<ReferenceRoute.default />)

  it('texty doslova z copy, jeden h1 = úvod', () => {
    expectBasics(doc, html)
    expect(norm(doc.querySelector('h1')!.textContent!)).toBe(sec('/reference', 'uvod').heading)
    for (const id of ['uvod', 'loga', 'hodnoceni', 'cta']) expectVerbatim(text, sec('/reference', id))
    const p = sec('/reference', 'pripadovky')
    expect(text).toContain(p.heading)
    for (const label of splitDots(parseItem(p.body).text)) expect([...doc.querySelectorAll('button')].map((b) => b.textContent)).toContain(label)
    for (const raw of p.items!) {
      for (const part of splitPlaceholders(splitDots(parseItem(raw).text).slice(1).join(' · '))) expect(text).toContain(norm(part.text))
    }
  })

  it('karty: 3 případovky s odkazem a fotkou, garden party bez odkazu se zástupcem', () => {
    const cards = [...doc.querySelectorAll('#pripadove-studie li')]
    expect(cards).toHaveLength(4)
    expect(cards.map((c) => c.getAttribute('data-tags'))).toEqual(['firemni', 'svatby', 'svatby', 'oslavy'])
    for (const c of REFERENCE_CASES) expect(links(doc)).toContain(c.path)
    expect(cards[3].querySelector('a')).toBeNull()
    expect(cards[3].querySelector('.md-fill')?.textContent).toBe('[DOPLNÍ KLIENT: podklady a souhlas]')
    expect(cards[1].querySelector('img')).toBeTruthy()
  })

  it('CTA na poptávku se zdrojem; metadata z copy s og:image', () => {
    const inq = inquiryLinks(doc)
    expect(inq.length).toBeGreaterThan(0)
    for (const l of inq) expect(l.parsed.source?.page).toBe('/reference')
    const m = ReferenceRoute.metadata
    expect(m.title).toEqual({ absolute: 'Reference a realizované akce | Mummies & Daddies catering' })
    expect(m.alternates?.canonical).toBe('/reference')
    expect(JSON.stringify(m.openGraph)).toContain('/web/photos/')
  })
})

describe.each(REFERENCE_CASES.map((c) => [c.slug, c] as const))('/reference/%s', (slug, c) => {
  it('statické parametry a 404 pro neznámý slug', async () => {
    expect(ReferenceSlugRoute.generateStaticParams()).toContainEqual({ slug })
    expect(ReferenceSlugRoute.dynamicParams).toBe(false)
    await expect(ReferenceSlugRoute.default({ params: Promise.resolve({ slug: 'neexistuje' }) })).rejects.toThrow()
  })

  it('všechny sekce doslova, drobečky, CTA s typem, vzorem a zdrojem', async () => {
    const { doc, html, text } = render(await ReferenceSlugRoute.default({ params: Promise.resolve({ slug }) }))
    expectBasics(doc, html)
    const page = getPage(c.path)
    for (const s of page.sections) expectVerbatim(text, s)
    expect(norm(doc.querySelector('h1')!.textContent!)).toBe(sec(c.path, 'shrnuti').heading)
    const crumbs = [...doc.querySelectorAll('nav[aria-label="Drobečková navigace"] li')].map((li) => norm(li.textContent ?? ''))
    expect(crumbs).toEqual(['Úvod', 'Reference', sec(c.path, 'shrnuti').heading])
    expect([...doc.querySelectorAll('dt')].map((d) => d.textContent)).toEqual(['Typ akce', 'Místo', 'Formát', 'Hosté', 'Datum'])
    const inq = inquiryLinks(doc)
    expect(inq.length).toBeGreaterThanOrEqual(2)
    for (const l of inq) {
      expect(l.parsed.eventType).toBe(c.eventType)
      expect(l.parsed.source).toMatchObject({ page: c.path, ref: c.slug })
    }
    // Galerie: jen fotky z téže akce.
    expect(doc.querySelectorAll('section[aria-labelledby="galerie-title"] li')).toHaveLength(c.gallery.length)
  })

  it('metadata: canonical, og:image z coveru, noindex jen bez souhlasu s publikací', async () => {
    const m = await ReferenceSlugRoute.generateMetadata({ params: Promise.resolve({ slug }) })
    expect(m.alternates?.canonical).toBe(c.path)
    expect(JSON.stringify(m.openGraph)).toContain('/web/photos/')
    if (slug === 'bvlgari-luxury-party') expect(m.robots).toEqual({ index: false, follow: true })
    else expect(m.robots).toBeUndefined()
  })
})

// ── /prostory ───────────────────────────────────────────────────────────────

describe('/prostory', () => {
  const { doc, html, text } = render(<ProstoryRoute.default />)

  it('texty doslova, karty prostorů s fotkou nebo zástupcem', () => {
    expectBasics(doc, html)
    for (const s of getPage('/prostory').sections) expectVerbatim(text, s)
    expect(doc.querySelectorAll('#nase-prostory li')).toHaveLength(4)
  })

  it('každý potvrzený prostor má poptávku s ?prostor=slug; nepotvrzený ne', () => {
    const venues = inquiryLinks(doc).filter((l) => l.q.get('prostor'))
    expect(venues.map((l) => l.q.get('prostor'))).toEqual(VENUES.filter((v) => v.confirmed).map((v) => v.slug))
    for (const l of venues) {
      expect(l.parsed.venue?.venueSlug).toBe(l.q.get('prostor'))
      expect(l.parsed.source?.page).toBe('/prostory')
    }
    expect(links(doc).some((h) => h.includes('prostor=na-veselce'))).toBe(false)
    // Prázdné „?prostor=“ z copy se do odkazu nedostane.
    expect(links(doc).some((h) => /prostor=(&|$)/.test(h))).toBe(false)
  })
})

// ── /o-nas ──────────────────────────────────────────────────────────────────

describe('/o-nas', () => {
  const { doc, html, text } = render(<ONasRoute.default />)

  it('texty doslova (příběh, tým, hodnoty, kuchyně, čísla, kariéra, CTA)', () => {
    expectBasics(doc, html)
    expect(norm(doc.querySelector('h1')!.textContent!)).toBe('Mummy & Daddy jsou skuteční')
    for (const s of getPage('/o-nas').sections) expectVerbatim(text, s, { body: s.id !== 'cisla' })
    for (const part of splitDots(sec('/o-nas', 'cisla').body)) expect(text).toContain(part)
  })

  it('Rudolf a Monika s fotkou, Monika s rolí jako zástupce; CTA se zdrojem', () => {
    const cards = [...doc.querySelectorAll('#tym li')]
    expect(cards).toHaveLength(3)
    expect(cards[0].querySelector('img')?.getAttribute('alt')).toContain('Rudolf')
    expect(cards[1].querySelector('.md-fill')?.textContent).toBe('[DOPLNÍ KLIENT: role]')
    for (const l of inquiryLinks(doc)) expect(l.parsed.source?.page).toBe('/o-nas')
    // Portrét v úvodu je LCP: preload (bez loading=lazy), ostatní fotky líně.
    const imgs = [...doc.querySelectorAll('img')]
    expect(imgs[0].getAttribute('loading')).toBeNull()
    expect(imgs.slice(1).every((i) => i.getAttribute('loading') === 'lazy')).toBe(true)
  })
})

// ── /vanoce ─────────────────────────────────────────────────────────────────

describe('/vanoce', () => {
  const { doc, html, text } = render(<VanoceRoute.default />)

  it('texty doslova, checklist 6 kroků, cukroví', () => {
    expectBasics(doc, html)
    for (const s of getPage('/vanoce').sections) expectVerbatim(text, s)
    expect(doc.querySelectorAll('#checklist ol > li')).toHaveLength(6)
  })

  it('ceny malinově a jen z copy; CTA večírku nese typ a zdroj; cheesecake vede na produkt', () => {
    const prices = [...doc.querySelectorAll('.text-raspberry-ink')].map((e) => norm(e.textContent ?? ''))
    expect(prices).toEqual(expect.arrayContaining(['od [DOPLNÍ KLIENT] Kč/os.', '1 290 Kč']))
    const inq = inquiryLinks(doc)
    expect(inq.length).toBeGreaterThanOrEqual(3)
    for (const l of inq) {
      expect(l.parsed.eventType).toBe('vanocni-vecirek')
      expect(l.parsed.source?.page).toBe('/vanoce')
    }
    expect(links(doc)).toContain('/cheesecaky/mummy-vanilkovo-pomerancovy-vanocni')
  })
})

// ── /blog ───────────────────────────────────────────────────────────────────

describe('/blog', () => {
  const { doc, html, text } = render(<BlogRoute.default />)

  it('úvod, štítky a doporučené články doslova; hotové články napřed s odkazem', () => {
    expectBasics(doc, html)
    for (const s of getPage('/blog').sections) expectVerbatim(text, s)
    const cards = [...doc.querySelectorAll('#clanky li')]
    expect(cards).toHaveLength(sec('/blog', 'doporucene').items!.length)
    const withLinks = cards.filter((c) => c.querySelector('a'))
    expect(withLinks).toHaveLength(BLOG_ARTICLES.length)
    expect(cards.slice(0, 3).every((c) => c.querySelector('a'))).toBe(true)
    for (const c of cards.slice(3)) expect(c.querySelector('.md-fill')?.textContent).toBe('[DOPLNÍ KLIENT: text článku]')
    const filterButtons = [...doc.querySelectorAll('button[aria-pressed]')].map((b) => b.textContent)
    expect(filterButtons).toEqual(['Vše', ...sec('/blog', 'stitky').items!])
  })
})

describe.each(BLOG_ARTICLES.map((a) => [a.slug, a] as const))('/blog/%s', (slug, a) => {
  it('článek, autor, box služby, CTA a související podle šablony copy', async () => {
    const { doc, html, text } = render(await BlogSlugRoute.default({ params: Promise.resolve({ slug }) }))
    expectBasics(doc, html)
    expect(norm(doc.querySelector('h1')!.textContent!)).toBe(a.title)
    for (const b of a.blocks) if (b.type === 'p' || b.type === 'h2') expect(text).toContain(norm(b.text))
    const tpl = '/blog/[slug]'
    for (const id of ['sluzba', 'autor', 'cta', 'souvisejici']) expect(text).toContain(sec(tpl, id).heading)
    expect(text).toContain(parseCta(sec(tpl, 'sluzba').cta!).label)
    expect(text).toContain(norm(sec(tpl, 'cta').body))
    // Instrukce šablony se nevypisují.
    expect(text).not.toMatch(/\[(Název článku|Text článku|Jméno a role|3 související)/)
    expect(text).not.toContain('Box se související službou')
    if (slug === 'jak-vybrat-svatebni-catering') expect(text).toContain('menu na míru, ochutnávka a konzultace zdarma.')
    expect(links(doc)).toContain(a.service.href)
    const inq = inquiryLinks(doc)
    expect(inq).toHaveLength(1)
    expect(inq[0].parsed.eventType).toBe(a.service.eventType)
    expect(inq[0].parsed.source?.page).toBe(`/blog/${slug}`)
    expect(doc.querySelectorAll('section[aria-labelledby="souvisejici-title"] li')).toHaveLength(BLOG_ARTICLES.length - 1)
    const ld = [...doc.querySelectorAll('script[type="application/ld+json"]')].map((s) => JSON.parse(s.textContent!))
    expect(ld.find((x) => x['@type'] === 'BlogPosting')).toMatchObject({ headline: a.title, datePublished: a.published })
  })

  it('metadata podle šablony „[Název článku] | Blog Mummies & Daddies“', async () => {
    const m = await BlogSlugRoute.generateMetadata({ params: Promise.resolve({ slug }) })
    expect(m.title).toEqual({ absolute: `${a.title} | Blog Mummies & Daddies` })
    expect(m.description).toBe(a.excerpt)
    expect(m.alternates?.canonical).toBe(`/blog/${slug}`)
    expect(m.openGraph).toMatchObject({ type: 'article', url: `/blog/${slug}` })
    expect(BlogSlugRoute.generateStaticParams()).toContainEqual({ slug })
  })
})

// ── FilterGrid (klient) ─────────────────────────────────────────────────────

describe('FilterGrid', () => {
  it('filtruje podle štítku, aria-pressed a ?stitek= v URL', async () => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    window.history.replaceState(null, '', '/blog?stitek=svatby')
    const host = document.createElement('div')
    document.body.append(host)
    const root = createRoot(host)
    await act(async () => {
      root.render(
        <FilterGrid
          legend="Témata"
          allLabel="Vše"
          options={[
            { value: 'svatby', label: 'Svatby' },
            { value: 'oslavy', label: 'Oslavy' },
          ]}
          items={[
            { key: 'a', tags: ['svatby'], node: <span>A</span> },
            { key: 'b', tags: ['oslavy'], node: <span>B</span> },
          ]}
        />,
      )
    })
    const visible = () => [...host.querySelectorAll('li')].filter((li) => !li.classList.contains('hidden')).map((li) => li.textContent)
    expect(visible()).toEqual(['A'])
    const [all, , oslavy] = [...host.querySelectorAll('button')]
    await act(async () => oslavy.click())
    expect(visible()).toEqual(['B'])
    expect(oslavy.getAttribute('aria-pressed')).toBe('true')
    expect(window.location.search).toBe('?stitek=oslavy')
    await act(async () => all.click())
    expect(visible()).toEqual(['A', 'B'])
    expect(window.location.search).toBe('')
    await act(async () => root.unmount())
  })
})
