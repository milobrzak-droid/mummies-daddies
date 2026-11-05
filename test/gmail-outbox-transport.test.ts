// Konektor Gmail odchozí fronty (@/connectors/gmailOutbox): přesné URL a tělo
// users.messages.send (vlákno, hlavičky odpovědi), mapování odpovědí na
// accepted / throttled / unauthorized / forbidden / rejected / uncertain,
// metadata zprávy, dohledání podle Message-ID a obnova tokenu. Bez sítě.
import { describe, expect, test, vi } from 'vitest'
import {
  GMAIL_API_BASE,
  GOOGLE_TOKEN_URL,
  base64Url,
  buildMimeMessage,
  encodeHeaderWord,
  findGmailMessageByRfcId,
  getGmailMessageMeta,
  getGmailThreadMeta,
  refreshGoogleAccessToken,
  sendGmailMessage,
} from '@/connectors/gmailOutbox'

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

const decodeRaw = (raw: string) => Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')

const MSG = {
  from: { name: 'Mummies Test', address: 'obchod@firma.example' },
  to: 'karel@alfa.example',
  subject: 'Re: Poptávka cateringu – 40 hostů',
  text: 'Dobrý den,\nposíláme nabídku.\nŽluťoučký kůň.',
  messageId: '<ao.7.abc@firma.example>',
  inReplyTo: '<orig-1@alfa.example>',
  references: '<root@alfa.example> <orig-1@alfa.example>',
  date: new Date('2026-11-05T10:00:00Z'),
  extraHeaders: { 'X-Cockpit-Outbox': '7' },
}

describe('sestavení zprávy', () => {
  test('hlavičky odpovědi ve vlákně, UTF-8 předmět, base64 tělo', () => {
    const mime = buildMimeMessage(MSG)
    const [head, body] = mime.split('\r\n\r\n')
    expect(head).toContain('From: "Mummies Test" <obchod@firma.example>')
    expect(head).toContain('To: <karel@alfa.example>')
    expect(head).toContain('Message-ID: <ao.7.abc@firma.example>')
    expect(head).toContain('In-Reply-To: <orig-1@alfa.example>')
    expect(head).toMatch(/References: <root@alfa.example>\r\n <orig-1@alfa.example>/)
    expect(head).toContain('X-Cockpit-Outbox: 7')
    expect(head).toContain('Content-Type: text/plain; charset=UTF-8')
    expect(head).toMatch(/^Subject: =\?UTF-8\?B\?/m)
    expect(head).toContain('Date: Thu, 05 Nov 2026 10:00:00 +0000')
    expect(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString('utf8')).toBe('Dobrý den,\r\nposíláme nabídku.\r\nŽluťoučký kůň.')
    // Předmět se dekóduje zpět beze ztráty.
    const words = [...head.matchAll(/=\?UTF-8\?B\?([^?]+)\?=/g)].map((m) => Buffer.from(m[1], 'base64').toString('utf8')).join('')
    expect(words).toBe(MSG.subject)
  })

  test('vložení hlavičky přes CR/LF nejde; neplatné adresy a Message-ID shodí sestavení', () => {
    const mime = buildMimeMessage({ ...MSG, subject: 'Ahoj\r\nBcc: utok@evil.example' })
    expect(mime).not.toMatch(/^Bcc:/m)
    expect(() => buildMimeMessage({ ...MSG, to: 'a@b.example\r\nBcc: x@y.example' })).toThrow()
    expect(() => buildMimeMessage({ ...MSG, messageId: 'bez-zavorek' })).toThrow()
    expect(() => buildMimeMessage({ ...MSG, extraHeaders: { 'X-A': 'ž' } })).toThrow()
    expect(encodeHeaderWord('Plain ASCII')).toBe('Plain ASCII')
  })

  test('nová zpráva bez vlákna nemá In-Reply-To ani References', () => {
    const mime = buildMimeMessage({ ...MSG, inReplyTo: null, references: null })
    expect(mime).not.toMatch(/In-Reply-To|References/)
  })
})

describe('users.messages.send', () => {
  test('přesné URL, tělo s raw a threadId; 200 s id = accepted', async () => {
    const f = vi.fn(async () => json(200, { id: '18c0ffee', threadId: 'thr9', labelIds: ['SENT'] }))
    const raw = base64Url(buildMimeMessage(MSG))
    expect(raw).not.toMatch(/[+/=]/)
    const r = await sendGmailMessage('tok', { raw, threadId: 'thr9' }, f)
    expect(r).toEqual({ kind: 'accepted', id: '18c0ffee', threadId: 'thr9' })
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(`${GMAIL_API_BASE}/messages/send`)
    expect(url).toBe('https://gmail.googleapis.com/gmail/v1/users/me/messages/send')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok')
    expect(JSON.parse(init.body as string)).toEqual({ raw, threadId: 'thr9' })
    expect(decodeRaw(raw)).toContain('In-Reply-To: <orig-1@alfa.example>')
  })

  test('nová zpráva: bez threadId v těle', async () => {
    const f = vi.fn(async () => json(200, { id: 'abc', threadId: 'new1' }))
    await sendGmailMessage('tok', { raw: 'eA', threadId: null }, f)
    expect(JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)).toEqual({ raw: 'eA' })
  })

  test.each([
    [429, { error: { errors: [{ reason: 'rateLimitExceeded' }] } }, 'throttled'],
    [403, { error: { errors: [{ reason: 'userRateLimitExceeded' }] } }, 'throttled'],
    [403, { error: { errors: [{ reason: 'dailyLimitExceeded' }] } }, 'throttled'],
    [403, { error: { errors: [{ reason: 'insufficientPermissions' }] } }, 'forbidden'],
    [401, { error: { status: 'UNAUTHENTICATED' } }, 'unauthorized'],
    [400, { error: { errors: [{ reason: 'invalidArgument' }] } }, 'rejected'],
    [500, { error: { errors: [{ reason: 'backendError' }] } }, 'uncertain'],
    [503, null, 'uncertain'],
    [200, { nic: true }, 'uncertain'],
  ])('HTTP %i → %s', async (status, body, kind) => {
    const r = await sendGmailMessage('tok', { raw: 'eA' }, async () => (body === null ? new Response('x', { status }) : json(status, body)))
    expect(r.kind).toBe(kind)
  })

  test('výpadek sítě = nejisté (nikdy „neodesláno")', async () => {
    const r = await sendGmailMessage('tok', { raw: 'eA' }, async () => { throw new Error('ECONNRESET') })
    expect(r).toEqual({ kind: 'uncertain', status: 0, reason: 'network' })
  })

  test('chyba nenese text odpovědi Googlu', async () => {
    const r = await sendGmailMessage('tok', { raw: 'eA' }, async () => json(400, { error: { message: 'karel@alfa.example je špatně', errors: [{ reason: 'bad reason with spaces' }] } }))
    expect(JSON.stringify(r)).not.toContain('karel@')
    expect(r).toMatchObject({ kind: 'rejected', reason: 'unknown' })
  })
})

describe('čtení metadat a dohledání', () => {
  test('metadata zprávy: URL s metadataHeaders, hlavičky v pořadí', async () => {
    const f = vi.fn(async () => json(200, {
      id: 'm1', threadId: 't1', internalDate: '1762336800000', labelIds: ['INBOX'],
      payload: { headers: [
        { name: 'From', value: 'Karel <karel@alfa.example>' },
        { name: 'Message-ID', value: '<orig-1@alfa.example>' },
        { name: 'Authentication-Results', value: 'mx.google.com; dmarc=pass' },
        { name: 'Authentication-Results', value: 'jiny.example; dmarc=fail' },
        { name: 'Subject', value: 'Poptávka' },
      ] },
    }))
    const r = await getGmailMessageMeta('tok', 'm1', f)
    const url = (f.mock.calls[0] as unknown as [string])[0]
    expect(url).toBe(`${GMAIL_API_BASE}/messages/m1?format=metadata&metadataHeaders=From&metadataHeaders=Reply-To&metadataHeaders=Message-ID&metadataHeaders=References&metadataHeaders=Subject&metadataHeaders=Authentication-Results`)
    expect(r).toEqual({ ok: true, message: {
      id: 'm1', threadId: 't1', internalDate: 1762336800000, labelIds: ['INBOX'], from: 'Karel <karel@alfa.example>', replyTo: null,
      messageId: '<orig-1@alfa.example>', references: null, subject: 'Poptávka',
      authResults: ['mx.google.com; dmarc=pass', 'jiny.example; dmarc=fail'],
    } })
    expect(await getGmailMessageMeta('tok', 'm1', async () => json(404, {}))).toMatchObject({ ok: false, kind: 'not_found' })
    expect(await getGmailMessageMeta('tok', '../x', f)).toMatchObject({ ok: false, kind: 'not_found' })
  })

  test('vlákno a dohledání podle Message-ID', async () => {
    const t = await getGmailThreadMeta('tok', 't1', async () => json(200, { messages: [{ id: 'a', internalDate: '1', labelIds: ['SENT'], payload: { headers: [] } }] }))
    expect(t.ok && t.messages.map((m) => m.id)).toEqual(['a'])

    const f = vi.fn(async () => json(200, { messages: [{ id: 'sent1', threadId: 't1' }] }))
    expect(await findGmailMessageByRfcId('tok', '<ao.7.abc@firma.example>', f)).toEqual({ ok: true, found: { id: 'sent1', threadId: 't1' } })
    expect((f.mock.calls[0] as unknown as [string])[0]).toBe(`${GMAIL_API_BASE}/messages?q=${encodeURIComponent('rfc822msgid:ao.7.abc@firma.example')}&includeSpamTrash=true&maxResults=5`)
    expect(await findGmailMessageByRfcId('tok', '<ao.7.abc@firma.example>', async () => json(200, { resultSizeEstimate: 0 }))).toEqual({ ok: true, found: null })
  })
})

describe('obnova tokenu Google', () => {
  test('form s refresh tokenem; bez nového refresh tokenu platí starý', async () => {
    const f = vi.fn(async () => json(200, { access_token: 'acc', expires_in: 3599, token_type: 'Bearer' }))
    const r = await refreshGoogleAccessToken({ clientId: 'cid', clientSecret: 'sec' }, 'ref', f)
    expect(r).toEqual({ access_token: 'acc', refresh_token: 'ref', expires_in: 3599 })
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe(GOOGLE_TOKEN_URL)
    expect(Object.fromEntries(new URLSearchParams(init.body as string))).toEqual({ client_id: 'cid', client_secret: 'sec', refresh_token: 'ref', grant_type: 'refresh_token' })
    expect(await refreshGoogleAccessToken({ clientId: 'c', clientSecret: 's' }, 'r', async () => json(400, { error: 'invalid_grant' }))).toBeNull()
  })
})
