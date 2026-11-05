import { logError } from '@/lib/log'
import { COMPANY } from '@/config'

// Microsoft Graph / Entra ID (Azure AD) OAuth + calendar helpers.
// Plain functions, no secrets exposed to the client — this file is only ever
// imported from server code (route handlers, server actions).
//
// Required env vars (see .env.example):
//   MS_CLIENT_ID       — Azure app registration application (client) ID
//   MS_CLIENT_SECRET   — Azure app registration client secret value
//   MS_TENANT_ID        — tenant id, or 'common' for multi-tenant/personal accounts (default 'common')
//   MS_REDIRECT_URI     — e.g. http://localhost:3200/api/ms/callback (falls back to request origin if unset)
//
// Scopes requested: offline_access Calendars.ReadWrite User.Read Mail.Read Mail.Send
// (+ Files.Read.All jen s GRAPH_FILES_SCOPE_ENABLED=true, viz graphScopes níže)
//
// Mail.Read (rozhodnutí vlastníka 28. 9. 2026) — delegované právo číst celou
// poštu přihlášeného člena. Cockpit z ní ale dál ukládá JEN METADATA
// (domain/crm/mailSync.ts, $select v ./mail.ts): žádný předmět ani tělo.
// Plné právo je tu kvůli budoucí klasifikaci odpovědí; ta bude potřebovat
// vlastní návrh včetně ochrany proti prompt injection (obsah e-mailu je
// nedůvěryhodný vstup) a do té doby se obsah nečte.
//
// Mail.Send (rozhodnutí vlastníka 28. 9. 2026, nahrazuje servisní schránku
// cockpit@) — delegované právo posílat poštu JMÉNEM přihlášeného člena.
// Používá ho jedině cron přehledu (domain/crm/digestDelivery.ts, režim
// DIGEST_SEND_MODE=delegated) a jen s tokenem jednoho člena
// (DIGEST_SENDER_MEMBER_ID, výchozí OUTLOOK_MAIL_SYNC_MEMBER_ID = Viktor):
// přehled tak odchází z viktor@mummiesdaddies.com bez vlastní registrace v Entra.
// Právo ale dostane token KAŽDÉHO člena, který Outlook připojí — žádný jiný
// kód s ním neposílá; nový odesílací tok musí projít stejnou revizí.
//
// Tokeny vydané před přidáním Mail.Read / Mail.Send ta práva nemají: člen
// musí Outlook jednou znovu připojit (Nastavení → Znovu připojit (rozšířit
// oprávnění), connect route s prompt=consent). Do té doby Graph na poště vrací 403 (sync i odeslání přehledu to
// zapíšou jako chybu konektoru) a obnova staršího tokenu s rozšířeným scope
// může selhat — týká se to i kalendáře ostatních členů.

export const GRAPH_SCOPES = 'offline_access Calendars.ReadWrite User.Read Mail.Read Mail.Send'

// Files.Read.All (plan kap. 8, SharePoint/Teams knihovna) — delegované právo
// ČÍST metadata souborů, ke kterým má přihlášený člen přístup. Cockpit ho
// používá jedině v connectors/graph/files.ts: GET /shares/{…}/driveItem
// s $select jen na metadata (název, webUrl, poslední změna, velikost, typ),
// NIKDY obsah (žádné /content, žádný downloadUrl).
//
// Záměrně NENÍ ve výchozích GRAPH_SCOPES: zapíná se proměnnou prostředí
// GRAPH_FILES_SCOPE_ENABLED=true. Pak ho žádá přihlášení i výměna kódu
// (tlačítko „Znovu připojit" v Nastavení) a missingGraphScopes ho hlásí
// jako chybějící, dokud ho člen neudělí. Bez něj (nebo bez připojení) se
// odkaz na dokument uloží tak, jak ho člen vložil, s nápovědou.
export const GRAPH_FILES_SCOPE = 'Files.Read.All'

/** Je zapnuté čtení metadat souborů (Files.Read.All)? Jen přesně 'true'. */
export function filesScopeEnabled(): boolean {
  return process.env.GRAPH_FILES_SCOPE_ENABLED === 'true'
}

/**
 * Oprávnění, o která Cockpit žádá při přihlášení a výměně kódu: GRAPH_SCOPES,
 * se zapnutým GRAPH_FILES_SCOPE_ENABLED navíc Files.Read.All.
 *
 * Obnova tokenu (refreshAccessToken) ale žádá dál jen GRAPH_SCOPES (výjimka:
 * refreshAccessTokenForFiles níže pro čtení souborů žádá s přepínačem i
 * Files.Read.All a při odmítnutí spadne zpět na GRAPH_SCOPES): Microsoft
 * u refresh požadavku vyžaduje scope „equivalent to or a subset of" těch
 * z původního přihlášení (learn.microsoft.com/entra/identity-platform/
 * v2-oauth2-auth-code-flow, „Refresh the access token"). Kdyby obnova
 * žádala i Files.Read.All, spadla by každému, kdo po zapnutí přepínače ještě
 * neklikl „Znovu připojit" — a s ní kalendář i pošta.
 */
export function graphScopes(): string {
  return filesScopeEnabled() ? `${GRAPH_SCOPES} ${GRAPH_FILES_SCOPE}` : GRAPH_SCOPES
}

// Pole `scope` z odpovědi tokenového endpointu = co Microsoft SKUTEČNĚ udělil
// (mezerami oddělené; u Graphu někdy s prefixem zdroje). Ukládá se při
// připojení (calendar_token.granted_scopes, migrace 0060), ať Nastavení umí
// říct, které oprávnění chybí.
const GRAPH_RESOURCE_PREFIX = 'https://graph.microsoft.com/'
// Jen názvy oprávnění — nic, co by mohlo nést data.
const SCOPE_TOKEN_RE = /^[A-Za-z0-9._-]{1,64}$/
// Microsoft offline_access (a OIDC openid/profile/email) v `scope` vracet nemusí.
const NOT_REPORTED_SCOPES = new Set(['offline_access', 'openid', 'profile', 'email'])

/** Normalizovaný seznam udělených oprávnění (bez prefixu zdroje, bez duplicit), nebo null. */
export function normalizeGrantedScopes(scope: string | null | undefined): string | null {
  if (typeof scope !== 'string') return null
  const names = scope.split(/\s+/)
    .map((s) => (s.toLowerCase().startsWith(GRAPH_RESOURCE_PREFIX) ? s.slice(GRAPH_RESOURCE_PREFIX.length) : s))
    .filter((s) => SCOPE_TOKEN_RE.test(s))
  const unique = Array.from(new Map(names.map((n) => [n.toLowerCase(), n])).values())
  return unique.length > 0 ? unique.join(' ') : null
}

/**
 * Oprávnění z graphScopes() (GRAPH_SCOPES, případně i Files.Read.All), která
 * v udělených chybí (bez offline_access).
 * null = udělená práva neznáme (připojeno před migrací 0060) — pak nic
 * netvrdíme.
 */
export function missingGraphScopes(granted: string | null | undefined): string[] | null {
  const normalized = normalizeGrantedScopes(granted)
  if (!normalized) return null
  const have = new Set(normalized.split(' ').map((s) => s.toLowerCase()))
  return graphScopes().split(' ')
    .filter((s) => !NOT_REPORTED_SCOPES.has(s.toLowerCase()))
    .filter((s) => !have.has(s.toLowerCase()))
}

function tenant(): string {
  return process.env.MS_TENANT_ID ?? 'common'
}

export function msConfigured(): boolean {
  return !!(process.env.MS_CLIENT_ID && process.env.MS_CLIENT_SECRET)
}

// `codeChallenge` je S256 PKCE challenge (RFC 7636, viz ./oauthState.ts).
// Nepovinný jen kvůli zpětné kompatibilitě volání; connect route ho posílá vždy.
// `prompt: 'consent'` vynutí souhlasovou obrazovku i u už připojeného účtu —
// tlačítko „Znovu připojit (rozšířit oprávnění)" v Nastavení.
export type AuthPrompt = 'consent' | 'select_account'

export function getAuthUrl(redirectUri: string, state: string, codeChallenge?: string, prompt?: AuthPrompt): string {
  const params = new URLSearchParams({
    client_id: process.env.MS_CLIENT_ID ?? '',
    response_type: 'code',
    redirect_uri: redirectUri,
    response_mode: 'query',
    scope: graphScopes(),
    state,
  })
  if (codeChallenge) {
    params.set('code_challenge', codeChallenge)
    params.set('code_challenge_method', 'S256')
  }
  if (prompt === 'consent' || prompt === 'select_account') params.set('prompt', prompt)
  return `https://login.microsoftonline.com/${tenant()}/oauth2/v2.0/authorize?${params.toString()}`
}

// `scope` = udělená oprávnění (jen u výměny kódu; bez něj undefined).
type TokenResponse = { access_token: string; refresh_token: string; expires_in: number; scope?: string }

// `codeVerifier` je PKCE verifier zaslaný při výměně kódu; musí odpovídat
// challenge z getAuthUrl, jinak Microsoft výměnu odmítne.
export async function exchangeCodeForToken(
  code: string,
  redirectUri: string,
  codeVerifier?: string,
): Promise<TokenResponse | null> {
  try {
    const body = new URLSearchParams({
      client_id: process.env.MS_CLIENT_ID ?? '',
      client_secret: process.env.MS_CLIENT_SECRET ?? '',
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      scope: graphScopes(),
    })
    if (codeVerifier) body.set('code_verifier', codeVerifier)
    const res = await fetch(`https://login.microsoftonline.com/${tenant()}/oauth2/v2.0/token`, { signal: AbortSignal.timeout(15_000),
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
    if (!res.ok) return null
    const json = await res.json()
    if (!json.access_token || !json.refresh_token) return null
    return {
      access_token: json.access_token,
      refresh_token: json.refresh_token,
      expires_in: json.expires_in,
      ...(typeof json.scope === 'string' ? { scope: json.scope } : {}),
    }
  } catch (e) {
    logError('graph.exchangeCodeForToken', e)
    return null
  }
}

// `scope` = žádaná oprávnění nového přístupového tokenu; výchozí GRAPH_SCOPES
// (viz komentář u graphScopes). Jen denní kontrola dokumentů (domain/delivery/
// documentSyncService.ts) žádá i Files.Read.All, které člen při připojení už
// udělil — přístupový token z obnovy totiž nese jen to, co se v obnově vyžádá.
// Nic nového se tím nežádá: Microsoft odmítne rozsah, který člen neudělil.
export async function refreshAccessToken(refreshToken: string, scope: string = GRAPH_SCOPES): Promise<TokenResponse | null> {
  try {
    const body = new URLSearchParams({
      client_id: process.env.MS_CLIENT_ID ?? '',
      client_secret: process.env.MS_CLIENT_SECRET ?? '',
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      // Výchozí je záměrně GRAPH_SCOPES, ne graphScopes() — viz komentář u graphScopes.
      scope,
    })
    const res = await fetch(`https://login.microsoftonline.com/${tenant()}/oauth2/v2.0/token`, { signal: AbortSignal.timeout(15_000),
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
    if (!res.ok) return null
    const json = await res.json()
    if (!json.access_token) return null
    // Microsoft may or may not rotate the refresh token — fall back to the old one.
    return {
      access_token: json.access_token,
      refresh_token: json.refresh_token ?? refreshToken,
      expires_in: json.expires_in,
    }
  } catch (e) {
    logError('graph.refreshAccessToken', e)
    return null
  }
}

/**
 * Obnova tokenu pro čtení souborů (SharePoint): se zapnutým
 * GRAPH_FILES_SCOPE_ENABLED nejdřív zkusí i Files.Read.All, a když to
 * Microsoft odmítne (člen ho ještě neudělil), obnoví token jako dřív, bez něj.
 * Bez přepínače je to obyčejná obnova. Kalendář ani pošta tím nezískají nic
 * navíc a nic nepřijdou.
 */
export async function refreshAccessTokenForFiles(
  refreshToken: string,
  // Vstříknutelné kvůli testům (token.ts předává svou vlastní vazbu na obnovu).
  refresh: (refreshToken: string, scope?: string) => Promise<TokenResponse | null> = refreshAccessToken,
): Promise<TokenResponse | null> {
  if (filesScopeEnabled()) {
    const withFiles = await refresh(refreshToken, graphScopes())
    if (withFiles) return withFiles
  }
  return refresh(refreshToken)
}

export async function getMe(accessToken: string): Promise<{ mail?: string; userPrincipalName?: string } | null> {
  try {
    const res = await fetch('https://graph.microsoft.com/v1.0/me', { signal: AbortSignal.timeout(15_000),
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    if (!res.ok) return null
    return await res.json()
  } catch (e) {
    logError('graph.getMe', e)
    return null
  }
}

export type GraphEvent = {
  subject: string
  body?: { contentType: 'text' | 'html'; content: string }
  start: { dateTime: string; timeZone: string }
  end: { dateTime: string; timeZone: string }
  isAllDay?: boolean
  attendees?: { emailAddress: { address: string; name?: string }; type: 'required' | 'optional' }[]
  // Teams odkaz v pozvánce — schůzka se koná online v Teams. Zápis z ní
  // (Wispr Flow) se do Cockpitu vrací přes Cowork skill, ne automaticky.
  isOnlineMeeting?: boolean
  onlineMeetingProvider?: 'teamsForBusiness'
}

// Vrací id i odkaz na online schůzku — odkaz ukládáme k záznamu, ať se
// dá ze schůzky v Cockpitu rovnou vstoupit.
export async function createMeetingEvent(
  accessToken: string,
  event: GraphEvent,
): Promise<{ id: string; joinUrl: string | null } | null> {
  try {
    const res = await fetch('https://graph.microsoft.com/v1.0/me/events', { signal: AbortSignal.timeout(15_000),
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(event),
    })
    if (!res.ok) return null
    const json = await res.json()
    if (!json.id) return null
    return { id: json.id, joinUrl: json.onlineMeeting?.joinUrl ?? null }
  } catch (e) {
    logError('graph.createMeetingEvent', e)
    return null
  }
}

export async function createCalendarEvent(accessToken: string, event: GraphEvent): Promise<string | null> {
  try {
    const res = await fetch('https://graph.microsoft.com/v1.0/me/events', { signal: AbortSignal.timeout(15_000),
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(event),
    })
    if (!res.ok) return null
    const json = await res.json()
    return json.id ?? null
  } catch (e) {
    logError('graph.createCalendarEvent', e)
    return null
  }
}

export async function updateCalendarEvent(accessToken: string, eventId: string, event: Partial<GraphEvent>): Promise<boolean> {
  try {
    const res = await fetch(`https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(eventId)}`, { signal: AbortSignal.timeout(15_000),
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(event),
    })
    return res.ok
  } catch (e) {
    logError('graph.updateCalendarEvent', e)
    return false
  }
}

export async function deleteCalendarEvent(accessToken: string, eventId: string): Promise<boolean> {
  try {
    const res = await fetch(`https://graph.microsoft.com/v1.0/me/events/${encodeURIComponent(eventId)}`, { signal: AbortSignal.timeout(15_000),
      method: 'DELETE',
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    // Graph returns 204 on success; treat a 404 (already gone) as success too.
    return res.ok || res.status === 404
  } catch (e) {
    logError('graph.deleteCalendarEvent', e)
    return false
  }
}

// Builds an all-day GraphEvent for a task that only has a due date (no time).
// Graph all-day events must span from the date to the next date at midnight,
// both expressed in the same timeZone.
export function allDayEventForDate(subject: string, dueOn: string, body?: string): GraphEvent {
  const start = dueOn // 'YYYY-MM-DD'
  const end = addDays(dueOn, 1)
  return {
    subject,
    ...(body ? { body: { contentType: 'text' as const, content: body } } : {}),
    start: { dateTime: `${start}T00:00:00`, timeZone: COMPANY.timeZone },
    end: { dateTime: `${end}T00:00:00`, timeZone: COMPANY.timeZone },
    isAllDay: true,
  }
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}
