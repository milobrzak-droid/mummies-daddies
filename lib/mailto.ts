// Bezpečný `mailto:` odkaz z e-mailu uloženého v datech.
//
// E-mail kontaktu může přijít zvenku (import, ARES, zápis schůzky). Adresa typu
// `a@b.cz?bcc=cizi@example.com&body=…` by po vložení do `mailto:` přenesla
// parametry (skrytou kopii, předvyplněné tělo). Proto jen prostá adresa bez
// `? & # = % / :` a mezer; cokoli jiného se nevykreslí jako odkaz (zobrazí
// se jen jako text).

const LOCAL = /^[\p{L}\p{N}._+'-]{1,64}$/u
const DOMAIN_LABEL = /^[\p{L}\p{N}](?:[\p{L}\p{N}-]{0,61}[\p{L}\p{N}])?$/u

export function plainEmailAddress(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  if (value.length === 0 || value.length > 254) return null
  const at = value.indexOf('@')
  if (at < 1 || at !== value.lastIndexOf('@')) return null
  const local = value.slice(0, at)
  const labels = value.slice(at + 1).split('.')
  if (!LOCAL.test(local)) return null
  if (labels.length < 2 || labels.some((l) => !DOMAIN_LABEL.test(l))) return null
  if (labels[labels.length - 1].length < 2) return null
  return value
}

/** `mailto:adresa` nebo null, když adresa není prostá. Parametry se nikdy nepřenášejí. */
export function safeMailtoHref(raw: string | null | undefined): string | null {
  const addr = plainEmailAddress(raw)
  return addr ? `mailto:${addr}` : null
}
