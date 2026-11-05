// Směrování jedné aplikace „web + Cockpit" (kontrakt základového balíku).
//
//   /                      veřejný web firmy (app/(web)/…, balík P6)
//   /<cokoli mimo níže>    veřejný web (stránky v app/(web)/…) — BEZ přihlášení
//   /cockpit, /cockpit/**  interní Cockpit (app/cockpit/…) — přihlášení + MFA (AAL2)
//   /login, /auth/**       přihlášení a MFA Cockpitu
//   /api/web/**            veřejná API webu (formuláře; Turnstile + limit v routě)
//   /api/**                ostatní API — za přihlášením, kromě výjimek
//                          v lib/supabase/middleware.ts (vlastní autentizace)
//   /.well-known/**        OAuth discovery (veřejné)
//
// Server Action nepřihlášený nesmí spustit nikde kromě signIn na /login
// (ID action je globální). Veřejný web proto formuláře posílá na
// route handlery /api/web/**, ne přes Server Actions.

/** Předpona interního Cockpitu. */
export const COCKPIT_PREFIX = '/cockpit'

/** Úvodní stránka Cockpitu (po přihlášení). */
export const COCKPIT_HOME = COCKPIT_PREFIX

/** Přihlášení do Cockpitu. */
export const LOGIN_PATH = '/login'

/** Předpona veřejných API webu (P6). */
export const PUBLIC_WEB_API_PREFIX = '/api/web'

/** `/x` a `/x/...`, ale ne `/xy` — prefixová shoda by otevřela cizí cesty. */
export function matchesSegment(path: string, base: string): boolean {
  return path === base || path.startsWith(`${base}/`)
}

/** Cesty, které nejsou veřejný web (mají vlastní pravidla brány). */
const NON_WEB_PREFIXES = [COCKPIT_PREFIX, LOGIN_PATH, '/auth', '/api', '/_next'] as const

/**
 * Je cesta stránka veřejného webu (bez přihlášení)? Všechno mimo Cockpit,
 * přihlášení, API a interní cesty Next.js.
 */
export function isPublicWebPath(path: string): boolean {
  if (path.startsWith('/.well-known/')) return false
  return !NON_WEB_PREFIXES.some((p) => matchesSegment(path, p))
}

/** Je cesta veřejné API webu (formulář poptávky, objednávka)? */
export function isPublicWebApiPath(path: string): boolean {
  return matchesSegment(path, PUBLIC_WEB_API_PREFIX)
}

/** Je cesta součástí interního Cockpitu? */
export function isCockpitPath(path: string): boolean {
  return matchesSegment(path, COCKPIT_PREFIX)
}
