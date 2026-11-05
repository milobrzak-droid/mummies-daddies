// Microsoft Graph — předplatné změn (change notifications přes webhook).
//
// Jen transport a protokol: sestavení požadavků na /subscriptions, překlad
// odpovědí na jednoznačné výsledky (ok / throttling / 404 / 409 / 403 /
// chyba), odvození clientState a rozbor příchozí notifikace. Co se kdy
// zakládá, obnovuje a co notifikace spustí, řeší domain/crm/mailWebhook.ts
// a domain/crm/mailWebhookRun.ts.
//
// Ověřeno proti Microsoft Learn (2026-09-28):
// - Životnost předplatného pro Outlook message/event/contact je nejvýš
//   „10,080 minutes (under seven days)"; hodnota pod 45 minut se sama zvedne
//   na 45 minut. Požadavek nad maximum má do budoucna selhat.
//   https://learn.microsoft.com/en-us/graph/api/resources/subscription?view=graph-rest-1.0
//   (tabulka „Subscription lifetime").
// - clientState: nejvýš 128 znaků; služba ho posílá v každé notifikaci
//   a příjemce ho má porovnat s hodnotou z vytvoření předplatného (tamtéž).
// - Validace notificationUrl (i lifecycleNotificationUrl): POST
//   ?validationToken=…, odpověď do 10 s: 200, text/plain, token URL-dekódovaný
//   v těle. Notifikace: 2xx do 3 s, jinak opakování až 4 h; když zpracování
//   trvá déle, validovat, zařadit a vrátit 202. Duplicitní předplatné (stejný
//   changeType + resource) → 409 Conflict. Obnova = PATCH expirationDateTime
//   (200), smazání = DELETE (204).
//   https://learn.microsoft.com/en-us/graph/change-notifications-delivery-webhooks
// - Lifecycle notifikace (subscriptionRemoved, missed, reauthorizationRequired)
//   chodí na lifecycleNotificationUrl, která smí být stejná jako
//   notificationUrl; přidat ji jde jen při vytvoření. PATCH s novou expirací
//   zároveň předplatné reautorizuje.
//   https://learn.microsoft.com/en-us/graph/change-notifications-lifecycle-events
//
// Bezpečnost: přístupový token ani clientState se nikdy nevrací v chybě ani
// nelogují. Chyba nese jen HTTP status a kód chyby Graphu. Soubor nic
// neloguje; logování je na volajícím.

import { createHash, createHmac } from 'node:crypto'
import { GRAPH_BASE, parseRetryAfter, type MailFolder } from './mail'
import { safeEqual } from './oauthState'

export const GRAPH_SUBSCRIPTIONS_URL = `${GRAPH_BASE}/subscriptions`

/** Maximum pro Outlook message (Microsoft Learn, viz hlavička souboru). */
export const OUTLOOK_MESSAGE_SUBSCRIPTION_MAX_MINUTES = 10_080
/** Kratší expiraci Graph sám zvedne na 45 minut. */
export const SUBSCRIPTION_MIN_MINUTES = 45
/**
 * Kolik si říkáme: maximum minus hodina rezervy na rozdíl hodin mezi námi
 * a Microsoftem — ať požadavek nikdy nepřekročí limit.
 */
export const SUBSCRIPTION_LIFETIME_MINUTES = OUTLOOK_MESSAGE_SUBSCRIPTION_MAX_MINUTES - 60
export const CLIENT_STATE_MAX_LENGTH = 128
/** Delší validationToken neodrážíme (Microsoftův token je krátký, neprůhledný). */
export const VALIDATION_TOKEN_MAX_LENGTH = 2048

// Vytvoření předplatného čeká, až Graph ověří náš endpoint (do 10 s),
// proto delší timeout než u ostatních volání.
const CREATE_TIMEOUT_MS = 20_000
const REQUEST_TIMEOUT_MS = 15_000

export type SubscriptionFetch = (url: string, init: RequestInit) => Promise<Response>

/** Zdroj pro předplatné nových zpráv ve složce (bez base URL, jak chce Graph). */
export function mailFolderSubscriptionResource(folder: MailFolder): string {
  return `me/mailFolders('${folder}')/messages`
}

/** Porovnání zdrojů: Graph může vrátit jinou velikost písmen nebo úvodní lomítko. */
export function sameSubscriptionResource(a: string, b: string): boolean {
  const norm = (s: string) => s.trim().replace(/^\/+/, '').toLowerCase()
  return norm(a) === norm(b)
}

/** ISO expirace za `minutes` minut od `nowMs`, oříznutá do povoleného rozsahu. */
export function subscriptionExpiration(nowMs: number, minutes: number = SUBSCRIPTION_LIFETIME_MINUTES): string {
  const m = Math.min(Math.max(minutes, SUBSCRIPTION_MIN_MINUTES), OUTLOOK_MESSAGE_SUBSCRIPTION_MAX_MINUTES)
  return new Date(nowMs + m * 60_000).toISOString()
}

// ---------------------------------------------------------------------------
// clientState

/**
 * clientState = HMAC-SHA256(secret, label) v base64url (43 znaků, pod
 * limitem 128). Deterministický: stejné tajemství + štítek dají stejnou
 * hodnotu, takže ji nikam neukládáme — ověřuje se přepočtem.
 */
export function deriveClientState(secret: string, label: string): string {
  if (!secret) throw new Error('clientState: chybí tajemství')
  if (!label) throw new Error('clientState: chybí štítek')
  return createHmac('sha256', secret).update(label, 'utf8').digest('base64url')
}

/** SHA-256 (hex) clientState — jediné, co o něm smí skončit v DB. */
export function clientStateHash(clientState: string): string {
  return createHash('sha256').update(clientState, 'utf8').digest('hex')
}

/** Porovnání v konstantním čase; chybějící/nepovolená hodnota se nerovná nikdy. */
export function clientStateMatches(received: unknown, expected: string): boolean {
  if (typeof received !== 'string' || received.length > CLIENT_STATE_MAX_LENGTH) return false
  return safeEqual(received, expected)
}

// ---------------------------------------------------------------------------
// Volání /subscriptions

export type GraphSubscription = {
  id: string
  resource: string
  expirationDateTime: string
}

export type SubscriptionCallResult<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'throttled'; retryAfterSeconds: number }
  /** 404 — předplatné už neexistuje (vypršelo / Microsoft ho zrušil). */
  | { kind: 'not_found' }
  /** 409 — pro stejný changeType + resource už předplatné existuje. */
  | { kind: 'conflict' }
  /** 403 — token nemá právo (typicky chybí Mail.Read). */
  | { kind: 'forbidden'; code: string | null }
  | { kind: 'error'; status: number; message: string }

export type CreateSubscriptionRequest = {
  resource: string
  notificationUrl: string
  /** Stejná URL jako notificationUrl (smí být, viz hlavička). */
  lifecycleNotificationUrl: string
  expirationDateTime: string
  clientState: string
}

// Id předplatného je GUID; nic jiného do URL ani do DB nepustíme.
const SUBSCRIPTION_ID_RE = /^[A-Za-z0-9-]{1,200}$/

export function isValidSubscriptionId(id: unknown): id is string {
  return typeof id === 'string' && SUBSCRIPTION_ID_RE.test(id)
}

function safeCode(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(value) ? value : null
}

async function readJson(res: Response): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await res.json()
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function toSubscription(json: Record<string, unknown> | null): GraphSubscription | null {
  if (!json) return null
  const { id, resource, expirationDateTime } = json
  if (!isValidSubscriptionId(id)) return null
  if (typeof resource !== 'string' || resource.length === 0 || resource.length > 500) return null
  if (typeof expirationDateTime !== 'string' || !Number.isFinite(Date.parse(expirationDateTime))) return null
  return { id, resource, expirationDateTime: new Date(expirationDateTime).toISOString() }
}

async function failure(res: Response): Promise<SubscriptionCallResult<never>> {
  if (res.status === 429 || res.status === 503) {
    return { kind: 'throttled', retryAfterSeconds: parseRetryAfter(res.headers.get('Retry-After')) }
  }
  if (res.status === 404) return { kind: 'not_found' }
  if (res.status === 409) return { kind: 'conflict' }
  const json = await readJson(res)
  const code = safeCode((json?.error as Record<string, unknown> | undefined)?.code)
  if (res.status === 403) return { kind: 'forbidden', code }
  return { kind: 'error', status: res.status, message: `Graph ${res.status}${code ? ` ${code}` : ''}` }
}

type Sent = { res: Response; fail?: undefined } | { res?: undefined; fail: SubscriptionCallResult<never> }

async function send(
  fetchImpl: SubscriptionFetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Sent> {
  try {
    return { res: await fetchImpl(url, { ...init, cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) }) }
  } catch (e) {
    // Timeout / síť — jen název výjimky, žádný text odpovědi.
    const name = e instanceof Error ? e.name : 'Error'
    return { fail: { kind: 'error', status: 0, message: `Graph nedostupný (${name})` } }
  }
}

function authHeaders(accessToken: string, json = false): Record<string, string> {
  return json
    ? { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }
    : { Authorization: `Bearer ${accessToken}` }
}

export async function createSubscription(
  accessToken: string,
  req: CreateSubscriptionRequest,
  fetchImpl: SubscriptionFetch = fetch,
): Promise<SubscriptionCallResult<GraphSubscription>> {
  if (!req.notificationUrl.startsWith('https://') || !req.lifecycleNotificationUrl.startsWith('https://')) {
    return { kind: 'error', status: 0, message: 'notificationUrl musí být https' }
  }
  if (!req.clientState || req.clientState.length > CLIENT_STATE_MAX_LENGTH) {
    return { kind: 'error', status: 0, message: 'Neplatný clientState' }
  }
  const body = {
    // Jen nové zprávy: odpověď klienta / odeslaný e-mail. Změny a mazání
    // nás nezajímají (sync ukládá jen metadata při vzniku).
    changeType: 'created',
    notificationUrl: req.notificationUrl,
    lifecycleNotificationUrl: req.lifecycleNotificationUrl,
    resource: req.resource,
    expirationDateTime: req.expirationDateTime,
    clientState: req.clientState,
  }
  const { res, fail } = await send(fetchImpl, GRAPH_SUBSCRIPTIONS_URL, {
    method: 'POST',
    headers: authHeaders(accessToken, true),
    body: JSON.stringify(body),
  }, CREATE_TIMEOUT_MS)
  if (fail) return fail
  if (res.status !== 201 && res.status !== 200) return failure(res)
  const sub = toSubscription(await readJson(res))
  return sub ? { kind: 'ok', value: sub } : { kind: 'error', status: res.status, message: 'Graph: neplatná odpověď na vytvoření předplatného' }
}

export async function renewSubscription(
  accessToken: string,
  subscriptionId: string,
  expirationDateTime: string,
  fetchImpl: SubscriptionFetch = fetch,
): Promise<SubscriptionCallResult<GraphSubscription>> {
  if (!isValidSubscriptionId(subscriptionId)) return { kind: 'error', status: 0, message: 'Neplatné id předplatného' }
  const { res, fail } = await send(fetchImpl, `${GRAPH_SUBSCRIPTIONS_URL}/${encodeURIComponent(subscriptionId)}`, {
    method: 'PATCH',
    headers: authHeaders(accessToken, true),
    body: JSON.stringify({ expirationDateTime }),
  }, REQUEST_TIMEOUT_MS)
  if (fail) return fail
  if (!res.ok) return failure(res)
  const sub = toSubscription(await readJson(res))
  return sub ? { kind: 'ok', value: sub } : { kind: 'error', status: res.status, message: 'Graph: neplatná odpověď na obnovu předplatného' }
}

/** Smazání; 404 (už neexistuje) volající obvykle bere jako úspěch. */
export async function deleteSubscription(
  accessToken: string,
  subscriptionId: string,
  fetchImpl: SubscriptionFetch = fetch,
): Promise<SubscriptionCallResult<null>> {
  if (!isValidSubscriptionId(subscriptionId)) return { kind: 'error', status: 0, message: 'Neplatné id předplatného' }
  const { res, fail } = await send(fetchImpl, `${GRAPH_SUBSCRIPTIONS_URL}/${encodeURIComponent(subscriptionId)}`, {
    method: 'DELETE',
    headers: authHeaders(accessToken),
  }, REQUEST_TIMEOUT_MS)
  if (fail) return fail
  if (res.ok) return { kind: 'ok', value: null }
  return failure(res)
}

/** Předplatná appky pro přihlášeného uživatele (jen první stránka — máme jich pár). */
export async function listSubscriptions(
  accessToken: string,
  fetchImpl: SubscriptionFetch = fetch,
): Promise<SubscriptionCallResult<GraphSubscription[]>> {
  const { res, fail } = await send(fetchImpl, GRAPH_SUBSCRIPTIONS_URL, {
    method: 'GET',
    headers: authHeaders(accessToken),
  }, REQUEST_TIMEOUT_MS)
  if (fail) return fail
  if (!res.ok) return failure(res)
  const json = await readJson(res)
  const value = Array.isArray(json?.value) ? json.value : []
  const subs = value
    .map((v) => toSubscription(v && typeof v === 'object' ? (v as Record<string, unknown>) : null))
    .filter((s): s is GraphSubscription => s !== null)
  return { kind: 'ok', value: subs }
}

// ---------------------------------------------------------------------------
// Příchozí notifikace (nedůvěryhodný vstup)

export type LifecycleEvent = 'missed' | 'subscriptionRemoved' | 'reauthorizationRequired'

const LIFECYCLE_EVENTS = new Set<string>(['missed', 'subscriptionRemoved', 'reauthorizationRequired'])

/**
 * Jedna notifikace po rozboru. Záměrně jen to, co potřebujeme: id předplatného
 * (klíč do naší tabulky), clientState (ověření původu), druh lifecycle události
 * a id zprávy. Nic dalšího z těla se nepoužije — data do DB jdou vždy z Graph
 * API (delta dotaz), nikdy z notifikace.
 */
export type IncomingNotification = {
  subscriptionId: string
  clientState: string | null
  /** null = běžná change notifikace; 'unknown' = neznámá lifecycle událost. */
  lifecycleEvent: LifecycleEvent | 'unknown' | null
  resourceId: string | null
}

export type ParsedNotificationCollection = {
  notifications: IncomingNotification[]
  /** Položky, které neprošly tvarem (bez id předplatného apod.). */
  malformed: number
}

/** Horní mez položek v jedné dávce — víc je podezřelé, zbytek se zahodí. */
export const MAX_NOTIFICATIONS_PER_BATCH = 500
const RESOURCE_ID_MAX_LENGTH = 512

/** { value: [...] } → notifikace; cokoli jiného na nejvyšší úrovni → null. */
export function parseNotificationCollection(body: unknown): ParsedNotificationCollection | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const value = (body as Record<string, unknown>).value
  if (!Array.isArray(value)) return null
  const notifications: IncomingNotification[] = []
  let malformed = 0
  for (const raw of value.slice(0, MAX_NOTIFICATIONS_PER_BATCH)) {
    if (!raw || typeof raw !== 'object') { malformed++; continue }
    const item = raw as Record<string, unknown>
    if (!isValidSubscriptionId(item.subscriptionId)) { malformed++; continue }
    const clientState = typeof item.clientState === 'string' && item.clientState.length <= CLIENT_STATE_MAX_LENGTH
      ? item.clientState
      : null
    const le = item.lifecycleEvent
    const lifecycleEvent = le === undefined || le === null
      ? null
      : typeof le === 'string' && LIFECYCLE_EVENTS.has(le) ? (le as LifecycleEvent) : 'unknown'
    const rd = item.resourceData as Record<string, unknown> | undefined
    const rid = rd && typeof rd === 'object' ? rd.id : undefined
    const resourceId = typeof rid === 'string' && rid.length > 0 && rid.length <= RESOURCE_ID_MAX_LENGTH ? rid : null
    notifications.push({ subscriptionId: item.subscriptionId, clientState, lifecycleEvent, resourceId })
  }
  malformed += Math.max(0, value.length - MAX_NOTIFICATIONS_PER_BATCH)
  return { notifications, malformed }
}
