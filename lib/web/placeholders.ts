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

