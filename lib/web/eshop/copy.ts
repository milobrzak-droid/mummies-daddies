/**
 * Texty a data stránek e-shopu (/cheesecaky, /cheesecaky/[slug], /kosik, /darkovy-poukaz)
 * složené z copy.json (doslova) a číselníků. SERVER-ONLY (přes content.ts a photos.ts
 * čte JSON a node:fs); klientské komponenty dostanou výsledek v props.
 */
import { COMPANY } from '../company'
import { getPage, getSection, microcopy, microcopyList, parseCta, parseItem, splitDots, type SectionCopy } from '../content'
import { inquiryHref } from '../inquiry-link'
import { LEGAL_LINKS, FOOTER_COLUMNS } from '../navigation'
import { CHEESECAKES, DELIVERY_METHODS, MINI_FLAVORS, PAYMENT_METHODS, cheesecakeOf, type CheesecakeSlug, type MiniFlavor } from '../options'
import { getPhoto } from '../photos'
import { CART_PATH, CHEESECAKE_PATH, PRODUCT_TONE, VOUCHER_PATH, productByName, productPath, productPhotoSlot } from './catalog'
import type { CartLabels, ConfiguratorLabels, EshopLink, ProductSummary, VoucherLabels } from './types'
import { VOUCHER_MESSAGES } from './voucher'

// ── ceny v textu ────────────────────────────────────────────────────────────

/** „790 Kč“, „1 290 Kč“ (běžná i nedělitelná mezera), volitelně se zástupcem za cenou. */
const PRICE_PART = /^\d{1,3}(?:[\s ]\d{3})*[\s ]Kč(?:\s\[DOPLNÍ KLIENT[^\]]*\])?$/
const PRICE_IN_TEXT = /\s*(\d{1,3}(?:[  ]\d{3})*[  ]Kč(?: \[DOPLNÍ KLIENT[^\]]*\])?)\.?/

export function isPriceText(text: string): boolean {
  return PRICE_PART.test(text.trim())
}

/**
 * Vyjme z odstavce první cenu („… sušenek. 790 Kč.“ → text bez ceny + „790 Kč“),
 * aby se cena dala ukázat jako PriceTag a v textu nebyla dvakrát. Zbytek textu zůstává doslova.
 */
export function extractPrice(body: string): { text: string; price: string | null } {
  const m = PRICE_IN_TEXT.exec(body)
  if (!m) return { text: body, price: null }
  const text = (body.slice(0, m.index) + ' ' + body.slice(m.index + m[0].length)).replace(/\s{2,}/g, ' ').trim()
  return { text, price: m[1] }
}

// ── produkty ────────────────────────────────────────────────────────────────

const PRODUCT_ITEMS = () => getSection(CHEESECAKE_PATH, 'produkty').items ?? []

/** Popis a cena z karty v katalogu („Daddy vanilkový — vanilka a máslové sušenky · 790 Kč“). */
function catalogItem(name: string): { description: string | null; price: string | null } | null {
  for (const raw of PRODUCT_ITEMS()) {
    const it = parseItem(raw)
    if (it.title !== name) continue
    const parts = splitDots(it.text)
    const price = parts.find(isPriceText) ?? null
    const rest = parts.filter((p) => !isPriceText(p))
    return { description: rest.length ? rest.join(' · ') : null, price }
  }
  return null
}

function detailPrice(slug: CheesecakeSlug): string | null {
  const popis = getSection(productPath(slug), 'popis')
  return extractPrice(popis.body).price
}

export function productSummary(slug: CheesecakeSlug): ProductSummary {
  const c = cheesecakeOf(slug)!
  const priceText = catalogItem(c.name)?.price ?? detailPrice(slug) ?? ''
  return {
    slug,
    name: c.name,
    price: c.price,
    priceText,
    href: productPath(slug),
    tone: PRODUCT_TONE[slug],
    photo: getPhoto(productPhotoSlot(slug)),
  }
}

export function allProductSummaries(): Record<CheesecakeSlug, ProductSummary> {
  return Object.fromEntries(CHEESECAKES.map((c) => [c.slug, productSummary(c.slug)])) as Record<CheesecakeSlug, ProductSummary>
}

/** Text doprava/parametry: „Praha — 300 Kč“ / „Průměr: [DOPLNÍ KLIENT]“ → term + hodnota. */
export function termItems(items: string[] | undefined): { term: string; value: string; isPrice: boolean }[] {
  return (items ?? []).map((raw) => {
    const it = parseItem(raw)
    const term = it.title ?? it.label ?? raw
    const value = it.title || it.label ? it.text : ''
    return { term, value, isPrice: isPriceText(value) }
  })
}

function link(raw: string | undefined, fallbackHref: string): EshopLink | null {
  if (!raw) return null
  const c = parseCta(raw)
  return { label: c.label, href: c.href ?? fallbackHref }
}

/** CTA na poptávku dostane i zdroj (odkud návštěvník přišel). */
function withSource(l: EshopLink | null, source: string): EshopLink | null {
  if (!l) return null
  if (!l.href.startsWith('/poptavka')) return l
  const url = new URL(l.href, 'https://x.invalid')
  if (!url.searchParams.has('zdroj')) url.searchParams.set('zdroj', source)
  return { label: l.label, href: `${url.pathname}?${url.searchParams.toString()}` }
}

function addToCartLabel(): string {
  // Primární CTA produktu je v copy jen u Daddy vanilkového („Přidat do košíku“); platí pro všechny.
  const withCta = CHEESECAKES.map((c) => getPage(productPath(c.slug)).cta).find(Boolean)
  return withCta ?? 'Přidat do košíku'
}

// ── /cheesecaky ─────────────────────────────────────────────────────────────

export interface CatalogCard extends ProductSummary {
  description: string | null
}

export function catalogPageData() {
  const path = CHEESECAKE_PATH
  const uvod = getSection(path, 'uvod')
  const products: CatalogCard[] = PRODUCT_ITEMS().flatMap((raw) => {
    const it = parseItem(raw)
    const c = it.title ? productByName(it.title) : undefined
    if (!c) return []
    const info = catalogItem(c.name)
    const summary = productSummary(c.slug)
    return [{ ...summary, priceText: info?.price ?? summary.priceText, description: info?.description ?? null }]
  })
  const seasonal = CHEESECAKES.find((c) => c.seasonal)
  const sezona = getSection(path, 'sezona')
  const seasonalBody = extractPrice(sezona.body)
  const mini = getSection(path, 'mini')
  const naAkci = getSection(path, 'na-akci')
  const poukaz = getSection(path, 'poukaz')
  return {
    uvod,
    heroPhoto: getPhoto('cheesecaky.hero'),
    produkty: getSection(path, 'produkty'),
    products,
    mini: { section: mini, product: productSummary('mini-cheesecaky-10-ks') },
    naPrani: getSection(path, 'na-prani'),
    sezona: {
      section: sezona,
      text: seasonalBody.text,
      price: seasonalBody.price,
      product: seasonal ? productSummary(seasonal.slug) : null,
    },
    doprava: { section: getSection(path, 'doprava'), items: termItems(getSection(path, 'doprava').items) },
    naAkci: { section: naAkci, cta: withSource(link(naAkci.cta, inquiryHref({ doplnek: 'cheesecaky' })), path), photo: getPhoto('cheesecaky.na-akci-banner') },
    poukaz: { section: poukaz, cta: link(poukaz.cta, VOUCHER_PATH) },
    addLabel: addToCartLabel(),
    added: microcopy('KOŠÍK — přidáno'),
    goToCart: { label: microcopyList('KOŠÍK — tlačítka po přidání')[1] ?? 'Přejít do košíku', href: CART_PATH },
  }
}

// ── /cheesecaky/[slug] ──────────────────────────────────────────────────────

export interface RelatedCard {
  key: string
  title: string
  href: string
  product: ProductSummary | null
}

function flavorOptions(): { value: MiniFlavor; label: string }[] {
  const labels = getSection(productPath('mini-cheesecaky-10-ks'), 'volby').items ?? []
  return MINI_FLAVORS.map((value) => ({
    value,
    label: labels.find((l) => l.toLowerCase() === value.toLowerCase()) ?? value,
  }))
}

export function configuratorLabels(slug: CheesecakeSlug): ConfiguratorLabels {
  const volby = getPage(productPath(slug)).sections.find((s) => s.id === 'volby')
  const after = microcopyList('KOŠÍK — tlačítka po přidání')
  return {
    add: addToCartLabel(),
    quantity: microcopy('KOŠÍK — množství'),
    inscription: microcopy('KOŠÍK — nápis'),
    inscriptionCounter: microcopy('KOŠÍK — nápis počítadlo'),
    inscriptionError: microcopy('KOŠÍK — chyba nápis'),
    optionsHeading: volby?.heading ?? null,
    optionsBody: volby?.body || null,
    flavorsRemaining: microcopy('KOŠÍK — příchutě mini'),
    flavorsError: microcopy('KOŠÍK — chyba příchutě'),
    flavors: flavorOptions(),
    date: microcopy('KOŠÍK — termín'),
    dateError: microcopy('KOŠÍK — chyba termín'),
    added: microcopy('KOŠÍK — přidáno'),
    continueShopping: { label: after[0] ?? 'Pokračovat v nákupu', href: CHEESECAKE_PATH },
    goToCart: { label: after[1] ?? 'Přejít do košíku', href: CART_PATH },
  }
}

export function productPageData(slug: CheesecakeSlug) {
  const path = productPath(slug)
  const page = getPage(path)
  const find = (id: string): SectionCopy | undefined => page.sections.find((s) => s.id === id)
  const popis = find('popis')!
  const { text, price } = extractPrice(popis.body)
  const summary = productSummary(slug)
  const related: RelatedCard[] = (find('souvisejici')?.items ?? []).map((raw) => {
    const it = parseItem(raw)
    const title = it.title ?? it.text
    const p = productByName(title)
    if (p) return { key: p.slug, title: p.name, href: productPath(p.slug), product: productSummary(p.slug) }
    return { key: raw, title, href: it.href ?? CHEESECAKE_PATH, product: null }
  })
  const naAkci = find('na-akci')
  const firmy = find('firmy')
  return {
    page,
    product: summary,
    heading: popis.heading,
    description: text,
    priceText: price ?? summary.priceText,
    seasonal: cheesecakeOf(slug)?.seasonal ?? false,
    parametry: find('parametry') ? { section: find('parametry')!, items: termItems(find('parametry')!.items) } : null,
    doprava: find('doprava') ?? null,
    related: { section: find('souvisejici') ?? null, items: related },
    naAkci: naAkci ? { section: naAkci, cta: withSource(link(naAkci.cta, inquiryHref({ doplnek: 'cheesecaky' })), path) } : null,
    firmy: firmy ? { section: firmy, cta: link(firmy.cta, '/vanoce') } : null,
    labels: configuratorLabels(slug),
  }
}

// ── /kosik ──────────────────────────────────────────────────────────────────

function legalLinks(): EshopLink[] {
  return LEGAL_LINKS.filter((l) => l.href !== '/cookies').map(({ label, href }) => ({ label, href }))
}

export function cartLabels(): CartLabels {
  const path = CART_PATH
  const polozky = getSection(path, 'polozky')
  const doruceni = getSection(path, 'doruceni')
  const kontakt = getSection(path, 'kontakt')
  const platba = getSection(path, 'platba')
  const souhlas = getSection(path, 'souhlas')
  const deliveryLabels = microcopyList('KOŠÍK — možnosti doručení')
  const pickupNote = (doruceni.items ?? []).map(parseItem).find((i) => i.title === 'Osobní vyzvednutí')?.text ?? null
  return {
    heading: polozky.heading,
    lead: polozky.body,
    empty: microcopy('KOŠÍK — prázdný'),
    emptyCta: { label: microcopy('KOŠÍK — tlačítko prázdný'), href: CHEESECAKE_PATH },
    remove: microcopy('KOŠÍK — odebrat'),
    quantity: microcopy('KOŠÍK — množství'),
    inscription: microcopy('KOŠÍK — nápis'),
    inscriptionCounter: microcopy('KOŠÍK — nápis počítadlo'),
    inscriptionError: microcopy('KOŠÍK — chyba nápis'),
    flavorsError: microcopy('KOŠÍK — chyba příchutě'),
    flavors: flavorOptions(),
    subtotal: microcopy('KOŠÍK — mezisoučet'),
    delivery: microcopy('KOŠÍK — doprava'),
    total: microcopy('KOŠÍK — celkem'),
    deliveryHeading: doruceni.heading,
    deliveryBody: doruceni.body,
    deliveryLegend: microcopy('KOŠÍK — způsob doručení'),
    deliveryOptions: DELIVERY_METHODS.map((d, i) => ({
      value: d.value,
      label: deliveryLabels[i] ?? d.label,
      price: d.price,
      note: d.value === 'vyzvednuti' ? pickupNote : null,
    })),
    address: microcopy('POPTÁVKA — pole Místo'),
    date: microcopy('KOŠÍK — termín'),
    dateError: microcopy('KOŠÍK — chyba termín'),
    contactHeading: kontakt.heading,
    contactBody: kontakt.body,
    name: microcopy('POPTÁVKA — pole Jméno'),
    email: microcopy('POPTÁVKA — pole E-mail'),
    phone: microcopy('POPTÁVKA — pole Telefon'),
    phoneHint: microcopy('POPTÁVKA — nápověda k telefonu'),
    company: microcopy('KOŠÍK — fakturace'),
    companyName: microcopy('POPTÁVKA — pole Firma'),
    ico: microcopy('POPTÁVKA — pole IČO'),
    paymentHeading: platba.heading,
    paymentBody: platba.body,
    paymentLegend: microcopy('KOŠÍK — platba'),
    paymentOptions: PAYMENT_METHODS.map((p) => ({ value: p.value, label: p.label })),
    consentHeading: souhlas.heading,
    consentBody: souhlas.body,
    consent: microcopy('KOŠÍK — souhlas'),
    legal: legalLinks(),
    submit: souhlas.cta ? parseCta(souhlas.cta).label : microcopy('KOŠÍK — tlačítko'),
    sending: microcopy('POPTÁVKA — tlačítko během odesílání'),
    offline: microcopy('CHYBA — výpadek spojení'),
    upsell: { label: microcopy('KOŠÍK — upsell'), href: inquiryHref({ doplnek: 'cheesecaky', zdroj: path }) },
    confirmationHeading: microcopy('OBJEDNÁVKA — potvrzení nadpis'),
    confirmationText: microcopy('OBJEDNÁVKA — potvrzení text'),
    transferText: microcopy('OBJEDNÁVKA — převod'),
  }
}

// ── /darkovy-poukaz ─────────────────────────────────────────────────────────

/** „1 000 Kč“ → 1000; „Vlastní částka“ → null. */
export function parseVoucherValue(label: string): number | null {
  if (!isPriceText(label)) return null
  return Number(label.replace(/[^\d]/g, ''))
}

export function voucherPageData() {
  const path = VOUCHER_PATH
  const hodnoty = getSection(path, 'hodnoty')
  const personalizace = getSection(path, 'personalizace')
  const platnost = getSection(path, 'platnost')
  const previewTitle =
    FOOTER_COLUMNS.flatMap((c) => c.links).find((l) => l.href === VOUCHER_PATH)?.label ?? getPage(path).metaTitle
  const labels: VoucherLabels = {
    valuesHeading: hodnoty.heading,
    valuesLegend: microcopy('POUKAZ — hodnota'),
    presets: (hodnoty.items ?? []).map((label) => ({ amount: parseVoucherValue(label), label })),
    custom: microcopy('POUKAZ — vlastní částka'),
    amountError: microcopy('POUKAZ — chyba částka') || VOUCHER_MESSAGES.amount,
    personalHeading: personalizace.heading,
    personalBody: personalizace.body,
    recipient: microcopy('POUKAZ — jméno obdarovaného'),
    message: microcopy('POUKAZ — vzkaz'),
    email: microcopy('POUKAZ — doručení'),
    paymentLegend: microcopy('KOŠÍK — platba'),
    paymentBody: getSection(CART_PATH, 'platba').body,
    paymentOptions: PAYMENT_METHODS.map((p) => ({ value: p.value, label: p.label })),
    consent: microcopy('KOŠÍK — souhlas'),
    legal: legalLinks(),
    submit: platnost.cta ? parseCta(platnost.cta).label : microcopy('POUKAZ — tlačítko'),
    sending: microcopy('POPTÁVKA — tlačítko během odesílání'),
    offline: microcopy('CHYBA — výpadek spojení'),
    confirmation: microcopy('POUKAZ — potvrzení'),
    transferText: microcopy('OBJEDNÁVKA — převod'),
    previewTitle,
    brand: COMPANY.brand,
  }
  return {
    uvod: getSection(path, 'uvod'),
    uplatneni: getSection(path, 'uplatneni'),
    platnost,
    labels,
  }
}
