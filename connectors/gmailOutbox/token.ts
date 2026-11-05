// Google OAuth 2.0 — obnova přístupového tokenu schránky (interní OAuth
// aplikace v Google Cloud projektu firmy). Refresh token je uložený
// šifrovaně v calendar_token (provider 'google', 0031/0041); tady je jen
// výměna refresh tokenu za access token.
//
// POST https://oauth2.googleapis.com/token, form client_id, client_secret,
// refresh_token, grant_type=refresh_token → { access_token, expires_in,
// scope, token_type } (refresh token Google většinou nerotuje — když nový
// nepřijde, platí dál starý).
// https://developers.google.com/identity/protocols/oauth2/web-server#offline
//
// Bezpečnost: tajemství ani tokeny se nevrací v chybě ani nelogují.

export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'

export type GoogleOAuthClient = { clientId: string; clientSecret: string }

export type GoogleTokenFetch = (url: string, init: RequestInit) => Promise<Response>

/** Klient OAuth z prostředí (GMAIL_OAUTH_CLIENT_ID / GMAIL_OAUTH_CLIENT_SECRET), nebo null. */
export function googleOAuthClientFromEnv(env: Record<string, string | undefined>): GoogleOAuthClient | null {
  const clientId = env.GMAIL_OAUTH_CLIENT_ID?.trim()
  const clientSecret = env.GMAIL_OAUTH_CLIENT_SECRET?.trim()
  return clientId && clientSecret ? { clientId, clientSecret } : null
}

export async function refreshGoogleAccessToken(
  client: GoogleOAuthClient,
  refreshToken: string,
  fetchImpl: GoogleTokenFetch = fetch,
): Promise<{ access_token: string; refresh_token: string; expires_in: number } | null> {
  const body = new URLSearchParams({
    client_id: client.clientId,
    client_secret: client.clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  })
  let res: Response
  try {
    res = await fetchImpl(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      cache: 'no-store',
    })
  } catch {
    return null
  }
  if (!res.ok) return null
  let json: Record<string, unknown> | null = null
  try {
    json = (await res.json()) as Record<string, unknown>
  } catch {
    return null
  }
  const access = json?.access_token
  if (typeof access !== 'string' || !access) return null
  const rotated = typeof json?.refresh_token === 'string' && json.refresh_token ? (json.refresh_token as string) : refreshToken
  const expires = Number(json?.expires_in)
  return { access_token: access, refresh_token: rotated, expires_in: Number.isFinite(expires) && expires > 0 ? expires : 3600 }
}
