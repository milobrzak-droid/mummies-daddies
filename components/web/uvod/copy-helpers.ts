/**
 * Čisté pomocné funkce pro texty úvodu a kontaktu (bez JSON importů →
 * bezpečné pro server i klienta, snadno testovatelné). Texty NEMĚNÍ, jen je
 * rozdělí na části, které se vykreslí zvlášť (popis × cena × minimum osob).
 */

const NBSP = ' '

/** „1 290 Kč“ → „1 290 Kč“ s nezlomitelnými mezerami (cena se nezalomí). */
export function keepTogether(text: string): string {
  return text.replace(/(\d) (?=\d)/g, `$1${NBSP}`).replace(/(\d) (?=Kč)/g, `$1${NBSP}`)
}

export interface EventCardText {
  /** Věta(y) popisu. */
  description: string
  /** „Od [DOPLNÍ KLIENT] Kč/os.“ (nebo null, když text cenu nemá). */
  price: string | null
  /** „od 4 osob“ / „minimum podle objednávky“ (nebo null). */
  minimum: string | null
}

const PRICE_RE = /(?:^|\s)(Od\s.+?Kč\/os\.)/

/**
 * Text karty typu akce z copy:
 *   "Obědy do kanceláře, porady, konference i večírky. Od [DOPLNÍ KLIENT] Kč/os. · od 4 osob"
 *   → { description: "Obědy do kanceláře, porady, konference i večírky.", price: "Od [DOPLNÍ KLIENT] Kč/os.", minimum: "od 4 osob" }
 */
export function splitEventCardText(text: string): EventCardText {
  const m = PRICE_RE.exec(text)
  if (!m) {
    const [description, ...rest] = text.split(/\s+·\s+/)
    return { description: description.trim(), price: null, minimum: rest.join(' · ').trim() || null }
  }
  const start = m.index + (m[0].length - m[1].length)
  const description = text.slice(0, start).trim()
  const after = text.slice(start + m[1].length).trim()
  const minimum = after.replace(/^·\s*/, '').trim()
  return { description, price: m[1].trim(), minimum: minimum || null }
}

/** Poslední segment cesty: "/catering/firemni" → "firemni". */
export function lastSegment(href: string | null | undefined): string | null {
  if (!href) return null
  const seg = href.split('?')[0].replace(/\/+$/, '').split('/').pop()
  return seg || null
}

/** „1. Řeknete nám o akci“ → { n: 1, title: "Řeknete nám o akci" } (číslo vykreslí <ol>). */
export function splitStepNumber(title: string): { n: number | null; title: string } {
  const m = /^(\d+)\.\s+(.+)$/.exec(title.trim())
  return m ? { n: Number(m[1]), title: m[2] } : { n: null, title: title.trim() }
}

/**
 * Produkt z copy cheesecaků:
 *   "Daddy vanilkový — vanilka a máslové sušenky · 790 Kč" → { name, note, price: "790 Kč" }
 *   "Daddy pistáciovo-malinový · 1 290 Kč"                  → { name, note: null, price }
 */
export function splitProduct(raw: string): { name: string; note: string | null; price: string | null } {
  const parts = raw.split(/\s+·\s+/)
  const last = parts[parts.length - 1]
  const price = parts.length > 1 && /Kč\s*$/.test(last) ? last.trim() : null
  const head = (price ? parts.slice(0, -1) : parts).join(' · ')
  const dash = head.indexOf(' — ')
  return dash > 0 ? { name: head.slice(0, dash).trim(), note: head.slice(dash + 3).trim(), price } : { name: head.trim(), note: null, price }
}

export type ContactLine = { kind: 'phone'; text: string; href: string } | { kind: 'email'; text: string; href: string } | { kind: 'text'; text: string }

/** Řádek kontaktu: telefon → tel:, e-mail → mailto:, jinak text. */
export function contactLine(text: string): ContactLine {
  const t = text.trim()
  if (/^\+?\d[\d\s]{7,}$/.test(t)) return { kind: 'phone', text: t, href: `tel:${t.replace(/\s+/g, '')}` }
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(t)) return { kind: 'email', text: t, href: `mailto:${t}` }
  return { kind: 'text', text: t }
}
