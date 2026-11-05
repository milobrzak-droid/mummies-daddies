/** Formátování pro češtinu (bez závislostí, bezpečné pro klienta). */

const NBSP = ' '

/** 1290 → "1 290 Kč" (nedělitelné mezery). */
export function formatCzk(value: number): string {
  const n = Math.round(value)
  const digits = Math.abs(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, NBSP)
  return `${n < 0 ? '−' : ''}${digits}${NBSP}Kč`
}

/** 1290 → "1 290" (bez měny). */
export function formatNumber(value: number): string {
  return Math.round(value).toString().replace(/\B(?=(\d{3})+(?!\d))/g, NBSP)
}

/** Skloňování: plural(3, ['osoba','osoby','osob']) → "osoby". */
export function plural(n: number, forms: readonly [string, string, string]): string {
  if (n === 1) return forms[0]
  if (n >= 2 && n <= 4) return forms[1]
  return forms[2]
}

/** "2026-12-24" → "24. 12. 2026". */
export function formatDate(iso: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso)
  if (!m) return iso
  return `${Number(m[3])}.${NBSP}${Number(m[2])}.${NBSP}${m[1]}`
}

/** Dnešní datum (místní čas) jako YYYY-MM-DD, posunuté o `addDays`. */
export function isoDate(addDays = 0, now = new Date()): string {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + addDays)
  const p = (x: number) => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** Telefon do odkazu tel: ("+420 737 818 694" → "tel:+420737818694"). */
export function telHref(phone: string): string {
  return `tel:${phone.replace(/[^\d+]/g, '')}`
}
