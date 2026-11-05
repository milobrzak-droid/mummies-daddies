/**
 * Čisté pomocné funkce pro stránky cateringu (bez JSON, bez node:fs → bezpečné
 * i pro klienta a pro testy). Texty NIKDY nepřepisují: jen je dělí na části,
 * které se pak vykreslí s jiným stylem (cena malinově, minimum jako štítek).
 */
import { INQUIRY_PATH, inquiryHref } from '@/lib/web/inquiry-link'
import { CUSTOMER_KINDS, EVENT_TYPES, EXTRAS, type CustomerKind, type EventType, type Extra } from '@/lib/web/options'

// ── cena a minimum osob v textu ─────────────────────────────────────────────

/** „od [DOPLNÍ KLIENT] Kč/os.“, „Od 300 Kč/os.“ (i s nezlomitelnou mezerou). */
const PRICE = /[Oo]d\s(?:\[DOPLNÍ KLIENT(?::[^\]]*)?\]|\d[\d\s ]*)\s?Kč\/os\./
/** „od 4 osob“, „Od 15 osob“, „8 až 30 osob“, „minimum podle objednávky“, „minimum [DOPLNÍ KLIENT]“. */
const GUESTS = /(?:[Oo]d\s\d+\sosob|\d+\saž\s\d+\sosob|minimum\s(?:podle objednávky|\[DOPLNÍ KLIENT(?::[^\]]*)?\]))/

export interface PriceFacts {
  /** Text ceny doslova („od [DOPLNÍ KLIENT] Kč/os.“), nebo null. */
  price: string | null
  /** Minimum / rozsah osob doslova („od 4 osob“), nebo null. */
  guests: string | null
  /** Zbytek textu (popis) bez ceny a minima, nebo prázdný řetězec. */
  rest: string
}

/**
 * Vytáhne z textu cenu a minimum osob, zbytek vrátí jako popis.
 *   "od 4 osob · od [DOPLNÍ KLIENT] Kč/os. Čerstvé sendviče…"
 *     → { guests: "od 4 osob", price: "od [DOPLNÍ KLIENT] Kč/os.", rest: "Čerstvé sendviče…" }
 *   "Krátká přestávka na 15 až 45 minut. Od 15 osob · od [DOPLNÍ KLIENT] Kč/os."
 *     → { guests: "Od 15 osob", price: "od … Kč/os.", rest: "Krátká přestávka na 15 až 45 minut." }
 * Spojka „ · “ mezi minimem a cenou se zahodí (je jen oddělovač).
 */
export function splitPriceFacts(text: string): PriceFacts {
  let rest = text
  const priceMatch = PRICE.exec(rest)
  const price = priceMatch ? priceMatch[0] : null
  if (priceMatch) rest = rest.slice(0, priceMatch.index) + ' ' + rest.slice(priceMatch.index + priceMatch[0].length)
  const guestsMatch = GUESTS.exec(rest)
  const guests = guestsMatch ? guestsMatch[0] : null
  if (guestsMatch) rest = rest.slice(0, guestsMatch.index) + ' ' + rest.slice(guestsMatch.index + guestsMatch[0].length)
  // Vyjmuté části nechaly dvojité mezery; „·“ mezi nimi byl jen oddělovač.
  rest = rest
    .replace(/\s{2,}·\s{2,}/g, ' ')
    .replace(/^\s*·\s*/, '')
    .replace(/\s*·\s*$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
  return { price, guests, rest }
}

// ── položky ─────────────────────────────────────────────────────────────────

/** "1. Představa" → { n: 1, title: "Představa" }; bez čísla n = null. */
export function splitStepNumber(title: string): { n: number | null; title: string } {
  const m = /^(\d+)\.\s+(.+)$/.exec(title.trim())
  return m ? { n: Number(m[1]), title: m[2] } : { n: null, title: title.trim() }
}

/** CTA s více odkazy oddělenými „ · “ (svatby) → jednotlivé řetězce „Text → /cesta“. */
export function splitCtas(raw: string | undefined): string[] {
  if (!raw) return []
  return raw.split(/\s+·\s+(?=[^·]*→)/).map((s) => s.trim()).filter(Boolean)
}

/** Části textu: obyčejný text a interní cesty („Více na /catering/teambuilding.“). */
export function splitInternalLinks(text: string): { text: string; href: string | null }[] {
  const out: { text: string; href: string | null }[] = []
  const re = /(^|\s)(\/[a-z0-9-]+(?:\/[a-z0-9-]+)*)(?=[.,;:!?)]?(?:\s|$))/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text))) {
    const start = m.index + m[1].length
    if (start > last) out.push({ text: text.slice(last, start), href: null })
    out.push({ text: m[2], href: m[2] })
    last = start + m[2].length
  }
  if (last < text.length) out.push({ text: text.slice(last), href: null })
  return out
}

// ── kontext v odkazech na poptávku ──────────────────────────────────────────

function oneOf<T extends string>(list: readonly { value: string }[], v: string | null): T | undefined {
  return v && list.some((o) => o.value === v) ? (v as T) : undefined
}

/**
 * Doplní odkazu na /poptavka kontext stránky (strategy.conversion: „Všechna CTA
 * nesou kontext“): typ akce (když ho copy neuvádí) a zdroj. Co je v odkazu z copy,
 * má přednost. Jiné odkazy vrací beze změny.
 *   contextHref('/poptavka?segment=firma', { typ: 'firemni', zdroj: '/catering/firemni' })
 *     → '/poptavka?typ=firemni&segment=firma&zdroj=%2Fcatering%2Ffiremni'
 */
export function contextHref(href: string, ctx: { typ?: EventType; zdroj: string }): string {
  const [pathname, query = ''] = href.split('?')
  if (pathname !== INQUIRY_PATH) return href
  const q = new URLSearchParams(query)
  const osob = Number(q.get('osob'))
  return inquiryHref({
    typ: oneOf<EventType>(EVENT_TYPES, q.get('typ')) ?? ctx.typ,
    segment: oneOf<CustomerKind>(CUSTOMER_KINDS, q.get('segment')),
    osob: Number.isFinite(osob) && osob > 0 ? osob : undefined,
    datum: q.get('datum') ?? undefined,
    zdroj: q.get('zdroj') ?? ctx.zdroj,
    vzor: q.get('vzor') ?? undefined,
    prostor: q.get('prostor') ?? undefined,
    doplnek: q.getAll('doplnek').filter((d): d is Extra => EXTRAS.some((e) => e.value === d)),
  })
}
