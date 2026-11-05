// Ověření tokenu Cloudflare Turnstile na serveru (siteverify).
//
// Formuláře veřejného webu (/api/web/**) ho volají VŽDY: bez tajného klíče
// (TURNSTILE_SECRET_KEY) nebo při chybě ověření je výsledek „neprošlo" —
// veřejný vstup bez ochrany proti robotům se nepouští (zavřeno při chybě).
// Pro vývoj a testy má Cloudflare veřejné testovací klíče (vždy projde /
// vždy neprojde), viz dokumentace Turnstile.
//
// Do logu nejde token ani IP adresa, jen kód chyby.

export const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify'

export type TurnstileResult = { ok: true } | { ok: false; reason: 'no_secret' | 'no_token' | 'rejected' | 'unavailable' }

export async function verifyTurnstileToken(
  secret: string | undefined,
  token: string | null | undefined,
  remoteIp: string | null,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 5000,
): Promise<TurnstileResult> {
  if (!secret) return { ok: false, reason: 'no_secret' }
  if (!token || token.length > 2048) return { ok: false, reason: 'no_token' }
  const body = new URLSearchParams({ secret, response: token })
  if (remoteIp && remoteIp !== 'unknown') body.set('remoteip', remoteIp)
  try {
    const res = await fetchImpl(TURNSTILE_VERIFY_URL, { method: 'POST', body, signal: AbortSignal.timeout(timeoutMs) })
    if (!res.ok) return { ok: false, reason: 'unavailable' }
    const data = (await res.json()) as { success?: unknown }
    return data.success === true ? { ok: true } : { ok: false, reason: 'rejected' }
  } catch {
    return { ok: false, reason: 'unavailable' }
  }
}
