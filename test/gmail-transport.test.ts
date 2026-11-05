// Konektor Gmail API (P2): token z refresh tokenu, mapování odpovědí
// (200 / 401 / 403 / 404 / 429), stránka historie a převod MIME na text.
// Bez sítě: fetch je vždy podvržený.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  gmailAccessToken,
  gmailConfigured,
  gmailGet,
  gmailHistoryPage,
  gmailMessageFull,
  gmailMessageMeta,
  gmailRefreshTokens,
  htmlToText,
  messageText,
  resetGmailTokenCache,
} from '@/connectors/gmail'

const b64 = (s: string | Uint8Array) => Buffer.from(s).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

const ENV = {
  GMAIL_OAUTH_CLIENT_ID: 'cid',
  GMAIL_OAUTH_CLIENT_SECRET: 'csecret',
  GMAIL_REFRESH_TOKENS: JSON.stringify({ 'Obchod@Firma.example': 'rt-1', 'spatne': 'x' }),
}

beforeEach(() => resetGmailTokenCache())

describe('token', () => {
  it('refresh tokeny z env: jen platné adresy, malými písmeny; nečitelný JSON = žádné', () => {
    expect([...gmailRefreshTokens(ENV).keys()]).toEqual(['obchod@firma.example'])
    expect(gmailRefreshTokens({ GMAIL_REFRESH_TOKENS: '{nejson' }).size).toBe(0)
    expect(gmailConfigured('obchod@firma.example', ENV)).toBe(true)
    expect(gmailConfigured('jina@firma.example', ENV)).toBe(false)
  })

  it('bez nastavení nic nevolá', async () => {
    const fetchImpl = vi.fn()
    expect(await gmailAccessToken('obchod@firma.example', { env: {}, fetchImpl })).toEqual({ ok: false, reason: 'not_configured', status: null })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('obnoví token, podruhé ho vezme z paměti', async () => {
    const fetchImpl = vi.fn(async () => json(200, { access_token: 'at-1', expires_in: 3600 }))
    expect(await gmailAccessToken('obchod@firma.example', { env: ENV, fetchImpl })).toEqual({ ok: true, accessToken: 'at-1' })
    expect(await gmailAccessToken('OBCHOD@firma.example', { env: ENV, fetchImpl })).toEqual({ ok: true, accessToken: 'at-1' })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const body = String((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body)
    expect(body).toContain('grant_type=refresh_token')
    expect(body).toContain('refresh_token=rt-1')
  })

  it('invalid_grant = schránku je potřeba připojit znovu', async () => {
    const fetchImpl = vi.fn(async () => json(400, { error: 'invalid_grant' }))
    expect(await gmailAccessToken('obchod@firma.example', { env: ENV, fetchImpl })).toEqual({ ok: false, reason: 'invalid_grant', status: 400 })
  })
})

describe('mapování odpovědí', () => {
  const call = (res: Response) => gmailGet('t', '/profile', { fetchImpl: vi.fn(async () => res) })

  it('200 → data, Authorization nese token', async () => {
    const fetchImpl = vi.fn(async () => json(200, { historyId: '42' }))
    expect(await gmailGet('tok', '/profile', { fetchImpl })).toEqual({ kind: 'ok', data: { historyId: '42' } })
    const init = (fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1]
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer tok')
  })

  it('401, 403 bez práva, 403 s limitem, 404, 429 a 500', async () => {
    expect(await call(json(401, {}))).toEqual({ kind: 'unauthorized' })
    expect(await call(json(403, { error: { errors: [{ reason: 'insufficientPermissions' }] } }))).toEqual({ kind: 'forbidden', reason: 'insufficientPermissions' })
    expect(await call(json(403, { error: { errors: [{ reason: 'userRateLimitExceeded' }] } }, { 'retry-after': '30' }))).toEqual({ kind: 'throttled', retryAfterSeconds: 30 })
    expect(await call(json(404, {}))).toEqual({ kind: 'not_found' })
    expect(await call(json(429, {}))).toEqual({ kind: 'throttled', retryAfterSeconds: 60 })
    expect(await call(json(500, {}))).toEqual({ kind: 'throttled', retryAfterSeconds: 60 })
    expect(await call(json(418, {}))).toEqual({ kind: 'error', status: 418 })
  })

  it('výpadek sítě = error bez výjimky', async () => {
    const r = await gmailGet('t', '/profile', { fetchImpl: vi.fn(async () => { throw new Error('fetch failed') }) })
    expect(r).toEqual({ kind: 'error', status: null })
  })
})

describe('historie a zprávy', () => {
  it('history.list: jen nové zprávy, bez duplicit, s kurzorem a další stránkou', async () => {
    const fetchImpl = vi.fn(async () =>
      json(200, {
        history: [{ id: '950', messagesAdded: [{ message: { id: 'm1' } }, { message: { id: 'm2' } }] }, { id: '960', messagesAdded: [{ message: { id: 'm1' } }] }, { id: '970' }, { id: 'x' }],
        nextPageToken: 'p2',
        historyId: '1001',
      }),
    )
    const r = await gmailHistoryPage('t', '900', null, { fetchImpl })
    expect(r).toEqual({
      kind: 'ok',
      data: {
        messageIds: ['m1', 'm2'], nextPageToken: 'p2', historyId: '1001',
        // Záznamy s id (průběžný kurzor); záznam bez nových zpráv se drží také, neplatné id ne.
        records: [{ id: '950', messageIds: ['m1', 'm2'] }, { id: '960', messageIds: ['m1'] }, { id: '970', messageIds: [] }],
      },
    })
    const url = (fetchImpl.mock.calls[0] as unknown as [string])[0]
    expect(url).toContain('startHistoryId=900')
    expect(url).toContain('historyTypes=messageAdded')
    expect(url).toContain('labelId=INBOX')
  })

  it('history.list 404 = moc staré historyId', async () => {
    expect(await gmailHistoryPage('t', '1', null, { fetchImpl: vi.fn(async () => json(404, {})) })).toEqual({ kind: 'not_found' })
  })

  it('metadata: hlavičky, štítky a čas přijetí; žádá jen vybrané hlavičky', async () => {
    const fetchImpl = vi.fn(async () =>
      json(200, { id: 'm1', threadId: 't1', labelIds: ['INBOX', 'UNREAD'], internalDate: '1793865600000', payload: { headers: [{ name: 'From', value: 'a@b.cz' }] } }),
    )
    const r = await gmailMessageMeta('t', 'm1', { fetchImpl })
    expect(r).toEqual({
      kind: 'ok',
      data: { id: 'm1', threadId: 't1', labelIds: ['INBOX', 'UNREAD'], receivedAt: new Date(1793865600000).toISOString(), headers: [{ name: 'From', value: 'a@b.cz' }] },
    })
    const url = (fetchImpl.mock.calls[0] as unknown as [string])[0]
    expect(url).toContain('format=metadata')
    expect(url).toContain('metadataHeaders=Authentication-Results')
  })

  it('celá zpráva: text/plain mimo přílohy, i v kódování windows-1250', async () => {
    const cp1250 = new Uint8Array([0x50, 0xf8, 0xed, 0x9e, 0x74, 0x69]) // „Přížti" v cp1250 (ř=0xf8, í=0xed, ž=0x9e)
    const payload = {
      mimeType: 'multipart/mixed',
      parts: [
        { mimeType: 'text/plain', filename: '', headers: [{ name: 'Content-Type', value: 'text/plain; charset="windows-1250"' }], body: { data: b64(cp1250) } },
        { mimeType: 'text/plain', filename: 'priloha.txt', body: { attachmentId: 'a1', size: 10 } },
      ],
    }
    const r = await gmailMessageFull('t', 'm1', { fetchImpl: vi.fn(async () => json(200, { id: 'm1', labelIds: [], payload })) })
    expect(r.kind === 'ok' && r.data.text).toBe('Přížti')
  })
})

describe('MIME → text', () => {
  it('bez text/plain se vezme text z HTML', () => {
    const html = '<html><head><style>p{}</style></head><body><p>Dobrý&nbsp;den,</p><p>chceme raut pro 50&#160;hostů &amp; víno.</p><script>x()</script></body></html>'
    expect(messageText({ mimeType: 'text/html', body: { data: b64(html) } })).toBe('Dobrý den,\nchceme raut pro 50 hostů & víno.')
  })

  it('htmlToText zalomí řádky a odstraní značky', () => {
    expect(htmlToText('a<br>b<div>c</div>')).toBe('a\nb\nc')
  })
})
