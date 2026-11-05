// Gmail API — přístupový token schránky (OAuth 2.0, interní aplikace
// v Google Cloud projektu firmy).
//
// JEDINÝ zdroj tokenu Gmailu v systému: čtení poptávek (P2), odchozí fronta
// (P3) i outbound (P7, oddělená odesílací schránka) berou token odsud.
// Model: každá schránka (vedení, obchod, vyhrazená poptavky@, odesílací
// schránka outboundu) jednou udělí souhlas interní aplikaci s rozsahy
// GMAIL_SCOPES. Refresh token schránky je tajemství v env:
//   GMAIL_OAUTH_CLIENT_ID, GMAIL_OAUTH_CLIENT_SECRET
//   GMAIL_REFRESH_TOKENS  JSON objekt {"adresa schránky": "refresh token", …}
// Přístupový token (≈ 1 h) se drží jen v paměti procesu.
//
// Interní aplikace (OAuth consent „Internal") má refresh token bez expirace
// po 7 dnech; neplatný token (invalid_grant) = schránka se musí připojit
// znovu. Hodnota tokenu ani tajemství se nikdy neloguje.

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'

/** Rozsahy pro čtení příchozích poptávek. */
export const GMAIL_READ_SCOPES = ['https://www.googleapis.com/auth/gmail.readonly'] as const
/** Rozsahy, které schránka udělí (čtení + odeslání odchozí fronty). */
export const GMAIL_SCOPES = [...GMAIL_READ_SCOPES, 'https://www.googleapis.com/auth/gmail.send'] as const

export type GmailTokenResult =
  | { ok: true; accessToken: string }
  | { ok: false; reason: 'not_configured' | 'invalid_grant' | 'error'; status: number | null }

type Env = Record<string, string | undefined>

/** Refresh tokeny podle schránky (adresy malými písmeny). Nečitelný JSON = žádné. */
export function gmailRefreshTokens(env: Env = process.env): Map<string, string> {
  const raw = env.GMAIL_REFRESH_TOKENS
  const out = new Map<string, string>()
  if (!raw) return out
  try {
    const obj = JSON.parse(raw) as unknown
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      if (typeof v === 'string' && v.trim() && /^[^@\s]+@[^@\s]+$/.test(k.trim())) out.set(k.trim().toLowerCase(), v.trim())
    }
  } catch {
    return out
  }
  return out
}

/** Je pro schránku nastavené OAuth (klient i refresh token)? */
export function gmailConfigured(mailbox: string, env: Env = process.env): boolean {
  return Boolean(env.GMAIL_OAUTH_CLIENT_ID && env.GMAIL_OAUTH_CLIENT_SECRET && gmailRefreshTokens(env).has(mailbox.toLowerCase()))
}

const cache = new Map<string, { token: string; expiresAt: number }>()

/** Jen pro testy: zapomene tokeny v paměti. */
export function resetGmailTokenCache(): void {
  cache.clear()
}

/** Platný přístupový token schránky (z cache, nebo obnovený refresh tokenem). */
export async function gmailAccessToken(
  mailbox: string,
  opts: { env?: Env; fetchImpl?: typeof fetch; now?: () => number } = {},
): Promise<GmailTokenResult> {
  const env = opts.env ?? process.env
  const now = opts.now ?? Date.now
  const key = mailbox.toLowerCase()
  const hit = cache.get(key)
  if (hit && hit.expiresAt - 60_000 > now()) return { ok: true, accessToken: hit.token }

  const refresh = gmailRefreshTokens(env).get(key)
  const clientId = env.GMAIL_OAUTH_CLIENT_ID
  const clientSecret = env.GMAIL_OAUTH_CLIENT_SECRET
  if (!refresh || !clientId || !clientSecret) return { ok: false, reason: 'not_configured', status: null }

  let res: Response
  try {
    res = await (opts.fetchImpl ?? fetch)(GOOGLE_TOKEN_URL, {
      method: 'POST',
      signal: AbortSignal.timeout(15_000),
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refresh, client_id: clientId, client_secret: clientSecret }).toString(),
    })
  } catch {
    return { ok: false, reason: 'error', status: null }
  }
  if (!res.ok) {
    let code: unknown = null
    try {
      code = ((await res.json()) as { error?: unknown } | null)?.error
    } catch {
      code = null
    }
    return { ok: false, reason: code === 'invalid_grant' ? 'invalid_grant' : 'error', status: res.status }
  }
  let body: { access_token?: unknown; expires_in?: unknown }
  try {
    body = (await res.json()) as typeof body
  } catch {
    return { ok: false, reason: 'error', status: res.status }
  }
  if (typeof body.access_token !== 'string' || !body.access_token) return { ok: false, reason: 'error', status: res.status }
  const ttl = typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 3600
  cache.set(key, { token: body.access_token, expiresAt: now() + ttl * 1000 })
  return { ok: true, accessToken: body.access_token }
}
