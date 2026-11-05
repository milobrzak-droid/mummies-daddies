import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

// Čisté pomocné funkce pro OAuth (state nonce + PKCE, RFC 7636). Žádné I/O,
// jen crypto, takže jdou testovat proti testovacímu vektoru z RFC.
//
// Proč: `state` býval jen user.id. Kdo znal uuid kolegy, mohl mu podstrčit
// odkaz na Microsoft consent a napojit jeho Cockpit účet na cizí Microsoft účet.
// Nonce v httpOnly cookie váže callback na prohlížeč, který flow zahájil;
// PKCE váže výměnu kódu na tentýž prohlížeč (ukradený kód bez verifieru
// nejde vyměnit).

// Cookie žijí jen pro cesty OAuth flow a jen 10 minut.
export const OAUTH_STATE_COOKIE = 'ms_oauth_state'
export const OAUTH_VERIFIER_COOKIE = 'ms_oauth_verifier'
export const OAUTH_COOKIE_MAX_AGE_SECONDS = 10 * 60
export const OAUTH_COOKIE_PATH = '/api/ms'

export function generateNonce(): string {
  return randomBytes(32).toString('hex')
}

// 32 náhodných bajtů v base64url = 43 znaků (RFC 7636 povoluje 43 až 128).
export function generateCodeVerifier(): string {
  return randomBytes(32).toString('base64url')
}

// code_challenge = BASE64URL(SHA256(ASCII(code_verifier))) bez paddingu.
export function codeChallengeS256(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url')
}

// Porovnání v konstantním čase. Porovnávají se SHA-256 otisky, takže funkce
// nevyhazuje při různé délce vstupů a ta se neprozradí časem. Chybějící
// nebo prázdná hodnota se nikdy nerovná (ani prázdné prázdné).
export function safeEqual(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  const ha = createHash('sha256').update(a).digest()
  const hb = createHash('sha256').update(b).digest()
  return timingSafeEqual(ha, hb)
}
