// Gmail API — čtení schránky pro agenta příchozích poptávek.
//
// Jen transport: sestaví URL, pošle jeden požadavek a odpověď přeloží na
// jednoznačný výsledek (data / throttling / neplatný token / chybí právo /
// nenalezeno / chyba). Stav kurzoru (historyId), filtry a zápis do fronty
// řeší domain/crm/inquiryMailbox*.ts.
//
// Čtení nových zpráv: users.history.list od uloženého historyId (jen
// messageAdded ve štítku INBOX). Když je historyId moc staré (404), volající
// spadne na záložní polling users.messages.list s dotazem `newer_than:Nd`.
//
// Soukromí: metadata (format=metadata) nesou jen hlavičky z GMAIL_METADATA_HEADERS.
// Tělo (format=full) se čte jen pro rozhodnutí agenta a drží se jen v paměti;
// konektor nic z obsahu neloguje ani neukládá. Chyby nesou jen status a kód.

export const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me'

/** Hlavičky, které agent potřebuje k filtrům, deduplikaci a ověření odesílatele. */
export const GMAIL_METADATA_HEADERS = [
  'From', 'Reply-To', 'To', 'Cc', 'Delivered-To', 'X-Original-To', 'Message-ID', 'Subject',
  'Auto-Submitted', 'Precedence', 'List-Id', 'List-Unsubscribe', 'X-Autoreply', 'X-Auto-Response-Suppress',
  'Authentication-Results',
] as const

export type GmailHeader = { name: string; value: string }

export type GmailResult<T> =
  | { kind: 'ok'; data: T }
  | { kind: 'throttled'; retryAfterSeconds: number }
  /** 401 — přístupový token neplatí (obnoví se při dalším běhu). */
  | { kind: 'unauthorized' }
  /** 403 — schránka nedala právo (chybí rozsah nebo souhlas správce). */
  | { kind: 'forbidden'; reason: string | null }
  /** 404 — zpráva smazaná, nebo u history.list moc staré historyId. */
  | { kind: 'not_found' }
  | { kind: 'error'; status: number | null }

const THROTTLE_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'backendError'])

async function errorReason(res: Response): Promise<string | null> {
  try {
    const body = (await res.json()) as { error?: { errors?: { reason?: unknown }[]; status?: unknown } } | null
    const r = body?.error?.errors?.[0]?.reason ?? body?.error?.status
    return typeof r === 'string' && /^[A-Za-z_]{1,64}$/.test(r) ? r : null
  } catch {
    return null
  }
}

function retryAfter(res: Response): number {
  const v = Number(res.headers.get('retry-after'))
  return Number.isFinite(v) && v > 0 ? Math.min(Math.ceil(v), 3600) : 60
}

export type GmailFetchOptions = { fetchImpl?: typeof fetch; timeoutMs?: number }

/** Jeden GET na Gmail API → GmailResult. Nikdy nevyhazuje. */
export async function gmailGet<T>(accessToken: string, pathAndQuery: string, opts: GmailFetchOptions = {}): Promise<GmailResult<T>> {
  let res: Response
  try {
    res = await (opts.fetchImpl ?? fetch)(`${GMAIL_API}${pathAndQuery}`, {
      method: 'GET',
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20_000),
      headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
    })
  } catch {
    return { kind: 'error', status: null }
  }
  if (res.ok) {
    try {
      return { kind: 'ok', data: (await res.json()) as T }
    } catch {
      return { kind: 'error', status: res.status }
    }
  }
  if (res.status === 429) return { kind: 'throttled', retryAfterSeconds: retryAfter(res) }
  if (res.status === 401) return { kind: 'unauthorized' }
  if (res.status === 404) return { kind: 'not_found' }
  if (res.status === 403) {
    const reason = await errorReason(res)
    if (reason && THROTTLE_REASONS.has(reason)) return { kind: 'throttled', retryAfterSeconds: retryAfter(res) }
    return { kind: 'forbidden', reason }
  }
  if (res.status === 503 || res.status === 500) return { kind: 'throttled', retryAfterSeconds: retryAfter(res) }
  return { kind: 'error', status: res.status }
}

const mapOk = <A, B>(r: GmailResult<A>, f: (a: A) => B): GmailResult<B> => (r.kind === 'ok' ? { kind: 'ok', data: f(r.data) } : r)

// ---------------------------------------------------------------------------
// Profil a historie

export async function gmailProfile(accessToken: string, opts?: GmailFetchOptions): Promise<GmailResult<{ emailAddress: string | null; historyId: string | null }>> {
  const r = await gmailGet<{ emailAddress?: unknown; historyId?: unknown }>(accessToken, '/profile', opts)
  return mapOk(r, (d) => ({
    emailAddress: typeof d.emailAddress === 'string' ? d.emailAddress.toLowerCase() : null,
    historyId: typeof d.historyId === 'string' || typeof d.historyId === 'number' ? String(d.historyId) : null,
  }))
}

export type GmailHistoryPage = {
  messageIds: string[]
  nextPageToken: string | null
  /** Aktuální historyId schránky (platný kurzor až po přečtení všech stránek). */
  historyId: string | null
  /**
   * Záznamy historie v pořadí, jak přišly (vzestupně podle id), s novými
   * zprávami. Id záznamu je průběžný kurzor: po zpracování zpráv až po něj
   * včetně smí další čtení začít od něj (users.history.list startHistoryId).
   */
  records?: { id: string; messageIds: string[] }[]
}

type RawHistory = {
  history?: { id?: unknown; messagesAdded?: { message?: { id?: unknown; labelIds?: unknown } }[] }[]
  nextPageToken?: unknown
  historyId?: unknown
}

/**
 * Jedna stránka history.list (jen nové zprávy ve štítku INBOX).
 * `not_found` = historyId je moc staré → volající přejde na polling.
 */
export async function gmailHistoryPage(
  accessToken: string,
  startHistoryId: string,
  pageToken: string | null,
  opts?: GmailFetchOptions,
): Promise<GmailResult<GmailHistoryPage>> {
  const q = new URLSearchParams({ startHistoryId, historyTypes: 'messageAdded', labelId: 'INBOX', maxResults: '100' })
  if (pageToken) q.set('pageToken', pageToken)
  const r = await gmailGet<RawHistory>(accessToken, `/history?${q.toString()}`, opts)
  return mapOk(r, (d) => {
    const ids: string[] = []
    const records: { id: string; messageIds: string[] }[] = []
    for (const h of d.history ?? []) {
      const recIds: string[] = []
      for (const m of h.messagesAdded ?? []) {
        const id = m.message?.id
        if (typeof id === 'string' && id && !recIds.includes(id)) recIds.push(id)
        if (typeof id === 'string' && id && !ids.includes(id)) ids.push(id)
      }
      const rid = typeof h.id === 'string' || typeof h.id === 'number' ? String(h.id) : null
      if (rid && /^[0-9]{1,20}$/.test(rid)) records.push({ id: rid, messageIds: recIds })
    }
    return {
      messageIds: ids,
      records,
      nextPageToken: typeof d.nextPageToken === 'string' && d.nextPageToken ? d.nextPageToken : null,
      historyId: typeof d.historyId === 'string' || typeof d.historyId === 'number' ? String(d.historyId) : null,
    }
  })
}

/** Záložní polling: id zpráv podle dotazu Gmailu (např. `in:inbox newer_than:3d`). */
export async function gmailListMessageIds(
  accessToken: string,
  query: string,
  pageToken: string | null,
  opts?: GmailFetchOptions & { maxResults?: number },
): Promise<GmailResult<{ messageIds: string[]; nextPageToken: string | null }>> {
  const q = new URLSearchParams({ q: query, maxResults: String(Math.min(Math.max(opts?.maxResults ?? 50, 1), 500)) })
  if (pageToken) q.set('pageToken', pageToken)
  const r = await gmailGet<{ messages?: { id?: unknown }[]; nextPageToken?: unknown }>(accessToken, `/messages?${q.toString()}`, opts)
  return mapOk(r, (d) => ({
    messageIds: (d.messages ?? []).map((m) => m.id).filter((id): id is string => typeof id === 'string' && id.length > 0),
    nextPageToken: typeof d.nextPageToken === 'string' && d.nextPageToken ? d.nextPageToken : null,
  }))
}

// ---------------------------------------------------------------------------
// Zpráva

export type GmailMessageMeta = {
  id: string
  threadId: string | null
  labelIds: string[]
  /** Kdy zprávu přijal Gmail (ISO 8601 UTC), z internalDate. */
  receivedAt: string | null
  headers: GmailHeader[]
}

type RawPart = {
  mimeType?: unknown
  filename?: unknown
  headers?: { name?: unknown; value?: unknown }[]
  body?: { data?: unknown; size?: unknown; attachmentId?: unknown }
  parts?: RawPart[]
}
type RawMessage = { id?: unknown; threadId?: unknown; labelIds?: unknown; internalDate?: unknown; payload?: RawPart }

const headersOf = (p: RawPart | undefined): GmailHeader[] =>
  (p?.headers ?? [])
    .filter((h): h is { name: string; value: string } => typeof h.name === 'string' && typeof h.value === 'string')
    .map((h) => ({ name: h.name, value: h.value }))

function metaOf(d: RawMessage): GmailMessageMeta | null {
  if (typeof d.id !== 'string' || !d.id) return null
  const ms = typeof d.internalDate === 'string' || typeof d.internalDate === 'number' ? Number(d.internalDate) : NaN
  return {
    id: d.id,
    threadId: typeof d.threadId === 'string' && d.threadId ? d.threadId : null,
    labelIds: Array.isArray(d.labelIds) ? d.labelIds.filter((l): l is string => typeof l === 'string') : [],
    receivedAt: Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null,
    headers: headersOf(d.payload),
  }
}

/** Metadata zprávy (jen hlavičky z GMAIL_METADATA_HEADERS, bez těla). */
export async function gmailMessageMeta(accessToken: string, id: string, opts?: GmailFetchOptions): Promise<GmailResult<GmailMessageMeta>> {
  const q = new URLSearchParams({ format: 'metadata' })
  for (const h of GMAIL_METADATA_HEADERS) q.append('metadataHeaders', h)
  const r = await gmailGet<RawMessage>(accessToken, `/messages/${encodeURIComponent(id)}?${q.toString()}`, opts)
  if (r.kind !== 'ok') return r
  const meta = metaOf(r.data)
  return meta ? { kind: 'ok', data: meta } : { kind: 'error', status: 200 }
}

export type GmailMessageFull = GmailMessageMeta & {
  /** Text zprávy (text/plain, jinak text z text/html). Jen v paměti! */
  text: string
}

/** Celá zpráva včetně textu těla (jen pro rozhodnutí agenta, nikdy se neukládá). */
export async function gmailMessageFull(accessToken: string, id: string, opts?: GmailFetchOptions): Promise<GmailResult<GmailMessageFull>> {
  const r = await gmailGet<RawMessage>(accessToken, `/messages/${encodeURIComponent(id)}?format=full`, opts)
  if (r.kind !== 'ok') return r
  const meta = metaOf(r.data)
  if (!meta) return { kind: 'error', status: 200 }
  return { kind: 'ok', data: { ...meta, text: messageText(r.data.payload) } }
}

// ---------------------------------------------------------------------------
// MIME → text (čisté funkce, exportované kvůli testům)

/** base64url → bajty. */
export function decodeBase64Url(data: string): Uint8Array {
  return new Uint8Array(Buffer.from(data.replace(/-/g, '+').replace(/_/g, '/'), 'base64'))
}

function charsetOf(part: RawPart): string {
  const ct = headersOf(part).find((h) => h.name.toLowerCase() === 'content-type')?.value ?? ''
  return /charset="?([^";\s]+)"?/i.exec(ct)?.[1]?.toLowerCase() ?? 'utf-8'
}

function decodeText(bytes: Uint8Array, charset: string): string {
  try {
    return new TextDecoder(charset, { fatal: false }).decode(bytes)
  } catch {
    return new TextDecoder('utf-8').decode(bytes)
  }
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

/** Hrubý převod HTML na text (stačí pro čtení poptávky modelem). */
export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/?(p|div|tr|li|h[1-6]|blockquote)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
      if (e[0] === '#') {
        const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)
        return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : ' '
      }
      return ENTITIES[e.toLowerCase()] ?? m
    })
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]*/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim()
}

/** Text těla: první text/plain mimo přílohy, jinak text z text/html. */
export function messageText(payload: RawPart | undefined): string {
  if (!payload) return ''
  const plain: string[] = []
  const html: string[] = []
  const walk = (p: RawPart) => {
    const mime = typeof p.mimeType === 'string' ? p.mimeType.toLowerCase() : ''
    const isAttachment = typeof p.filename === 'string' && p.filename.length > 0
    const data = typeof p.body?.data === 'string' ? p.body.data : null
    if (!isAttachment && data) {
      if (mime === 'text/plain') plain.push(decodeText(decodeBase64Url(data), charsetOf(p)))
      else if (mime === 'text/html') html.push(decodeText(decodeBase64Url(data), charsetOf(p)))
    }
    for (const c of p.parts ?? []) walk(c)
  }
  walk(payload)
  if (plain.length > 0) return plain.join('\n\n').replace(/\r\n/g, '\n').trim()
  if (html.length > 0) return htmlToText(html.join('\n'))
  return ''
}

/** Hodnoty hlavičky (bez ohledu na velikost písmen), v pořadí zprávy. */
export function headerValues(headers: readonly GmailHeader[], name: string): string[] {
  const n = name.toLowerCase()
  return headers.filter((h) => h.name.toLowerCase() === n).map((h) => h.value)
}
