/**
 * Zástupci „[DOPLNÍ KLIENT: …]“ v textech. Bez závislostí → i pro klienta.
 * Re-exportuje lib/web/content.ts.
 */

export const CLIENT_PLACEHOLDER = /\[DOPLNÍ KLIENT(?::[^\]]*)?\]/g

/** Obsahuje text zástupce „[DOPLNÍ KLIENT…]“? */
export function hasClientPlaceholder(text: string | null | undefined): boolean {
  return !!text && /\[DOPLNÍ KLIENT/.test(text)
}

/** Rozdělí text na úseky (pro vykreslení zástupců). */
export function splitPlaceholders(text: string): { text: string; placeholder: boolean }[] {
  const out: { text: string; placeholder: boolean }[] = []
  let last = 0
  for (const m of text.matchAll(CLIENT_PLACEHOLDER)) {
    const i = m.index ?? 0
    if (i > last) out.push({ text: text.slice(last, i), placeholder: false })
    out.push({ text: m[0], placeholder: true })
    last = i + m[0].length
  }
  if (last < text.length) out.push({ text: text.slice(last), placeholder: false })
  return out
}

/** Text pro meta tagy / alt: zástupce vypustí (do <title> a description nepatří). */
export function stripPlaceholders(text: string): string {
  return text.replace(CLIENT_PLACEHOLDER, '').replace(/\s{2,}/g, ' ').replace(/\s+([.,])/g, '$1').replace(/(·\s*){2,}/g, '· ').trim()
}


/**
 * České typografické pravidlo: jednopísmenné předložky a spojky (v, s, k, z, u, o, a, i)
 * nesmí zůstat na konci řádku a číslo se neodtrhne od následujícího slova („do 1 pracovního
 * dne“). Vloží nezlomitelné mezery (U+00A0). Čtečky i vyhledávače je čtou jako mezeru.
 */
export function czechNbsp(text: string): string {
  if (!text) return text
  let out = text
  // Dvakrát kvůli řetězení („a v Praze“, „s i bez“).
  for (let i = 0; i < 2; i++) out = out.replace(/(^|[\s(„“"'–—/])([vVsSkKzZuUoOaAiI])[ \t]+(?=\S)/g, '$1$2\u00A0')
  // Rozpětí „300–2 000“ se nezalomí u pomlčky (U+2060 word joiner).
  return out.replace(/(\d)[ \t]+(?=[\p{L}\d%])/gu, '$1\u00A0').replace(/(\d)–(?=\d)/g, '$1\u2060–\u2060')
}
