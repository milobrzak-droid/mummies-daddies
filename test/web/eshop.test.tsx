import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { renderToStaticMarkup } from 'react-dom/server'

// Next komponenty mimo běžící aplikaci (router, optimalizace obrázků) nahradíme prostým HTML.
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
  usePathname: () => '/cheesecaky',
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND')
  },
}))

import CheesecakesPage from '@/app/(web)/cheesecaky/page'
import CheesecakePage, { generateMetadata, generateStaticParams } from '@/app/(web)/cheesecaky/[slug]/page'
import CartPage from '@/app/(web)/kosik/page'
import VoucherPage from '@/app/(web)/darkovy-poukaz/page'
import { CartView, ProductConfigurator } from '@/components/web/eshop'
import { submitOrder, submitVoucherOrder, type VoucherOrder } from '@/lib/web/api'
import { allPages, getPage, getSection, microcopy } from '@/lib/web/content'
import {
  CART_STORAGE_KEY, EMPTY_CART, __resetCartForTests, addItem, cartCount, readCart, removeLine, sanitizeCart, setDate,
  toOrderItems, updateCart, updateLine, writeCart, getCartSnapshot,
} from '@/lib/web/eshop/cart'
import { CHEESECAKE_SLUGS, fill, flavorCounts, flavorsFromCounts, productPath } from '@/lib/web/eshop/catalog'
import { allProductSummaries, cartLabels, catalogPageData, configuratorLabels, extractPrice, productPageData, voucherPageData } from '@/lib/web/eshop/copy'
import { VOUCHER_MESSAGES, VOUCHER_PRESETS, validateVoucher } from '@/lib/web/eshop/voucher'
import { formatCzk, isoDate } from '@/lib/web/format'
import { CHEESECAKES, MINI_FLAVORS, cheesecakeOf, type CheesecakeSlug } from '@/lib/web/options'
import { earliestOrderDate, MESSAGES } from '@/lib/web/validation'
import { installWebApiFake } from '../helpers/webApiFake'

// ── pomocné ─────────────────────────────────────────────────────────────────

function render(node: ReactNode): Document {
  const html = renderToStaticMarkup(node)
  const doc = document.implementation.createHTMLDocument('t')
  doc.body.innerHTML = html
  return doc
}

const text = (el: Element | null | undefined) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
/** Text bez nedělitelných mezer (formatCzk je vkládá). */
const norm = (s: string) => s.replace(/ /g, ' ')
const KNOWN_PATHS = new Set(allPages().map((p) => p.path))

function expectKnownLinks(doc: Document | Element) {
  for (const a of Array.from(doc.querySelectorAll('a[href]'))) {
    const href = a.getAttribute('href')!
    if (/^(tel:|mailto:|https:)/.test(href) || href.startsWith('#')) continue
    const path = href.split(/[?#]/)[0]
    expect(KNOWN_PATHS.has(path), `neznámá cesta ${href}`).toBe(true)
  }
}

function expectAccessibleBasics(doc: Document, h1 = 1) {
  expect(doc.querySelectorAll('h1')).toHaveLength(h1)
  const ids = Array.from(doc.querySelectorAll('[id]')).map((e) => e.id)
  expect(new Set(ids).size, `duplicitní id: ${ids.filter((x, i) => ids.indexOf(x) !== i)}`).toBe(ids.length)
  for (const el of Array.from(doc.querySelectorAll('[aria-labelledby]'))) {
    expect(doc.getElementById(el.getAttribute('aria-labelledby')!), el.getAttribute('aria-labelledby')!).not.toBeNull()
  }
  // alt má každý obrázek; prázdný jen čistě dekorativní výřez uvnitř aria-hidden (web v2)
  for (const img of Array.from(doc.querySelectorAll('img'))) {
    if (img.closest('[aria-hidden="true"]')) expect(img.getAttribute('alt')).toBe('')
    else expect((img.getAttribute('alt') ?? '').length).toBeGreaterThan(0)
  }
  for (const f of Array.from(doc.querySelectorAll('input:not([type=hidden]):not([type=radio]), select, textarea'))) {
    const wrapped = f.closest('label')
    expect(wrapped || doc.querySelector(`label[for="${f.id}"]`), `pole ${f.getAttribute('name') ?? f.id} bez popisku`).toBeTruthy()
  }
  for (const r of Array.from(doc.querySelectorAll('input[type=radio]'))) {
    expect(r.closest('label'), 'radio bez popisku').not.toBeNull()
    expect(r.closest('fieldset')?.querySelector('legend'), 'radio mimo fieldset s legendou').toBeTruthy()
  }
  for (const a of Array.from(doc.querySelectorAll('a'))) expect(text(a).length + (a.getAttribute('aria-label')?.length ?? 0)).toBeGreaterThan(0)
  for (const b of Array.from(doc.querySelectorAll('button:not([aria-hidden=true])'))) expect(text(b).length + (b.getAttribute('aria-label')?.length ?? 0)).toBeGreaterThan(0)
}

/** Zástupce [DOPLNÍ KLIENT] musí zůstat vidět (jako .md-fill). */
function expectPlaceholdersVisible(doc: Document) {
  expect(doc.querySelectorAll('.md-fill').length).toBeGreaterThan(0)
  for (const el of Array.from(doc.querySelectorAll('.md-fill'))) expect(text(el)).toMatch(/^\[DOPLNÍ KLIENT/)
}

// ── interaktivní render v happy-dom ──────────────────────────────────────────

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

async function mount(node: ReactNode) {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root.render(node)
  })
}

function setValue(el: Element | null, value: string) {
  if (!el) throw new Error('pole nenalezeno')
  const input = el as HTMLInputElement
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input), 'value')!.set!
  setter.call(input, value)
  input.dispatchEvent(new Event('input', { bubbles: true }))
}

async function type(el: Element | null, value: string) {
  await act(async () => setValue(el, value))
}

async function click(el: Element | null) {
  if (!el) throw new Error('prvek nenalezen')
  await act(async () => (el as HTMLElement).click())
}

async function submit(form: Element | null) {
  if (!form) throw new Error('formulář nenalezen')
  await act(async () => {
    form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }))
  })
}

// Napojení na systém (P6): fetch na /api/web/** jde do serverových funkcí se Supabase mockem.
beforeEach(() => { installWebApiFake() })
afterEach(() => { vi.unstubAllGlobals() })

beforeEach(() => {
  window.localStorage.clear()
  __resetCartForTests()
})

afterEach(async () => {
  if (root) {
    await act(async () => root.unmount())
    container.remove()
  }
  vi.restoreAllMocks()
})

// ── data a texty ────────────────────────────────────────────────────────────

describe('e-shop – data z copy.json a options.ts', () => {
  it('ceny v copy (katalog i detail) odpovídají číselníku CHEESECAKES (BRIEF)', () => {
    const products = allProductSummaries()
    for (const c of CHEESECAKES) {
      const p = products[c.slug]
      expect(norm(p.priceText).startsWith(norm(formatCzk(c.price))), `${c.slug}: ${p.priceText}`).toBe(true)
      const detail = productPageData(c.slug)
      expect(norm(detail.priceText).startsWith(norm(formatCzk(c.price)))).toBe(true)
      // nepotvrzená cena nese zástupce
      expect(detail.priceText.includes('[DOPLNÍ KLIENT'), c.slug).toBe(!c.priceConfirmed)
    }
  })

  it('extractPrice vyjme cenu z odstavce a zbytek nechá doslova', () => {
    expect(extractPrice('Poctivá chuť. 790 Kč.')).toEqual({ text: 'Poctivá chuť.', price: '790 Kč' })
    expect(extractPrice('Daddy. 1 290 Kč [DOPLNÍ KLIENT: potvrdit cenu]. [DOPLNÍ KLIENT: popis]')).toEqual({
      text: 'Daddy. [DOPLNÍ KLIENT: popis]',
      price: '1 290 Kč [DOPLNÍ KLIENT: potvrdit cenu]',
    })
    expect(extractPrice('Bez ceny.')).toEqual({ text: 'Bez ceny.', price: null })
  })

  it('katalog má 6 produktů v pořadí copy + sezónní vánoční', () => {
    const d = catalogPageData()
    expect(d.products.map((p) => p.slug)).toEqual([
      'daddy-vanilkovy', 'daddy-pistaciovo-malinovy', 'daddy-cokoladovo-liskooriskovy', 'daddy-vanilkovo-karamelovy',
      'mummy-vanilkovo-ovocny', 'mini-cheesecaky-10-ks',
    ])
    expect(d.products[0].description).toBe('vanilka a máslové sušenky')
    expect(d.sezona.product?.slug).toBe('mummy-vanilkovo-pomerancovy-vanocni')
    expect(d.naAkci.cta?.href).toBe('/poptavka?doplnek=cheesecaky&zdroj=%2Fcheesecaky')
  })

  it('příchutě mini: popisky z copy v pořadí MINI_FLAVORS', () => {
    const l = configuratorLabels('mini-cheesecaky-10-ks')
    expect(l.flavors.map((f) => f.value)).toEqual([...MINI_FLAVORS])
    expect(l.flavors.map((f) => f.label)).toEqual(getSection('/cheesecaky/mini-cheesecaky-10-ks', 'volby').items)
    expect(l.flavorsRemaining).toBe('Vyberte 10 příchutí. Zbývá vybrat {n}.')
  })

  it('poukaz: hodnoty a chybová hláška doslova z copy', () => {
    const d = voucherPageData()
    expect(d.labels.presets.map((p) => p.amount)).toEqual([...VOUCHER_PRESETS, null])
    expect(d.labels.presets.map((p) => p.label)).toEqual(getSection('/darkovy-poukaz', 'hodnoty').items)
    expect(VOUCHER_MESSAGES.amount).toBe(microcopy('POUKAZ — chyba částka'))
  })

  it('mikrotexty košíku pocházejí z copy (nic nevymyšleného)', () => {
    const l = cartLabels()
    expect(l.heading).toBe(microcopy('KOŠÍK — nadpis'))
    expect(l.submit).toBe(microcopy('KOŠÍK — tlačítko'))
    expect(l.deliveryOptions.map((d) => [d.value, d.label, d.price])).toEqual([
      ['praha', 'Praha 300 Kč', 300], ['praha-30', 'Praha + 30 km 550 Kč', 550], ['praha-70', 'Praha + 70 km 750 Kč', 750], ['vyzvednuti', 'Osobní vyzvednutí', 0],
    ])
    expect(l.deliveryOptions[3].note).toBe('[DOPLNÍ KLIENT: adresa]')
    expect(l.upsell.href).toBe('/poptavka?zdroj=%2Fkosik&doplnek=cheesecaky')
    expect(fill(l.inscriptionCounter, { n: 7 })).toBe('7/25')
  })
})

// ── košík (localStorage) ────────────────────────────────────────────────────

describe('e-shop – košík', () => {
  it('slučuje stejnou konfiguraci, jiný nápis = nový řádek', () => {
    let s = addItem(EMPTY_CART, { slug: 'daddy-vanilkovy', quantity: 1 })
    s = addItem(s, { slug: 'daddy-vanilkovy', quantity: 2 })
    s = addItem(s, { slug: 'daddy-vanilkovy', quantity: 1, inscription: 'Pro Janu' })
    expect(s.lines.map((l) => [l.quantity, l.inscription ?? null])).toEqual([[3, null], [1, 'Pro Janu']])
    expect(cartCount(s)).toBe(4)
    s = updateLine(s, s.lines[0].id, { quantity: 0 })
    expect(s.lines[0].quantity).toBe(1)
    s = removeLine(s, s.lines[1].id)
    expect(s.lines).toHaveLength(1)
  })

  it('sanitizeCart zahodí neznámé produkty, cizí příchutě a zkrátí nápis', () => {
    const s = sanitizeCart({
      date: '2027-02-14',
      lines: [
        { id: 'a', slug: 'neexistuje', quantity: 1 },
        { id: 'b', slug: 'daddy-vanilkovy', quantity: 2.7, inscription: 'x'.repeat(40) },
        { id: 'c', slug: 'daddy-pistaciovo-malinovy', quantity: 1, inscription: 'nesmí tu být' },
        { id: 'd', slug: 'mini-cheesecaky-10-ks', quantity: 1, miniFlavors: ['jahoda', 'malina', 'borůvka'] },
        { id: 'e', slug: 'daddy-vanilkovy', quantity: -3 },
        'nesmysl',
      ],
    })
    expect(s.date).toBe('2027-02-14')
    expect(s.lines.map((l) => l.id)).toEqual(['b', 'c', 'd'])
    expect(s.lines[0]).toMatchObject({ quantity: 2, inscription: 'x'.repeat(25) })
    expect(s.lines[1].inscription).toBeUndefined()
    expect(s.lines[2].miniFlavors).toEqual(['jahoda', 'borůvka'])
    expect(sanitizeCart(null)).toEqual({ lines: [], date: null })
  })

  it('ukládá do localStorage, poškozená data = prázdný košík', () => {
    updateCart((s) => setDate(addItem(s, { slug: 'mummy-vanilkovo-ovocny', quantity: 1 }), '2027-01-10'))
    const raw = JSON.parse(window.localStorage.getItem(CART_STORAGE_KEY)!)
    expect(raw).toMatchObject({ date: '2027-01-10', lines: [{ slug: 'mummy-vanilkovo-ovocny', quantity: 1 }] })
    expect(raw.lines[0].price).toBeUndefined() // ceny se neukládají
    window.localStorage.setItem(CART_STORAGE_KEY, '{nesmysl')
    expect(readCart()).toEqual({ lines: [], date: null })
  })

  it('když localStorage hází výjimky, košík funguje dál v paměti', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    expect(() => updateCart((s) => addItem(s, { slug: 'daddy-vanilkovy', quantity: 2 }))).not.toThrow()
    expect(cartCount(getCartSnapshot())).toBe(2)
    expect(cartCount(readCart())).toBe(2)
  })

  it('toOrderItems = kontrakt CartItem (bez interního id)', () => {
    const s = addItem(EMPTY_CART, { slug: 'mini-cheesecaky-10-ks', quantity: 1, miniFlavors: flavorsFromCounts({ jahoda: 4, karamel: 6 }) })
    expect(toOrderItems(s)).toEqual([{ slug: 'mini-cheesecaky-10-ks', quantity: 1, inscription: null, miniFlavors: [...Array(4).fill('jahoda'), ...Array(6).fill('karamel')] }])
    expect(flavorCounts(toOrderItems(s)[0].miniFlavors)).toMatchObject({ jahoda: 4, karamel: 6, borůvka: 0 })
    writeCart(s)
    expect(readCart().lines).toHaveLength(1)
  })
})

// ── poukaz (kontrakt) ───────────────────────────────────────────────────────

describe('e-shop – dárkový poukaz (submitVoucherOrder)', () => {
  const valid: VoucherOrder = { amount: 1500, recipientName: 'Jana', message: null, deliveryEmail: 'jana@example.cz', payment: 'prevod', consent: true }

  it('validace: částka, jméno, e-mail, platba, souhlas', () => {
    expect(validateVoucher(valid)).toEqual({})
    const e = validateVoucher({ amount: 0, recipientName: ' ', deliveryEmail: 'x@', consent: false })
    expect(e).toEqual({
      amount: VOUCHER_MESSAGES.amount,
      recipientName: MESSAGES.required,
      deliveryEmail: MESSAGES.email,
      payment: MESSAGES.required,
      consent: MESSAGES.orderConsent,
    })
    expect(validateVoucher({ ...valid, amount: 12.5 }).amount).toBeDefined()
  })

  it('poukazy systém zatím neprodává: po kontrole formuláře poctivá chyba, nic se neodešle', async () => {
    const r = await submitVoucherOrder(valid)
    expect(r).toEqual({ ok: false, reason: 'server', message: 'vouchers_unavailable' })
    expect(await submitVoucherOrder({ ...valid, consent: false })).toMatchObject({ ok: false, reason: 'validation' })
    expect(fetch).not.toHaveBeenCalled()
  })
})

// ── render stránek ──────────────────────────────────────────────────────────

describe('/cheesecaky', () => {
  const doc = render(<CheesecakesPage />)
  const body = norm(text(doc.body))

  it('H1 z copy, karty produktů s cenou a odkazem na detail', () => {
    expectAccessibleBasics(doc)
    expectKnownLinks(doc)
    expect(text(doc.querySelector('h1'))).toBe(getSection('/cheesecaky', 'uvod').heading)
    const cards = Array.from(doc.getElementById('produkty')!.querySelectorAll('article'))
    expect(cards).toHaveLength(6)
    expect(cards.map((c) => c.querySelector('h3 a')?.getAttribute('href'))).toEqual(catalogPageData().products.map((p) => productPath(p.slug)))
    expect(norm(text(cards[0]))).toContain('790 Kč')
    // nepotvrzená cena karamelového = viditelný zástupce
    expect(text(cards[3].querySelector('.md-fill'))).toBe('[DOPLNÍ KLIENT: potvrdit cenu]')
    // rychlé přidání jen u produktů bez povinných voleb (mini má příchutě)
    expect(cards.map((c) => !!Array.from(c.querySelectorAll('button')).find((b) => text(b) === 'Přidat do košíku'))).toEqual([true, true, true, true, true, false])
  })

  it('všechny sekce copy jsou na stránce, doslova', () => {
    for (const s of getPage('/cheesecaky').sections) {
      expect(body).toContain(norm(s.heading))
    }
    expect(body).toContain(norm(getSection('/cheesecaky', 'mini').body))
    expect(body).toContain('Praha + 70 km')
    expect(body).toContain('Dárkový poukaz od 1 000 Kč.')
    expect(doc.querySelector('a[href="/poptavka?doplnek=cheesecaky&zdroj=%2Fcheesecaky"]')).not.toBeNull()
    expect(doc.querySelector('a[href="/darkovy-poukaz"]')).not.toBeNull()
    expectPlaceholdersVisible(doc)
  })
})

describe('/cheesecaky/[slug]', () => {
  it('generateStaticParams = 7 produktů, metadata z copy', async () => {
    expect(generateStaticParams().map((p) => p.slug)).toEqual([...CHEESECAKE_SLUGS])
    const m = await generateMetadata({ params: Promise.resolve({ slug: 'daddy-vanilkovy' }) })
    expect(m.title).toEqual({ absolute: getPage('/cheesecaky/daddy-vanilkovy').metaTitle })
    expect(m.alternates?.canonical).toBe('/cheesecaky/daddy-vanilkovy')
    await expect(CheesecakePage({ params: Promise.resolve({ slug: 'neexistuje' }) })).rejects.toThrow('NEXT_NOT_FOUND')
  })

  for (const slug of CHEESECAKE_SLUGS) {
    it(`${slug}: H1, cena, konfigurátor, parametry se zástupci a související`, async () => {
      const doc = render(await CheesecakePage({ params: Promise.resolve({ slug }) }))
      expectAccessibleBasics(doc)
      expectKnownLinks(doc)
      expectPlaceholdersVisible(doc)
      const page = getPage(productPath(slug))
      expect(text(doc.querySelector('h1'))).toBe(page.sections.find((s) => s.id === 'popis')!.heading)
      const c = cheesecakeOf(slug)!
      expect(norm(text(doc.body))).toContain(norm(formatCzk(c.price)))
      const form = doc.querySelector('form')!
      expect(text(form.querySelector('button[type=submit]'))).toBe('Přidat do košíku')
      expect(!!form.querySelector('input[name=napis]')).toBe(c.inscription)
      expect(form.querySelector('input[name=napis]')?.getAttribute('maxlength') ?? '25').toBe('25')
      const flavorInputs = form.querySelectorAll('input[id*="prichute-"]')
      expect(flavorInputs.length).toBe(c.line === 'mini' ? 7 : 0)
      expect(form.querySelector('input[type=date]')).not.toBeNull()
      for (const s of page.sections) expect(norm(text(doc.body))).toContain(norm(s.heading))
    })
  }
})

describe('/kosik a /darkovy-poukaz (server render)', () => {
  it('košík: H1 „Váš košík“, před načtením localStorage stav načítání, noindex', () => {
    const doc = render(<CartPage />)
    expectAccessibleBasics(doc)
    expect(text(doc.querySelector('h1'))).toBe('Váš košík')
    expect(doc.querySelector('[aria-busy=true]')).not.toBeNull()
  })

  it('poukaz: hodnoty jako radio, popsaná pole, zástupci platnosti a uplatnění', () => {
    const doc = render(<VoucherPage />)
    expectAccessibleBasics(doc)
    expectKnownLinks(doc)
    expectPlaceholdersVisible(doc)
    expect(text(doc.querySelector('h1'))).toBe('Darujte něco dobrého')
    const radios = Array.from(doc.querySelectorAll('input[name=hodnota]'))
    expect(radios.map((r) => text(r.closest('label')))).toEqual(['1 000 Kč', '1 500 Kč', '2 000 Kč', '2 500 Kč', '5 000 Kč', 'Vlastní částka'].map((s) => s))
    expect(text(doc.querySelector('label[for="poukaz-pro"]'))).toBe('Pro koho je poukaz?')
    expect(text(doc.querySelector('form button[type=submit]'))).toBe('Koupit poukaz')
    const body = text(doc.body)
    expect(body).toContain('[DOPLNÍ KLIENT: cheesecaky, catering, nebo obojí]')
    expect(body).toContain('[DOPLNÍ KLIENT: platnost poukazu]')
  })
})

// ── interakce (happy-dom) ───────────────────────────────────────────────────

describe('konfigurátor produktu (interakce)', () => {
  it('mini: bez 10 příchutí nepřidá, s 10 přidá do košíku', async () => {
    await mount(<ProductConfigurator slug="mini-cheesecaky-10-ks" price={575} labels={configuratorLabels('mini-cheesecaky-10-ks')} />)
    const form = container.querySelector('form')!
    await submit(form)
    expect(text(container)).toContain('Vyberte prosím všech 10 mini cheesecaků.')
    expect(readCart().lines).toHaveLength(0)

    const inputs = Array.from(container.querySelectorAll<HTMLInputElement>('input[id*="prichute-"]'))
    await type(inputs[0], '4')
    expect(text(container)).toContain('Zbývá vybrat 6.')
    await type(inputs[2], '6')
    expect(text(container)).toContain('Zbývá vybrat 0.')
    await submit(form)
    expect(text(container)).toContain('Přidáno do košíku. Dobrá volba!')
    expect(container.querySelector('a[href="/kosik"]')).not.toBeNull()
    const lines = readCart().lines
    expect(lines).toHaveLength(1)
    expect(flavorCounts(lines[0].miniFlavors)).toMatchObject({ jahoda: 4, pistácie: 6 })
  })

  it('Daddy vanilkový: nápis s počítadlem a termín nejdřív od zítřka', async () => {
    await mount(<ProductConfigurator slug="daddy-vanilkovy" price={790} labels={configuratorLabels('daddy-vanilkovy')} />)
    const form = container.querySelector('form')!
    const date = form.querySelector<HTMLInputElement>('input[type=date]')!
    expect(date.getAttribute('min')).toBe(earliestOrderDate())
    await type(form.querySelector('input[name=napis]'), 'Všechno nejlepší, Jano')
    expect(text(container)).toContain('22/25')
    await type(date, isoDate(0))
    await submit(form)
    expect(text(container)).toContain('Tenhle termín už nestihneme upéct.')
    await type(date, isoDate(3))
    await submit(form)
    expect(readCart()).toMatchObject({ date: isoDate(3), lines: [{ slug: 'daddy-vanilkovy', quantity: 1, inscription: 'Všechno nejlepší, Jano' }] })
  })
})

describe('košík (interakce)', () => {
  const products = allProductSummaries()
  const labels = cartLabels()

  it('prázdný košík nabídne výběr cheesecaku', async () => {
    await mount(<CartView labels={labels} products={products} />)
    expect(text(container)).toContain('Košík je zatím prázdný. Co takhle cheesecake?')
    expect(container.querySelector('a[href="/cheesecaky"]')).not.toBeNull()
  })

  it('položky, součty, validace a odeslání objednávky přes submitOrder', async () => {
    updateCart((s) => addItem(addItem(s, { slug: 'daddy-vanilkovy', quantity: 2, inscription: 'Pro Janu' }), { slug: 'mummy-vanilkovo-ovocny', quantity: 1 }))
    await mount(<CartView labels={labels} products={products} />)
    const body = () => norm(text(container))
    expect(body()).toContain('Daddy vanilkový')
    expect(body()).toContain('1 580 Kč') // 2 × 790
    expect(body()).toContain('2 670 Kč') // mezisoučet 1 580 + 1 090

    // odeslání bez údajů → chyby u polí, nic neodešlo
    await submit(container.querySelector('form'))
    expect(container.querySelectorAll('[aria-invalid=true]').length).toBeGreaterThan(3)
    expect(body()).toContain(MESSAGES.orderConsent)
    expect(readCart().lines).toHaveLength(2)

    // vyplnění
    await click(Array.from(container.querySelectorAll('input[name=doruceni]')).find((r) => (r as HTMLInputElement).value === 'praha')!)
    expect(body()).toContain('2 970 Kč') // + doprava 300
    await type(container.querySelector('#kosik-adresa'), 'Varšavská 1, Praha 2')
    await type(container.querySelector('#kosik-termin'), isoDate(5))
    await type(container.querySelector('#kosik-jmeno'), 'Jana Nováková')
    await type(container.querySelector('#kosik-email'), 'jana@example.cz')
    await type(container.querySelector('#kosik-telefon'), '+420 737 000 000')
    await click(Array.from(container.querySelectorAll('input[name=platba]')).find((r) => (r as HTMLInputElement).value === 'prevod')!)
    await click(container.querySelector('#kosik-souhlas'))
    await submit(container.querySelector('form'))

    expect(text(container.querySelector('h1'))).toBe(microcopy('OBJEDNÁVKA — potvrzení nadpis'))
    expect(body()).toContain('Potvrzení jsme poslali na jana@example.cz')
    expect(body()).toMatch(/Pošlete prosím 2 970 Kč na účet \[DOPLNÍ KLIENT\], variabilní symbol \d+/)
    expect(readCart().lines).toHaveLength(0)
  })

  it('odebrání položky a změna počtu kusů', async () => {
    updateCart((s) => addItem(s, { slug: 'daddy-pistaciovo-malinovy', quantity: 1 }))
    await mount(<CartView labels={labels} products={products} />)
    const qty = container.querySelector<HTMLInputElement>('input[id$="-pocet"]')!
    await type(qty, '3')
    expect(readCart().lines[0].quantity).toBe(3)
    await click(Array.from(container.querySelectorAll('button')).find((b) => text(b).startsWith('Odebrat'))!)
    expect(readCart().lines).toHaveLength(0)
    expect(text(container)).toContain('Košík je zatím prázdný.')
  })
})

describe('submitOrder ze stavu košíku', () => {
  it('validní košík projde serverem a cenu přepočítá z ceníku firmy', async () => {
    const s = addItem(EMPTY_CART, { slug: 'mini-cheesecaky-10-ks', quantity: 2, miniFlavors: flavorsFromCounts({ borůvka: 10 }) })
    const r = await submitOrder({
      items: toOrderItems(s),
      fulfillment: { method: 'vyzvednuti', address: null, date: isoDate(2), note: null },
      customer: { name: 'Jan', email: 'jan@example.cz', phone: '+420 737 000 000' },
      company: null,
      payment: 'karta',
      note: null,
      consent: true,
    })
    expect(r).toMatchObject({ ok: true, subtotal: 1150, delivery: 0, total: 1150, payment: { method: 'karta', redirectUrl: null } })
  })

  it('každý produkt z katalogu má stránku v copy.json', () => {
    for (const slug of CHEESECAKE_SLUGS as readonly CheesecakeSlug[]) expect(KNOWN_PATHS.has(productPath(slug))).toBe(true)
  })
})
