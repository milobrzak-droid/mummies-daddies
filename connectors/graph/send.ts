// Microsoft Graph — odeslání e-mailu.
//
// Jen transport, žádná doménová logika. Dvě cesty:
//  - delegovaná (výchozí, rozhodnutí 28. 9. 2026): POST /me/sendMail
//    s delegovaným tokenem člena (Mail.Send v GRAPH_SCOPES, ./client.ts) —
//    e-mail odchází z jeho vlastní schránky (sendMailAsMe),
//  - app-only (volitelná alternativa): token přes OAuth 2.0 client
//    credentials + POST /users/{upn}/sendMail (getAppOnlyToken,
//    sendMailAsUser).
// Kdo, co a kdy posílá, řeší domain/crm/digestDelivery.ts.
//
// Ověřeno proti Microsoft Learn (2026-09-28):
// - Token: POST https://login.microsoftonline.com/{tenant}/oauth2/v2.0/token,
//   form client_id, client_secret, scope=https://graph.microsoft.com/.default,
//   grant_type=client_credentials; odpověď access_token + expires_in.
//   https://learn.microsoft.com/en-us/entra/identity-platform/v2-oauth2-client-creds-grant-flow
// - Odeslání: POST /users/{id | userPrincipalName}/sendMail, aplikační
//   oprávnění Mail.Send, tělo { message, saveToSentItems }, úspěch = 202
//   Accepted bez těla (přijato, ne doručeno).
//   https://learn.microsoft.com/en-us/graph/api/user-sendmail?view=graph-rest-1.0
// - Delegovaně: POST /me/sendMail, nejmenší delegované oprávnění Mail.Send
//   (pracovní účet), stejné tělo, úspěch = 202 Accepted (ověřeno tamtéž
//   2026-09-28). Token bez Mail.Send → 403 (ErrorAccessDenied).
//
// Bezpečnost: client secret ani access token se nikdy nevrací v chybě ani
// nelogují. Chyba nese jen HTTP status a kód chyby (AADSTS/Graph code), ne
// error_description ani text odpovědi — ty můžou obsahovat identifikátory.
// Soubor nic neloguje; logování je na volajícím, který dostane jen tyhle
// očištěné chyby.

export const GRAPH_SEND_BASE = 'https://graph.microsoft.com/v1.0'
export const GRAPH_APP_SCOPE = 'https://graph.microsoft.com/.default'

export type SendFetch = (url: string, init: RequestInit) => Promise<Response>

export type AppCredentials = {
  tenantId: string
  clientId: string
  clientSecret: string
}

export type AppTokenResult =
  | { ok: true; accessToken: string; expiresInSeconds: number }
  | { ok: false; status: number; message: string }

export type OutgoingMail = {
  subject: string
  html: string
  to: readonly string[]
}

export type SendMailResult = { ok: true } | { ok: false; status: number; message: string }

// Tenant je GUID nebo doménové jméno (mummiesdaddies.com, x.onmicrosoft.com).
// 'common'/'organizations' pro client credentials nedávají smysl.
const TENANT_RE = /^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+)$/i

export function isValidTenantId(tenantId: string): boolean {
  return TENANT_RE.test(tenantId)
}

// Jen bezpečné tokeny kódu chyby (AADSTS7000215, invalid_client,
// ErrorAccessDenied …) — nic, co by mohlo nést data.
function safeCode(value: unknown): string {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : 'unknown'
}

async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await res.json()
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export async function getAppOnlyToken(
  creds: AppCredentials,
  fetchImpl: SendFetch = fetch,
): Promise<AppTokenResult> {
  if (!isValidTenantId(creds.tenantId)) return { ok: false, status: 0, message: 'Neplatné MS_APP_TENANT_ID' }
  if (!creds.clientId || !creds.clientSecret) return { ok: false, status: 0, message: 'Chybí MS_APP_CLIENT_ID/SECRET' }

  const body = new URLSearchParams({
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    scope: GRAPH_APP_SCOPE,
    grant_type: 'client_credentials',
  })
  let res: Response
  try {
    res = await fetchImpl(`https://login.microsoftonline.com/${encodeURIComponent(creds.tenantId)}/oauth2/v2.0/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      cache: 'no-store',
    })
  } catch {
    return { ok: false, status: 0, message: 'Token endpoint nedostupný' }
  }
  const json = await readJson(res)
  if (!res.ok) {
    // AADSTS kód je první číslo v error_codes; samotný popis nevracíme.
    const codes = Array.isArray(json?.error_codes) ? json.error_codes : []
    const aadsts = typeof codes[0] === 'number' ? ` AADSTS${codes[0]}` : ''
    return { ok: false, status: res.status, message: `Token ${res.status} ${safeCode(json?.error)}${aadsts}` }
  }
  const accessToken = json?.access_token
  if (typeof accessToken !== 'string' || !accessToken) {
    return { ok: false, status: res.status, message: 'Token: odpověď bez access_token' }
  }
  const expires = Number(json?.expires_in)
  return { ok: true, accessToken, expiresInSeconds: Number.isFinite(expires) ? expires : 0 }
}

export function sendMailUrl(sender: string): string {
  return `${GRAPH_SEND_BASE}/users/${encodeURIComponent(sender)}/sendMail`
}

/** Delegovaně: schránka vlastníka tokenu. */
export const SEND_MAIL_AS_ME_URL = `${GRAPH_SEND_BASE}/me/sendMail`

/** App-only: odeslání jménem schránky `sender` (Mail.Send omezený RBAC). */
export async function sendMailAsUser(
  accessToken: string,
  sender: string,
  mail: OutgoingMail,
  fetchImpl: SendFetch = fetch,
): Promise<SendMailResult> {
  return postSendMail(sendMailUrl(sender), accessToken, mail, fetchImpl)
}

/**
 * Delegovaně: odeslání ze schránky člena, jemuž patří `accessToken`
 * (token musí mít Mail.Send, jinak 403). Chyby stejně očištěné jako u
 * sendMailAsUser — jen HTTP status a kód chyby.
 */
export async function sendMailAsMe(
  accessToken: string,
  mail: OutgoingMail,
  fetchImpl: SendFetch = fetch,
): Promise<SendMailResult> {
  return postSendMail(SEND_MAIL_AS_ME_URL, accessToken, mail, fetchImpl)
}

async function postSendMail(
  url: string,
  accessToken: string,
  mail: OutgoingMail,
  fetchImpl: SendFetch,
): Promise<SendMailResult> {
  if (mail.to.length === 0) return { ok: false, status: 0, message: 'Žádní příjemci' }
  const payload = {
    message: {
      subject: mail.subject,
      body: { contentType: 'HTML', content: mail.html },
      toRecipients: mail.to.map((address) => ({ emailAddress: { address } })),
    },
    saveToSentItems: true,
  }
  let res: Response
  try {
    res = await fetchImpl(url, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      cache: 'no-store',
    })
  } catch {
    return { ok: false, status: 0, message: 'Graph nedostupný' }
  }
  if (res.status === 202) return { ok: true }
  const json = await readJson(res)
  const err = json?.error as Record<string, unknown> | undefined
  return { ok: false, status: res.status, message: `Graph ${res.status} ${safeCode(err?.code)}` }
}
