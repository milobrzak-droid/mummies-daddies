import { COCKPIT_HOME } from '@/lib/routes'

// Bezpečný cíl přesměrování po přihlášení / ověření e-mailu.
//
// Bere jen cestu v rámci naší appky. Ruční kontrola `startsWith('/')` nestačí:
// `//evil.com` i `/\evil.com` prohlížeč vyhodnotí jako protokol-relativní URL
// na cizí doménu a `@evil.com` přilepené za origin (`https://app@evil.com`)
// udělá z originu uživatelské jméno. Proto necháme URL rozparsovat a
// porovnáme origin.
export function safeNext(raw: unknown, origin: string, fallback = COCKPIT_HOME): string {
  if (typeof raw !== 'string' || raw === '') return fallback
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.includes('\\')) return fallback
  // Řídicí znaky (tab, nový řádek) prohlížeče z URL tiše mažou — `/\t/evil.com`
  // by se pak změnilo na `//evil.com`.
  if (/[\u0000-\u001f\u007f]/.test(raw)) return fallback
  let url: URL
  try {
    url = new URL(raw, origin)
  } catch {
    return fallback
  }
  if (url.origin !== new URL(origin).origin) return fallback
  if (!url.pathname.startsWith('/') || url.pathname.startsWith('//')) return fallback
  return `${url.pathname}${url.search}${url.hash}`
}
