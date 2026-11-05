// Falešný Google (OAuth token + Gmail API), Anthropic Messages API a Mapy.cz
// (geokódování, trasa) pro integrační testy. Nahrazuje globální fetch: konektory (connectors/gmail,
// connectors/anthropic) běží beze změny, jen jim odpovídá tahle napodobenina.
// Jakýkoli jiný požadavek do sítě test shodí (žádná živá síť).

export type FakeGmailMessage = {
  id: string
  threadId: string
  labelIds: string[]
  internalDate: number
  headers: { name: string; value: string }[]
  text: string
  historyId: number
}

type Mailbox = { email: string; historyId: number; messages: FakeGmailMessage[] }

export type SentMail = { mailbox: string; id: string; threadId: string; raw: string; headers: Record<string, string>; text: string }

const b64url = (s: string) => Buffer.from(s, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const fromB64url = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')

/** RFC 2047 (=?UTF-8?B?…?=) → text. */
function decodeWords(v: string): string {
  return v.replace(/=\?utf-8\?b\?([^?]+)\?=/gi, (_, b: string) => Buffer.from(b, 'base64').toString('utf8'))
    .replace(/=\?utf-8\?q\?([^?]+)\?=/gi, (_, x: string) => Buffer.from(x.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (_m, h: string) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8'))
}

/** Hrubý rozbor MIME zprávy z odchozí fronty (hlavičky + text). */
export function parseMime(raw: string): { headers: Record<string, string>; text: string } {
  const sep = raw.indexOf('\r\n\r\n') >= 0 ? '\r\n\r\n' : '\n\n'
  const [head, ...rest] = raw.split(sep)
  const headers: Record<string, string> = {}
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = line.indexOf(':')
    if (i > 0) headers[line.slice(0, i).trim().toLowerCase()] = decodeWords(line.slice(i + 1).trim())
  }
  let body = rest.join(sep)
  const cte = (headers['content-transfer-encoding'] ?? '').toLowerCase()
  if (cte === 'base64') body = Buffer.from(body.replace(/\s+/g, ''), 'base64').toString('utf8')
  else if (cte === 'quoted-printable') {
    body = Buffer.from(body.replace(/=\r?\n/g, '').replace(/=([0-9A-F]{2})/gi, (_m, h: string) => String.fromCharCode(parseInt(h, 16))), 'latin1').toString('utf8')
  }
  return { headers, text: body.replace(/\r\n/g, '\n') }
}

export class FakeGoogle {
  private boxes = new Map<string, Mailbox>()
  private seq = 1000
  /** Odeslané zprávy (POST messages/send). */
  readonly sent: SentMail[] = []
  /** Každý požadavek do sítě (jen host + cesta, bez těla). */
  readonly requests: string[] = []
  /** Odpověď modelu na požadavek vytěžení poptávky (tělo požadavku Anthropic). */
  model: (request: { system: string; text: string }) => Record<string, unknown> = () => {
    throw new Error('FakeGoogle: model nemá připravenou odpověď')
  }
  modelCalls = 0
  /** Mapy.cz: délka trasy od provozovny (m) a geokódované texty míst. */
  routeMeters = 9_000
  readonly geocoded: string[] = []

  mailbox(email: string): Mailbox {
    const key = email.toLowerCase()
    let b = this.boxes.get(key)
    if (!b) {
      b = { email: key, historyId: 100, messages: [] }
      this.boxes.set(key, b)
    }
    return b
  }

  /** Doručí zprávu do schránky (INBOX). Vrací Gmail id. */
  deliver(email: string, m: { from: string; subject: string; text: string; messageId: string; threadId?: string; headers?: Record<string, string>; at?: Date }): FakeGmailMessage {
    const box = this.mailbox(email)
    const id = `m${(++this.seq).toString(16)}`
    const headers = [
      { name: 'From', value: m.from },
      { name: 'To', value: email },
      { name: 'Subject', value: m.subject },
      { name: 'Message-ID', value: m.messageId },
      ...Object.entries(m.headers ?? {}).map(([name, value]) => ({ name, value })),
    ]
    box.historyId += 1
    const msg: FakeGmailMessage = {
      id, threadId: m.threadId ?? `t${(++this.seq).toString(16)}`, labelIds: ['INBOX', 'UNREAD'],
      internalDate: (m.at ?? new Date()).getTime(), headers, text: m.text, historyId: box.historyId,
    }
    box.messages.push(msg)
    return msg
  }

  private boxOfToken(auth: string | null): Mailbox | null {
    const m = /^Bearer at-(.+)$/i.exec(auth ?? '')
    return m ? this.mailbox(decodeURIComponent(m[1])) : null
  }

  private messageJson(m: FakeGmailMessage, format: string | null, onlyHeaders: string[] | null) {
    const headers = onlyHeaders ? m.headers.filter((h) => onlyHeaders.some((x) => x.toLowerCase() === h.name.toLowerCase())) : m.headers
    const payload = format === 'full'
      ? { mimeType: 'text/plain', headers: [...headers, { name: 'Content-Type', value: 'text/plain; charset=utf-8' }], body: { data: b64url(m.text), size: m.text.length } }
      : { mimeType: 'text/plain', headers }
    return { id: m.id, threadId: m.threadId, labelIds: m.labelIds, internalDate: String(m.internalDate), historyId: String(m.historyId), payload }
  }

  /** Náhrada globálního fetch. */
  fetch = async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const method = (init.method ?? 'GET').toUpperCase()
    this.requests.push(`${method} ${url.host}${url.pathname}`)
    const headers = new Headers(init.headers)
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

    if (url.host === 'oauth2.googleapis.com' && url.pathname === '/token') {
      const form = new URLSearchParams(String(init.body ?? ''))
      const refresh = form.get('refresh_token') ?? ''
      const m = /^rt-(.+)$/.exec(refresh)
      if (!m || form.get('grant_type') !== 'refresh_token') return json({ error: 'invalid_grant' }, 400)
      return json({ access_token: `at-${encodeURIComponent(m[1])}`, expires_in: 3600, token_type: 'Bearer' })
    }

    if (url.host === 'gmail.googleapis.com' && url.pathname.startsWith('/gmail/v1/users/me')) {
      const box = this.boxOfToken(headers.get('authorization'))
      if (!box) return json({ error: { status: 'UNAUTHENTICATED' } }, 401)
      const path = url.pathname.slice('/gmail/v1/users/me'.length)
      if (method === 'GET' && path === '/profile') return json({ emailAddress: box.email, historyId: String(box.historyId) })
      if (method === 'GET' && path === '/history') {
        const start = Number(url.searchParams.get('startHistoryId'))
        const added = box.messages.filter((m) => m.historyId > start && m.labelIds.includes('INBOX'))
        return json({ history: added.map((m) => ({ id: String(m.historyId), messagesAdded: [{ message: { id: m.id, threadId: m.threadId, labelIds: m.labelIds } }] })), historyId: String(box.historyId) })
      }
      if (method === 'GET' && path === '/messages') {
        const q = url.searchParams.get('q') ?? ''
        const rfc = /^rfc822msgid:(.+)$/.exec(q)
        const list = rfc
          ? box.messages.filter((m) => m.headers.some((h) => h.name.toLowerCase() === 'message-id' && h.value === `<${rfc[1]}>`))
          : box.messages.filter((m) => m.labelIds.includes('INBOX'))
        return json({ messages: list.map((m) => ({ id: m.id, threadId: m.threadId })), resultSizeEstimate: list.length })
      }
      const msg = /^\/messages\/([^/]+)$/.exec(path)
      if (method === 'GET' && msg) {
        const m = box.messages.find((x) => x.id === decodeURIComponent(msg[1]))
        if (!m) return json({ error: { status: 'NOT_FOUND' } }, 404)
        const format = url.searchParams.get('format')
        const only = format === 'metadata' ? url.searchParams.getAll('metadataHeaders') : null
        return json(this.messageJson(m, format, only && only.length ? only : null))
      }
      const thr = /^\/threads\/([^/]+)$/.exec(path)
      if (method === 'GET' && thr) {
        const list = box.messages.filter((x) => x.threadId === decodeURIComponent(thr[1]))
        if (!list.length) return json({ error: { status: 'NOT_FOUND' } }, 404)
        return json({ id: thr[1], messages: list.map((m) => this.messageJson(m, 'metadata', ['From'])) })
      }
      if (method === 'POST' && path === '/messages/send') {
        const body = JSON.parse(String(init.body ?? '{}')) as { raw?: string; threadId?: string }
        const raw = fromB64url(body.raw ?? '')
        const parsed = parseMime(raw)
        const id = `s${(++this.seq).toString(16)}`
        const threadId = body.threadId ?? `t${(++this.seq).toString(16)}`
        box.historyId += 1
        box.messages.push({
          id, threadId, labelIds: ['SENT'], internalDate: Date.now(), historyId: box.historyId, text: parsed.text,
          headers: Object.entries(parsed.headers).map(([k, v]) => ({ name: k === 'message-id' ? 'Message-ID' : k === 'from' ? 'From' : k, value: v })),
        })
        this.sent.push({ mailbox: box.email, id, threadId, raw, headers: parsed.headers, text: parsed.text })
        return json({ id, threadId, labelIds: ['SENT'] })
      }
      return json({ error: { status: 'NOT_FOUND' } }, 404)
    }

    if (url.host === 'api.anthropic.com' && url.pathname === '/v1/messages' && method === 'POST') {
      if (!headers.get('x-api-key')) return json({ type: 'error', error: { type: 'authentication_error' } }, 401)
      const req = JSON.parse(String(init.body ?? '{}')) as { system?: string; messages?: { content?: { text?: string }[] }[] }
      this.modelCalls++
      const out = this.model({ system: req.system ?? '', text: req.messages?.[0]?.content?.[0]?.text ?? '' })
      return json({ id: `msg_${this.modelCalls}`, type: 'message', role: 'assistant', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(out) }] })
    }

    if (url.host === 'api.mapy.cz' && method === 'GET') {
      if (url.pathname === '/v1/geocode') {
        const query = url.searchParams.get('query') ?? ''
        this.geocoded.push(query)
        // Deterministický bod v Praze podle textu (jeden kandidát = jednoznačné místo).
        const h = [...query].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 1000, 7)
        return json({ items: [{ position: { lon: 14.4 + h / 10_000, lat: 50.07 + h / 20_000 }, type: 'regional.address', regionalStructure: [{ type: 'regional.country', isoCode: 'CZ' }] }] })
      }
      if (url.pathname === '/v1/routing/route') return json({ length: this.routeMeters, duration: 900 })
    }

    throw new Error(`Síť v testu není: ${method} ${url.host}${url.pathname}`)
  }
}

/** Hlavička Authentication-Results od Gmailu (SPF, DKIM i DMARC prošly). */
export function gmailAuthResults(domain: string): string {
  return `mx.google.com; dkim=pass header.i=@${domain} header.s=s1 header.b=abc; spf=pass (google.com: domain of info@${domain} designates 192.0.2.1 as permitted sender) smtp.mailfrom=info@${domain}; dmarc=pass (p=REJECT sp=REJECT dis=NONE) header.from=${domain}`
}
