// Gmail API — odeslání zprávy zákazníkovi a dohledání odeslané zprávy
// (odchozí fronta agenta, balík P3). Jen transport, žádná doménová logika:
// kdo, co a kdy posílá, řeší domain/crm/agentOutboxService.ts.
//
// Gmail API (Google Workspace, interní OAuth aplikace firmy):
// - Odeslání: POST /gmail/v1/users/me/messages/send, tělo { raw, threadId? },
//   raw = celá zpráva RFC 5322 v base64url. Úspěch = 200 a Message
//   { id, threadId, labelIds } — id je potvrzení, že Gmail zprávu přijal
//   a uložil do Odeslané pošty. Rozsah gmail.send.
//   https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send
// - Odpověď ve vlákně: threadId původní zprávy + hlavičky In-Reply-To
//   a References + stejný předmět (s „Re:").
//   https://developers.google.com/workspace/gmail/api/guides/threads
// - Hlavičky původní zprávy: GET /messages/{id}?format=metadata&metadataHeaders=…
//   (rozsah gmail.readonly). Vlákno: GET /threads/{id}?format=metadata.
// - Dohledání odeslané zprávy podle vlastního Message-ID:
//   GET /messages?q=rfc822msgid:<…>&includeSpamTrash=true (gmail.readonly).
// - Limity: 429 nebo 403 s důvodem rateLimitExceeded / userRateLimitExceeded
//   / dailyLimitExceeded = zpráva NEBYLA přijata, zkusí se později.
//
// Bezpečnost: token ani text zprávy se nikdy nevrací v chybě ani nelogují.
// Výsledek nese jen druh, HTTP status a bezpečný kód důvodu.

export const GMAIL_API_BASE = 'https://gmail.googleapis.com/gmail/v1/users/me'

export type GmailFetch = (url: string, init: RequestInit) => Promise<Response>

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/

/** Bezpečný kód důvodu z chyby Google API (jen tokeny bez dat). */
function safeReason(json: unknown): string {
  const err = (json as { error?: { errors?: { reason?: unknown }[]; status?: unknown } } | null)?.error
  const r = err?.errors?.[0]?.reason ?? err?.status
  return typeof r === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(r) ? r : 'unknown'
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json()
  } catch {
    return null
  }
}

const THROTTLE_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'dailyLimitExceeded', 'quotaExceeded', 'RESOURCE_EXHAUSTED'])

// --- Sestavení zprávy (RFC 5322 + MIME) -----------------------------------------

export interface OutgoingGmailMessage {
  from: { name: string; address: string }
  to: string
  subject: string
  text: string
  /** Vlastní Message-ID včetně lomených závorek (<…@doména>). */
  messageId: string
  /** Message-ID zprávy, na kterou se odpovídá. */
  inReplyTo?: string | null
  /** Hlavička References původní zprávy (řetěz vlákna). */
  references?: string | null
  date: Date
  /** Další hlavičky (jen ASCII názvy a hodnoty, bez konců řádků). */
  extraHeaders?: Readonly<Record<string, string>>
}

/** Hodnota hlavičky bez CR/LF (ochrana proti vložení hlavičky). */
function oneLine(v: string): string {
  return v.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim()
}

/** RFC 2047 encoded-word pro ne-ASCII text (předmět, zobrazované jméno). */
export function encodeHeaderWord(v: string): string {
  const s = oneLine(v)
  if (/^[\x20-\x7e]*$/.test(s)) return s
  // Kousky po nejvýš 45 bajtech, ať se nerozdělí znak UTF-8 a řádek nepřeteče.
  const words: string[] = []
  let chunk = ''
  for (const ch of s) {
    if (Buffer.byteLength(chunk + ch, 'utf8') > 45) {
      words.push(chunk)
      chunk = ''
    }
    chunk += ch
  }
  if (chunk) words.push(chunk)
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w, 'utf8').toString('base64')}?=`).join('\r\n ')
}

function addressHeader(name: string, address: string): string {
  const n = oneLine(name)
  if (!n) return `<${address}>`
  const display = /^[\x20-\x7e]*$/.test(n) ? `"${n.replace(/["\\]/g, '')}"` : encodeHeaderWord(n)
  return `${display} <${address}>`
}

const ADDRESS_RE = /^[^@\s<>,;"()]+@[^@\s<>,;"()]+\.[^@\s<>,;"()]+$/
const MSGID_RE = /^<[^<>\s]{1,250}>$/

/** Celá zpráva RFC 5322 (text/plain, UTF-8, base64). Neplatný vstup = výjimka. */
export function buildMimeMessage(m: OutgoingGmailMessage): string {
  if (!ADDRESS_RE.test(m.from.address) || !ADDRESS_RE.test(m.to)) throw new Error('gmail.mime: neplatná adresa')
  if (!MSGID_RE.test(m.messageId)) throw new Error('gmail.mime: neplatné Message-ID')
  const inReplyTo = m.inReplyTo && MSGID_RE.test(m.inReplyTo.trim()) ? m.inReplyTo.trim() : null
  const refs = (m.references ?? '').split(/\s+/).filter((r) => MSGID_RE.test(r))
  if (inReplyTo && !refs.includes(inReplyTo)) refs.push(inReplyTo)

  const headers: string[] = [
    `From: ${addressHeader(m.from.name, m.from.address)}`,
    `To: <${m.to}>`,
    `Subject: ${encodeHeaderWord(m.subject)}`,
    `Date: ${m.date.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: ${m.messageId}`,
  ]
  if (inReplyTo) headers.push(`In-Reply-To: ${inReplyTo}`)
  // Řetěz References zkrátit zleva (RFC 5322 doporučuje první + poslední).
  if (refs.length > 0) headers.push(`References: ${(refs.length > 20 ? [refs[0], ...refs.slice(-19)] : refs).join('\r\n ')}`)
  for (const [k, v] of Object.entries(m.extraHeaders ?? {})) {
    if (!/^[A-Za-z][A-Za-z0-9-]{0,60}$/.test(k)) throw new Error('gmail.mime: neplatná hlavička')
    const value = oneLine(v)
    if (!/^[\x20-\x7e]*$/.test(value)) throw new Error('gmail.mime: hlavička mimo ASCII')
    headers.push(`${k}: ${value}`)
  }
  headers.push('MIME-Version: 1.0', 'Content-Type: text/plain; charset=UTF-8', 'Content-Transfer-Encoding: base64')

  const body = Buffer.from(m.text.replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64').replace(/.{1,76}/g, '$&\r\n')
  return `${headers.join('\r\n')}\r\n\r\n${body}`
}

export function base64Url(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// --- Odeslání -------------------------------------------------------------------

export type GmailSendOutcome =
  /** Gmail zprávu přijal (id = potvrzení). */
  | { kind: 'accepted'; id: string; threadId: string | null }
  /** Limit Gmailu: zpráva prokazatelně NEBYLA přijata. */
  | { kind: 'throttled'; status: number; reason: string }
  /** Neplatný token (401): zpráva nebyla přijata, schránku je potřeba připojit znovu. */
  | { kind: 'unauthorized'; status: number; reason: string }
  /** Chybí oprávnění (403 mimo limit). */
  | { kind: 'forbidden'; status: number; reason: string }
  /** Gmail zprávu odmítl (4xx) — neodešla. */
  | { kind: 'rejected'; status: number; reason: string }
  /** Výpadek sítě, 5xx nebo nečitelná odpověď: NENÍ jisté, jestli zpráva odešla. */
  | { kind: 'uncertain'; status: number; reason: string }

export async function sendGmailMessage(
  accessToken: string,
  msg: { raw: string; threadId?: string | null },
  fetchImpl: GmailFetch = fetch,
): Promise<GmailSendOutcome> {
  const body: Record<string, string> = { raw: msg.raw }
  if (msg.threadId && ID_RE.test(msg.threadId)) body.threadId = msg.threadId
  let res: Response
  try {
    res = await fetchImpl(`${GMAIL_API_BASE}/messages/send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
    })
  } catch {
    return { kind: 'uncertain', status: 0, reason: 'network' }
  }
  const json = await readJson(res)
  if (res.ok) {
    const id = (json as { id?: unknown } | null)?.id
    const threadId = (json as { threadId?: unknown } | null)?.threadId
    if (typeof id === 'string' && ID_RE.test(id)) {
      return { kind: 'accepted', id, threadId: typeof threadId === 'string' && ID_RE.test(threadId) ? threadId : null }
    }
    return { kind: 'uncertain', status: res.status, reason: 'no_id' }
  }
  const reason = safeReason(json)
  if (res.status === 429 || (res.status === 403 && THROTTLE_REASONS.has(reason))) return { kind: 'throttled', status: res.status, reason }
  if (res.status === 401) return { kind: 'unauthorized', status: res.status, reason }
  if (res.status === 403) return { kind: 'forbidden', status: res.status, reason }
  if (res.status >= 400 && res.status < 500 && res.status !== 408) return { kind: 'rejected', status: res.status, reason }
  return { kind: 'uncertain', status: res.status, reason }
}

// --- Čtení metadat --------------------------------------------------------------

export type GmailReadError = { ok: false; kind: 'not_found' | 'unauthorized' | 'forbidden' | 'error'; status: number }

function readError(status: number): GmailReadError {
  if (status === 404) return { ok: false, kind: 'not_found', status }
  if (status === 401) return { ok: false, kind: 'unauthorized', status }
  if (status === 403) return { ok: false, kind: 'forbidden', status }
  return { ok: false, kind: 'error', status }
}

async function getJson(accessToken: string, url: string, fetchImpl: GmailFetch): Promise<{ ok: true; json: unknown } | GmailReadError> {
  let res: Response
  try {
    res = await fetchImpl(url, { method: 'GET', headers: { Authorization: `Bearer ${accessToken}` }, cache: 'no-store' })
  } catch {
    return { ok: false, kind: 'error', status: 0 }
  }
  if (!res.ok) return readError(res.status)
  const json = await readJson(res)
  return json && typeof json === 'object' ? { ok: true, json } : { ok: false, kind: 'error', status: res.status }
}

type RawHeader = { name?: unknown; value?: unknown }

function headerValues(headers: unknown, name: string): string[] {
  if (!Array.isArray(headers)) return []
  return (headers as RawHeader[])
    .filter((h) => typeof h?.name === 'string' && h.name.toLowerCase() === name.toLowerCase() && typeof h.value === 'string')
    .map((h) => h.value as string)
}

/** Hlavičky původní zprávy potřebné k odpovědi ve vlákně. */
export interface GmailReplyMeta {
  id: string
  threadId: string | null
  internalDate: number | null
  labelIds: string[]
  from: string | null
  replyTo: string | null
  messageId: string | null
  references: string | null
  subject: string | null
  /** Všechny hlavičky Authentication-Results v pořadí shora (nejnovější první). */
  authResults: string[]
}

const META_HEADERS = ['From', 'Reply-To', 'Message-ID', 'References', 'Subject', 'Authentication-Results']

function toMeta(m: Record<string, unknown>): GmailReplyMeta | null {
  const id = m.id
  if (typeof id !== 'string' || !ID_RE.test(id)) return null
  const headers = (m.payload as { headers?: unknown } | undefined)?.headers
  const first = (n: string) => headerValues(headers, n)[0] ?? null
  const internal = Number(m.internalDate)
  return {
    id,
    threadId: typeof m.threadId === 'string' && ID_RE.test(m.threadId) ? m.threadId : null,
    internalDate: Number.isFinite(internal) ? internal : null,
    labelIds: Array.isArray(m.labelIds) ? m.labelIds.filter((x): x is string => typeof x === 'string') : [],
    from: first('From'),
    replyTo: first('Reply-To'),
    messageId: first('Message-ID') ?? first('Message-Id'),
    references: first('References'),
    subject: first('Subject'),
    authResults: headerValues(headers, 'Authentication-Results'),
  }
}

export async function getGmailMessageMeta(
  accessToken: string,
  messageId: string,
  fetchImpl: GmailFetch = fetch,
): Promise<{ ok: true; message: GmailReplyMeta } | GmailReadError> {
  if (!ID_RE.test(messageId)) return { ok: false, kind: 'not_found', status: 0 }
  const qs = ['format=metadata', ...META_HEADERS.map((h) => `metadataHeaders=${encodeURIComponent(h)}`)].join('&')
  const r = await getJson(accessToken, `${GMAIL_API_BASE}/messages/${encodeURIComponent(messageId)}?${qs}`, fetchImpl)
  if (!r.ok) return r
  const meta = toMeta(r.json as Record<string, unknown>)
  return meta ? { ok: true, message: meta } : { ok: false, kind: 'error', status: 200 }
}

/** Zprávy vlákna (jen metadata From a štítky) — kvůli odpovědi zákazníka po zařazení. */
export async function getGmailThreadMeta(
  accessToken: string,
  threadId: string,
  fetchImpl: GmailFetch = fetch,
): Promise<{ ok: true; messages: GmailReplyMeta[] } | GmailReadError> {
  if (!ID_RE.test(threadId)) return { ok: false, kind: 'not_found', status: 0 }
  const qs = ['format=metadata', 'metadataHeaders=From'].join('&')
  const r = await getJson(accessToken, `${GMAIL_API_BASE}/threads/${encodeURIComponent(threadId)}?${qs}`, fetchImpl)
  if (!r.ok) return r
  const msgs = (r.json as { messages?: unknown }).messages
  const out = Array.isArray(msgs) ? msgs.map((m) => (m && typeof m === 'object' ? toMeta(m as Record<string, unknown>) : null)).filter((m): m is GmailReplyMeta => m !== null) : []
  return { ok: true, messages: out }
}

/**
 * Odeslaná zpráva podle vlastního Message-ID (nejisté odeslání). Vrací id
 * zprávy v Gmailu, nebo null, když ve schránce není.
 */
export async function findGmailMessageByRfcId(
  accessToken: string,
  rfcMessageId: string,
  fetchImpl: GmailFetch = fetch,
): Promise<{ ok: true; found: { id: string; threadId: string | null } | null } | GmailReadError> {
  if (!MSGID_RE.test(rfcMessageId)) return { ok: false, kind: 'error', status: 0 }
  const q = `rfc822msgid:${rfcMessageId.slice(1, -1)}`
  const r = await getJson(accessToken, `${GMAIL_API_BASE}/messages?q=${encodeURIComponent(q)}&includeSpamTrash=true&maxResults=5`, fetchImpl)
  if (!r.ok) return r
  const list = (r.json as { messages?: unknown }).messages
  const first = Array.isArray(list) ? (list[0] as { id?: unknown; threadId?: unknown } | undefined) : undefined
  if (!first || typeof first.id !== 'string' || !ID_RE.test(first.id)) return { ok: true, found: null }
  return { ok: true, found: { id: first.id, threadId: typeof first.threadId === 'string' && ID_RE.test(first.threadId) ? first.threadId : null } }
}
