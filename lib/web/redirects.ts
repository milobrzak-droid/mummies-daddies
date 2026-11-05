/**
 * Přesměrování starých URL (Wix, cs.mummiesdaddies.com) na nový web podle
 * strategy.redirects. Používá next.config.ts → redirects(). Jen relativní
 * importy a JSON (žádný alias @/, žádné next/*), aby šel načíst i z configu.
 *
 * Pravidla čtení řádků strategie:
 *   „/a → /b“                         → /a → /b
 *   „/a, /b/*, /c → /“                → víc zdrojů, „*“ = celá podcesta (:path*)
 *   „/x (poznámka) → /y (jinak /z)“   → závorky se ignorují; „jinak /z“ vyhrává
 *                                       (např. BVLGARI jen po schválení klientem)
 *   cíl /blog/<slug>, který na webu není → /blog (článek zatím nemá text)
 *   adresa s diakritikou                → v původní i procentové podobě
 * Řádky, které nezačínají „/“ (popisy bez konkrétní staré adresy), se přeskočí.
 * Celá subdoména cs. → www se stejnou cestou; známé cesty rovnou na cíl (1 skok).
 */
import strategyData from './data/strategy.json'
import copyData from './data/copy.json'
import { BLOG_ARTICLES } from './duvera/blog'

export const CANONICAL_ORIGIN = 'https://www.mummiesdaddies.com'
export const LEGACY_HOSTS = ['cs.mummiesdaddies.com'] as const

export interface WebRedirect {
  source: string
  destination: string
  permanent: true
  has?: { type: 'host'; value: string }[]
}

const KNOWN_PATHS = new Set<string>([
  ...(copyData as { pages: { path: string }[] }).pages.map((p) => p.path).filter((p) => !p.includes('[')),
  ...BLOG_ARTICLES.map((a) => `/blog/${a.slug}`),
])

/** Cíl, který na novém webu existuje (neznámý článek → /blog). */
export function resolveDestination(dest: string): string {
  const path = dest.split('?')[0]
  if (KNOWN_PATHS.has(path)) return dest
  if (path.startsWith('/blog/')) return '/blog'
  return dest
}

/** „/blog/categories/*“ → „/blog/categories/:path*“. */
function toSource(raw: string): string {
  return raw.endsWith('/*') ? `${raw.slice(0, -2)}/:path*` : raw
}

/** Řádky strategie → páry { from, to } (bez hostů, bez duplicit). */
export function parseRedirectLines(lines: readonly string[]): { from: string; to: string }[] {
  const out: { from: string; to: string }[] = []
  const seen = new Set<string>()
  for (const line of lines) {
    if (!line.startsWith('/')) continue
    const arrow = line.indexOf('→')
    if (arrow < 0) continue
    const left = line.slice(0, arrow).replace(/\([^)]*\)/g, ' ')
    const right = line.slice(arrow + 1).trim()
    const fallback = /jinak\s+(\/\S*?)\)?$/.exec(right)?.[1]
    const dest = fallback ?? /^(\/\S*)/.exec(right)?.[1]
    if (!dest) continue
    const to = resolveDestination(dest)
    for (const part of left.split(',')) {
      const from = part.trim()
      if (!from.startsWith('/') || from === '/' || from === to || seen.has(from)) continue
      seen.add(from)
      out.push({ from, to })
    }
  }
  return out
}

const encodePath = (p: string) => p.split('/').map((s) => (s.startsWith(':') ? s : encodeURIComponent(s))).join('/')

/** Konfigurace pro next.config.ts → redirects(). */
export function legacyRedirectConfig(lines: readonly string[] = (strategyData as { redirects: string[] }).redirects): WebRedirect[] {
  const pairs = parseRedirectLines(lines)
  const sources = (from: string) => {
    const s = toSource(from)
    const enc = encodePath(s)
    return enc === s ? [s] : [s, enc]
  }
  const out: WebRedirect[] = []
  // 1) stará subdoména: známá cesta rovnou na cíl na www, jinak stejná cesta na www
  for (const host of LEGACY_HOSTS) {
    for (const { from, to } of pairs) {
      for (const source of sources(from)) out.push({ source, destination: `${CANONICAL_ORIGIN}${to}`, permanent: true, has: [{ type: 'host', value: host }] })
    }
    out.push({ source: '/:path*', destination: `${CANONICAL_ORIGIN}/:path*`, permanent: true, has: [{ type: 'host', value: host }] })
  }
  // 2) staré cesty na jakékoli doméně
  for (const { from, to } of pairs) for (const source of sources(from)) out.push({ source, destination: to, permanent: true })
  return out
}
