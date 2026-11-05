const czk = new Intl.NumberFormat('cs-CZ', {
  style: 'currency', currency: 'CZK', maximumFractionDigits: 0,
})
// Intl inserts a no-break space (code point 0xa0) or narrow no-break space (0x202f)
// as a thousands/currency separator depending on ICU version; normalize both to a
// regular space for stable output/tests. Built from char codes (not literal
// characters) so the source can't be silently corrupted by copy/paste or editors.
const NBSP_CHARS = String.fromCharCode(0xa0) + String.fromCharCode(0x202f)
const NBSP_RE = new RegExp(`[${NBSP_CHARS}]`, 'g')

export function formatCzk(v: number | string | null | undefined): string {
  if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) return '—'
  const n = typeof v === 'string' ? Number(v) : v
  if (Number.isNaN(n)) return '—'
  return czk.format(n).replace(NBSP_RE, ' ')
}
/** Cena z nabídky v měně nabídky (před přepočtem): „120 000 Kč", „3 500 EUR"; bez ceny „cena chybí". */
export function formatOfferPrice(amount: number | null | undefined, currency: 'CZK' | 'EUR' | string): string {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return 'cena chybí'
  if (currency === 'EUR') {
    return `${new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 2 }).format(amount).replace(NBSP_RE, ' ')} EUR`
  }
  return formatCzk(amount)
}
export function formatPct(v: number | string | null | undefined): string {
  if (v === null || v === undefined || v === '') return '—'
  const n = typeof v === 'string' ? Number(v) : v
  if (Number.isNaN(n)) return '—'
  return `${n} %`
}
// Percentage points (adoption delta). Number() drops trailing zeros so a
// numeric "61.00" from Postgres renders as "61 pp", matching formatPct's style.
export function formatPp(v: number | string | null | undefined): string {
  if (v === null || v === undefined || v === '') return '—'
  const n = typeof v === 'string' ? Number(v) : v
  if (Number.isNaN(n)) return '—'
  return `${n} pp`
}
export function formatDate(v: string | null | undefined): string {
  if (!v) return '—'
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return '—'
  return d.toLocaleDateString('cs-CZ').replace(NBSP_RE, ' ')
}

// Zkrácený zápis pro dlaždice na dashboardu. „4 364 300 Kč" se do úzké
// karty nevejde a zalomí se doprostřed čísla; „4,36 mil. Kč" se přečte
// na první pohled. Přesnou částku drží popisek pod ním.
export function formatCzkShort(v: number | string | null | undefined): string {
  if (v === null || v === undefined || v === '') return '—'
  const n = typeof v === 'string' ? Number(v) : v
  if (Number.isNaN(n)) return '—'
  // Jednotku volíme až po zaokrouhlení, aby 999 999 nebylo „1000 tis. Kč"
  // a 9 999 999 nebylo „10,00 mil. Kč".
  const abs = Math.abs(n)
  const tis = Math.round(abs / 1000)
  if (tis >= 1000) {
    const milAbs = abs / 1_000_000
    const decimals = Number(milAbs.toFixed(2)) >= 10 ? 0 : 2
    const mil = (n / 1_000_000).toFixed(decimals)
    return `${mil.replace('.', ',')} mil. Kč`
  }
  if (abs >= 100_000) return `${Math.round(n / 1000)} tis. Kč`
  return formatCzk(n)
}

// Zobrazované jméno osoby (typicky team_member): DB trigger při vzniku účtu
// nastaví full_name na e-mail, dokud si člověk jméno sám nezmění (viz
// lib/actions/settings.ts a lib/actions/team.ts). Takové "jméno" (rovné
// e-mailu) nechceme ukazovat doslova — místo toho vezmeme lokální část
// e-mailu a první písmeno zvelikíme, např. "viktor@mummiesdaddies.com" → "Viktor".
export function formatPersonName(fullName: string | null | undefined, email: string | null | undefined): string {
  const name = (fullName ?? '').trim()
  const mail = (email ?? '').trim()
  if (name && name.toLowerCase() !== mail.toLowerCase()) return name
  const local = mail.split('@')[0] ?? ''
  if (!local) return name || mail || '—'
  return local[0].toUpperCase() + local.slice(1)
}
