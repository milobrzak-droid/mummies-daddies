// @vitest-environment node
// Druhé kolo bezpečnostních oprav (sec-round2): aplikační vrstva.
// N2 (jmenný prostor evidence), N3 (strop těla a generické chyby MCP),
// N4 (skutečné PDF a strop souborů), N8 (escapování názvu klienta),
// N9 (mailto bez parametrů), texty z externích zdrojů (chyba Anthropicu).
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
// N9 mailto
import { plainEmailAddress, safeMailtoHref } from '@/lib/mailto'
import { reminderMailto } from '@/domain/delivery/waiting'

describe('N9: mailto jen z prosté adresy', () => {
  test.each([
    ['jan.novak@firma.cz', 'mailto:jan.novak@firma.cz'],
    ['  Jan+test@Firma.CZ ', 'mailto:Jan+test@Firma.CZ'],
    ['o\'brien@firma.cz', "mailto:o'brien@firma.cz"],
    ['jiří@čeština.cz', 'mailto:jiří@čeština.cz'],
  ])('%s je odkaz', (raw, href) => {
    expect(safeMailtoHref(raw)).toBe(href)
  })

  test.each([
    'a@b.cz?bcc=cizi@example.com',
    'a@b.cz?body=Ahoj',
    'a@b.cz&cc=x@y.cz',
    'a@b.cz#x',
    'a%40b.cz@c.cz',
    'a@b.cz,c@d.cz',
    'a@b.cz;c@d.cz',
    'a b@c.cz',
    'a@@b.cz',
    '@b.cz',
    'a@b',
    'a@b.c',
    'javascript:alert(1)@x.cz',
    'a/b@c.cz',
    '<a@b.cz>',
    '',
    null,
    undefined,
  ])('%j se odkazem nestane', (raw) => {
    expect(safeMailtoHref(raw as string | null | undefined)).toBeNull()
  })

  test('příliš dlouhá adresa se odmítne', () => {
    expect(plainEmailAddress(`${'a'.repeat(65)}@b.cz`)).toBeNull()
    expect(plainEmailAddress(`a@${'b'.repeat(64)}.cz`)).toBeNull()
  })

  test('reminderMailto nepřenese parametry z adresy kontaktu', () => {
    const draft = { subject: 'Podklady', body: 'Dobrý den' }
    const url = reminderMailto(draft, 'a@b.cz?bcc=cizi@example.com')
    expect(url.startsWith('mailto:?subject=')).toBe(true)
    expect(url).not.toContain('bcc')
    expect(reminderMailto(draft, 'a@b.cz')).toBe('mailto:a@b.cz?subject=Podklady&body=Dobr%C3%BD%20den')
  })
})

// ---------------------------------------------------------------------------
// Účastníci schůzky
import { parseEmails } from '@/domain/crm/meetingAttendees'

describe('plánování schůzky: e-maily účastníků', () => {
  test('jen tvarově platné adresy, bez duplicit, malými písmeny', () => {
    expect(parseEmails('Jan@Firma.cz, jan@firma.cz; petr@firma.cz  nesmysl@ x@y')).toEqual(['jan@firma.cz', 'petr@firma.cz'])
    expect(parseEmails('a@b.cz?bcc=x@y.cz')).toEqual([])
    expect(parseEmails(null)).toEqual([])
  })

  test('nejvýš 30 účastníků', () => {
    const many = Array.from({ length: 100 }, (_, i) => `u${i}@firma.cz`).join(',')
    expect(parseEmails(many)).toHaveLength(30)
  })
})

// ---------------------------------------------------------------------------
// N2 evidence
import { apiEvidenceSourceId } from '@/domain/crm/apiWrite'
import { EVIDENCE_SOURCE_ID_MAX, evidenceRefIssues } from '@/core/informationState'

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))

describe('N2: id zdroje evidence přes API má jmenný prostor', () => {
  test('volné source_id nemůže kolidovat s interním prefixem ani s cizím klíčem', () => {
    expect(apiEvidenceSourceId('u-1', 'cockpit-intake:5')).toBe('api:u-1:cockpit-intake:5')
    expect(apiEvidenceSourceId('u-1', 'wf-1')).not.toBe(apiEvidenceSourceId('u-2', 'wf-1'))
    expect(apiEvidenceSourceId(null, 'wf-1')).toBe('api:anon:wf-1')
    expect(apiEvidenceSourceId('u-1', 'cockpit-intake:5').startsWith('cockpit-intake:')).toBe(false)
  })

  test('dlouhé id se nahradí otiskem a vejde se do limitu evidence', () => {
    const id = 'x'.repeat(EVIDENCE_SOURCE_ID_MAX)
    const out = apiEvidenceSourceId('11111111-1111-1111-1111-111111111111', id)
    expect(out.length).toBeLessThanOrEqual(EVIDENCE_SOURCE_ID_MAX)
    expect(out).toContain(createHash('sha256').update(id).digest('hex'))
    expect(evidenceRefIssues({ kind: 'meeting', sourceId: out })).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// N3 MCP: strop těla, generické chyby
vi.mock('@/lib/apiKeyAuth', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/apiKeyAuth')>()),
  requireApiKey: vi.fn(),
}))
vi.mock('@/domain/crm/queries/apiV1', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/domain/crm/queries/apiV1')>()),
  listAccountsPageForApi: vi.fn(),
  listDealsPageForApi: vi.fn(async () => ({ items: [], next_offset: null })),
  listPartnersForApi: vi.fn(async () => []),
  getSummaryForApi: vi.fn(async () => ({})),
}))
vi.mock('@/domain/crm/apiWrite', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/domain/crm/apiWrite')>()),
  createActivity: vi.fn(), setNextStep: vi.fn(), createTask: vi.fn(),
}))

import { requireApiKey } from '@/lib/apiKeyAuth'
import { listAccountsPageForApi } from '@/domain/crm/queries/apiV1'
import { POST as mcpPost } from '@/app/api/mcp/route'

const MCP_HEADERS = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' }
const okAuth = { ok: true as const, keyId: 1, createdBy: 'u-1', scope: 'read' as const, canSeeSales: true }

function chunked(bytes: number, chunk = 64 * 1024): ReadableStream<Uint8Array> {
  let sent = 0
  return new ReadableStream({
    pull(controller) {
      if (sent >= bytes) return controller.close()
      const n = Math.min(chunk, bytes - sent)
      sent += n
      controller.enqueue(new Uint8Array(n).fill(97))
    },
  })
}

describe('N3: MCP tělo má strop a chyby neprozrazují text DB', () => {
  beforeEach(() => {
    vi.mocked(requireApiKey).mockReset()
    vi.mocked(requireApiKey).mockImplementation(async (_req, opts) => {
      await opts?.logPath?.()
      return okAuth as never
    })
  })
  afterEach(() => vi.restoreAllMocks())

  test('ohlášená délka nad stropem = 413 bez čtení', async () => {
    const res = await mcpPost(new Request('http://localhost/api/mcp', {
      method: 'POST', headers: { ...MCP_HEADERS, 'content-length': String(300 * 1024) }, body: '{}',
    }))
    expect(res.status).toBe(413)
  })

  test('chunked tělo bez Content-Length se přeruší na stropu', async () => {
    const req = new Request('http://localhost/api/mcp', {
      method: 'POST', headers: MCP_HEADERS, body: chunked(2 * 1024 * 1024), duplex: 'half',
    } as RequestInit)
    const res = await mcpPost(req)
    expect(res.status).toBe(413)
    expect(await res.json()).toEqual({ error: 'payload_too_large' })
  })

  test('tělo se před ověřením klíče nečte', async () => {
    vi.mocked(requireApiKey).mockResolvedValue({ ok: false, status: 401, error: 'unauthorized' })
    const stream = chunked(1024)
    const spy = vi.spyOn(stream, 'getReader')
    const res = await mcpPost(new Request('http://localhost/api/mcp', {
      method: 'POST', headers: MCP_HEADERS, body: stream, duplex: 'half',
    } as RequestInit))
    expect(res.status).toBe(401)
    expect(spy).not.toHaveBeenCalled()
  })

  test('běžný požadavek projde a do logu jde název nástroje', async () => {
    vi.mocked(listAccountsPageForApi).mockResolvedValue({ items: [{ id: 1, name: 'Acme' }], next_offset: null } as never)
    const paths: string[] = []
    vi.mocked(requireApiKey).mockImplementation(async (_req, opts) => {
      paths.push((await opts?.logPath?.()) ?? '')
      return okAuth as never
    })
    const res = await mcpPost(new Request('http://localhost/api/mcp', {
      method: 'POST', headers: MCP_HEADERS,
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_accounts', arguments: {} } }),
    }))
    expect(res.status).toBe(200)
    expect(paths).toEqual(['/api/mcp#get_accounts'])
    const json = await res.json()
    expect(json.result.content[0].text).toContain('Acme')
  })

  test('výjimka z DB se do odpovědi nedostane (jen do logu)', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.mocked(listAccountsPageForApi).mockRejectedValue(new Error('relation "account" column "notes" failing row (Jan Novák, 777 123 456)'))
    const res = await mcpPost(new Request('http://localhost/api/mcp', {
      method: 'POST', headers: MCP_HEADERS,
      body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'get_accounts', arguments: {} } }),
    }))
    const text = JSON.stringify(await res.json())
    expect(text).toContain('neočekávaná chyba serveru')
    expect(text).not.toContain('relation')
    expect(text).not.toContain('777')
    expect(err).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// REST /api/v1: strop těla (stejná zábrana jako u MCP)
import { POST as activitiesPost } from '@/app/api/v1/activities/route'
import { createActivity } from '@/domain/crm/apiWrite'
import { readJsonBody } from '@/lib/httpBody'

describe('REST /api/v1: tělo se čte po částech se stropem', () => {
  beforeEach(() => {
    vi.mocked(requireApiKey).mockReset()
    vi.mocked(requireApiKey).mockResolvedValue({ ...okAuth, scope: 'full' } as never)
    vi.mocked(createActivity).mockReset()
    vi.mocked(createActivity).mockResolvedValue({ ok: true, data: { id: 5, evidence_id: null } } as never)
  })

  test('chunked tělo přes strop = 413 a zápis se nezavolá', async () => {
    const res = await activitiesPost(new Request('http://localhost/api/v1/activities', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: chunked(2 * 1024 * 1024), duplex: 'half',
    } as RequestInit))
    expect(res.status).toBe(413)
    expect(createActivity).not.toHaveBeenCalled()
  })

  test('rozbité JSON = 400, běžný požadavek projde', async () => {
    const bad = await activitiesPost(new Request('http://localhost/api/v1/activities', { method: 'POST', body: '{nejson' }))
    expect(bad.status).toBe(400)
    expect(await bad.json()).toEqual({ error: 'invalid_json' })
    const ok = await activitiesPost(new Request('http://localhost/api/v1/activities', {
      method: 'POST', body: JSON.stringify({ account_id: 1, subject: 'x' }),
    }))
    expect(ok.status).toBe(201)
    expect(createActivity).toHaveBeenCalledWith({ account_id: 1, subject: 'x' }, 'u-1', true)
  })

  test('readJsonBody: neplatné UTF-8 = 400', async () => {
    const r = await readJsonBody(new Request('http://localhost/x', { method: 'POST', body: new Uint8Array([0xff, 0xfe, 0x7b]) }))
    expect(r).toMatchObject({ ok: false, status: 400 })
  })
})

// ---------------------------------------------------------------------------
// Veřejné endpointy čtou tělo se stropem i bez Content-Length
import { POST as registerPost } from '@/app/api/oauth/register/route'
import { POST as tokenPost } from '@/app/api/oauth/token/route'
import { POST as cspPost } from '@/app/api/csp-report/route'

describe('veřejné endpointy: tělo se čte po částech a přeruší na stropu', () => {
  const streamReq = (url: string, bytes: number, headers: Record<string, string> = {}) =>
    new Request(url, { method: 'POST', headers, body: chunked(bytes), duplex: 'half' } as RequestInit)

  test('/api/oauth/register: chunked 200 kB = 413', async () => {
    const res = await registerPost(streamReq('http://localhost/api/oauth/register', 200 * 1024, { 'x-forwarded-for': '10.7.0.1' }))
    expect(res.status).toBe(413)
  })

  test('/api/oauth/token: tělo nad 16 kB = 400 invalid_request', async () => {
    const res = await tokenPost(streamReq('http://localhost/api/oauth/token', 200 * 1024, { 'content-type': 'application/x-www-form-urlencoded' }))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'invalid_request' })
  })

  test('/api/csp-report: chunked tělo nad stropem = 413', async () => {
    const res = await cspPost(streamReq('http://localhost/api/csp-report', 2 * 1024 * 1024, { 'content-type': 'application/csp-report' }) as never)
    expect(res.status).toBe(413)
  })
})

// ---------------------------------------------------------------------------
// N4 import PDF + text chyby Anthropicu
import { extractOfferFromPdf } from '@/connectors/anthropic'

describe('chyba Anthropicu při čtení nabídky nenese tělo odpovědi', () => {
  beforeEach(() => vi.stubEnv('ANTHROPIC_API_KEY', 'test-key-not-real'))
  afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals() })

  test('jen status a typ chyby', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'PDF říká: Jan Novák 777 123 456' } }), { status: 400 })))
    await expect(extractOfferFromPdf('abc')).rejects.toThrow(/^Anthropic API error 400 \(invalid_request_error\)$/)
  })

  test('nečitelné tělo = jen status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Zpráva klienta: TAJNÉ', { status: 500 })))
    await expect(extractOfferFromPdf('abc')).rejects.toThrow(/^Anthropic API error 500$/)
  })

  test('neznámý tvar typu chyby se nepřenese', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: { type: 'Jan Novák 777' } }), { status: 400 })))
    await expect(extractOfferFromPdf('abc')).rejects.toThrow(/^Anthropic API error 400$/)
  })
})
