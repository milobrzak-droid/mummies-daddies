import { describe, it, expect, vi, beforeEach } from 'vitest'
import { COMPANY } from '@/config'
import { MemoryDb } from './helpers/memoryDb'

// Stabilita konektoru Cockpitu v Claude / Cowork: registrace klienta se
// nezdvojuje, metadata hlásí refresh_token a jeden název, 401 z MCP nese
// WWW-Authenticate (klient ví, že má obnovit token), 429 ho nezneplatní
// a token s rozsahem full smí zapisovat, read ne.

let db: MemoryDb
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => db.client }))

const requireApiKey = vi.fn()
vi.mock('@/lib/apiKeyAuth', async (orig) => ({ ...(await orig<typeof import('@/lib/apiKeyAuth')>()), requireApiKey: (...a: unknown[]) => requireApiKey(...a) }))
vi.mock('@/domain/crm/queries/apiV1', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/domain/crm/queries/apiV1')>()),
  listAccountsPageForApi: vi.fn(async () => ({ items: [{ id: 1, name: 'Acme' }], next_offset: null })),
  listDealsPageForApi: vi.fn(async () => ({ items: [], next_offset: null })),
  listPartnersForApi: vi.fn(async () => []),
  getSummaryForApi: vi.fn(async () => ({ deal_count: 0 })),
}))
const createActivity = vi.fn(async () => ({ ok: true, data: { id: 7 } }))
vi.mock('@/domain/crm/apiWrite', () => ({
  createActivity: (...a: unknown[]) => createActivity(...(a as [])),
  setNextStep: vi.fn(),
  createTask: vi.fn(async () => ({ ok: true, data: { id: 3 } })),
}))

import { POST as register } from '@/app/api/oauth/register/route'
import { GET as asMeta } from '@/app/.well-known/oauth-authorization-server/route'
import { GET as prMeta } from '@/app/.well-known/oauth-protected-resource/api/mcp/route'
import { POST as mcpPost } from '@/app/api/mcp/route'
import { serveMcp } from '@/lib/mcpServer'

beforeEach(() => {
  db = new MemoryDb()
  requireApiKey.mockReset()
  createActivity.mockClear()
})

function regReq(body: unknown, ip = '10.0.0.1'): Request {
  return new Request('http://localhost/api/oauth/register', {
    method: 'POST', headers: { 'x-forwarded-for': ip }, body: JSON.stringify(body),
  })
}

describe('/api/oauth/register — deduplikace', () => {
  const body = { client_name: 'Claude', redirect_uris: ['https://claude.ai/api/mcp/auth_callback'] }

  it('opakovaná registrace se stejným jménem a redirect_uris vrátí stejné client_id, nevznikne nový řádek', async () => {
    const a = await (await register(regReq(body, '10.0.0.11'))).json()
    const res = await register(regReq({ ...body, redirect_uris: [...body.redirect_uris] }, '10.0.0.11'))
    expect(res.status).toBe(201)
    const b = await res.json()
    expect(b.client_id).toBe(a.client_id)
    expect(db.rows('oauth_client')).toHaveLength(1)
  })

  it('jiný client_name nebo jiná redirect_uri = nový klient', async () => {
    const a = await (await register(regReq(body, '10.0.0.12'))).json()
    const b = await (await register(regReq({ ...body, client_name: 'Jiný' }, '10.0.0.12'))).json()
    const c = await (await register(regReq({ ...body, redirect_uris: ['https://claude.ai/other'] }, '10.0.0.12'))).json()
    expect(new Set([a.client_id, b.client_id, c.client_id]).size).toBe(3)
  })

  it('pořadí redirect_uris nehraje roli, podmnožina ano', async () => {
    const uris = ['https://claude.ai/a', 'https://claude.ai/b']
    const a = await (await register(regReq({ client_name: 'X', redirect_uris: uris }, '10.0.0.13'))).json()
    const b = await (await register(regReq({ client_name: 'X', redirect_uris: [...uris].reverse() }, '10.0.0.13'))).json()
    const c = await (await register(regReq({ client_name: 'X', redirect_uris: [uris[0]] }, '10.0.0.13'))).json()
    expect(b.client_id).toBe(a.client_id)
    expect(c.client_id).not.toBe(a.client_id)
  })

  it('odpověď nabízí authorization_code i refresh_token', async () => {
    const json = await (await register(regReq(body, '10.0.0.14'))).json()
    expect(json.grant_types).toEqual(['authorization_code', 'refresh_token'])
    expect(json.token_endpoint_auth_method).toBe('none')
  })
})

describe('metadata', () => {
  it('autorizační server hlásí refresh_token, PKCE S256 a veřejného klienta', async () => {
    const m = await (await asMeta(new Request('https://cockpit.example/.well-known/oauth-authorization-server'))).json()
    expect(m.grant_types_supported).toEqual(['authorization_code', 'refresh_token'])
    expect(m.code_challenge_methods_supported).toEqual(['S256'])
    expect(m.token_endpoint).toBe('https://cockpit.example/api/oauth/token')
  })

  it('chráněný zdroj: jedna adresa /api/mcp a název Cockpit', async () => {
    const m = await (await prMeta(new Request('https://cockpit.example/x'))).json()
    expect(m.resource).toBe('https://cockpit.example/api/mcp')
    expect(m.resource_name).toBe(COMPANY.productName)
    expect(m.authorization_servers).toEqual(['https://cockpit.example'])
  })

  it('MCP server se představuje jako Cockpit', async () => {
    const res = await serveMcp(new Request('http://localhost/api/mcp', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }),
    }), null)
    const json = await res.json()
    expect(json.result.serverInfo).toMatchObject({ name: 'cockpit', title: COMPANY.productName })
  })
})

describe('/api/mcp — chyby autorizace', () => {
  const req = () => new Request('https://cockpit.example/api/mcp', { method: 'POST', body: '{}' })

  it('401 nese WWW-Authenticate s odkazem na metadata (klient obnoví token)', async () => {
    requireApiKey.mockResolvedValue({ ok: false, status: 401, error: 'unauthorized' })
    const res = await mcpPost(req())
    expect(res.status).toBe(401)
    expect(res.headers.get('WWW-Authenticate')).toBe(
      'Bearer resource_metadata="https://cockpit.example/.well-known/oauth-protected-resource/api/mcp"',
    )
  })

  it('429 je jen brzda: Retry-After, bez WWW-Authenticate a nic se nezneplatní', async () => {
    db.seed('api_key', [{ id: 1, revoked_at: null, key_hash: 'h' }])
    db.seed('oauth_refresh_token', [{ id: 1, revoked_at: null }])
    requireApiKey.mockResolvedValue({ ok: false, status: 429, error: 'rate_limited' })
    const res = await mcpPost(req())
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBe('60')
    expect(res.headers.get('WWW-Authenticate')).toBeNull()
    expect(db.calls.filter((c) => c.op === 'update' || c.op === 'delete')).toHaveLength(0)
    expect(db.rows('api_key')[0].revoked_at).toBeNull()
    expect(db.rows('oauth_refresh_token')[0].revoked_at).toBeNull()
  })
})

describe('MCP nástroje s tokenem konektoru', () => {
  const H = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' }
  const call = (name: string, args: unknown = {}) =>
    new Request('http://localhost/api/mcp', { method: 'POST', headers: H, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) })
  const text = async (res: Response) => (await res.json()).result

  it('scope read: zápis odmítnut (chyba nástroje, ne odpojení)', async () => {
    const res = await serveMcp(call('create_task', { title: 'x' }), 'user-1', 'read', true)
    expect(res.status).toBe(200)
    const r = await text(res)
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toContain('jen pro čtení')
  })

  it('scope full + obchodní role: zápis aktivity projde a autorem je vlastník klíče', async () => {
    const res = await serveMcp(call('create_activity', { account_id: 1, subject: 'Schůzka' }), 'user-1', 'full', true)
    const r = await text(res)
    expect(r.isError).toBeUndefined()
    expect(createActivity).toHaveBeenCalledWith(expect.objectContaining({ subject: 'Schůzka' }), 'user-1', true)
  })

  it('scope full, ale vlastník bez obchodní role: aktivita se odmítne', async () => {
    const r = await text(await serveMcp(call('create_activity', { account_id: 1, subject: 'x' }), 'user-2', 'full', false))
    expect(r.isError).toBe(true)
    expect(createActivity).not.toHaveBeenCalled()
  })

  it('čtení klientů i souhrnů s obchodní rolí prochází (scope read i full)', async () => {
    for (const scope of ['read', 'full'] as const) {
      expect((await text(await serveMcp(call('get_accounts'), 'user-1', scope, true))).isError).toBeUndefined()
      expect((await text(await serveMcp(call('get_summary'), 'user-1', scope, true))).isError).toBeUndefined()
      expect((await text(await serveMcp(call('get_deals'), 'user-1', scope, true))).isError).toBeUndefined()
    }
  })

  it('souhrny a obchody bez obchodní role se odmítnou (sales-only), klienti prochází', async () => {
    expect((await text(await serveMcp(call('get_summary'), 'user-2', 'full', false))).isError).toBe(true)
    expect((await text(await serveMcp(call('get_deals'), 'user-2', 'full', false))).isError).toBe(true)
    expect((await text(await serveMcp(call('get_accounts'), 'user-2', 'read', false))).isError).toBeUndefined()
  })
})
