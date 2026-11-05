// Druhé kolo bezpečnostních oprav: N1 (limit API klíčů atomicky a fail-closed),
// N7 (strop neschválených OAuth klientů, dedupe, approved_at), délkové limity zápisů
// přes API a strop těla REST rout. DB je falešná; migraci 0096 samotnou ověřuje
// test/security-0096-pglite.test.ts.
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { MemoryDb } from './helpers/memoryDb'

type RpcResult = { data: unknown; error: { code?: string; message?: string } | null }
let rpcImpl: (name: string, args: Record<string, unknown>) => RpcResult | Promise<RpcResult> | never
const rpcCalls: { name: string; args: Record<string, unknown> }[] = []
let fromImpl: (table: string) => unknown
let db: MemoryDb
let useMemory = false

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    rpc: async (name: string, args: Record<string, unknown>) => {
      rpcCalls.push({ name, args })
      return rpcImpl(name, args)
    },
    from: (t: string) => (useMemory ? db.from(t) : fromImpl(t)),
  }),
}))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))

import { recordAndCheckRate, RATE_UNAVAILABLE } from '@/lib/apiKeyAuth'
import { registerOAuthClient, markOAuthClientApproved, UNAPPROVED_CLIENT_LIMIT } from '@/lib/oauthClients'
import { POST as register } from '@/app/api/oauth/register/route'
import { activityInput, taskInput, nextStepInput, API_TEXT_LIMITS } from '@/domain/crm/apiWrite'
import { logError } from '@/lib/log'

beforeEach(() => {
  vi.clearAllMocks()
  rpcCalls.length = 0
  useMemory = false
  db = new MemoryDb()
})

describe('N1: recordAndCheckRate přes RPC api_request_hit', () => {
  test('RPC true = povoleno, false = 429; volá se s klíčem, cestou a limitem', async () => {
    rpcImpl = () => ({ data: true, error: null })
    expect(await recordAndCheckRate(7, '/api/v1/deals', 120)).toEqual({ ok: true })
    expect(rpcCalls[0]).toEqual({ name: 'api_request_hit', args: { p_key_id: 7, p_path: '/api/v1/deals', p_limit: 120 } })
    rpcImpl = () => ({ data: false, error: null })
    expect(await recordAndCheckRate(7, '/x', 120)).toEqual({ ok: false, status: 429, error: 'rate_limited' })
  })

  test('jiná chyba RPC = odmítnout (503), nikdy povolit', async () => {
    rpcImpl = () => ({ data: null, error: { code: '57014', message: 'timeout' } })
    expect(await recordAndCheckRate(7, '/x')).toEqual(RATE_UNAVAILABLE)
    expect(logError).toHaveBeenCalled()
  })

  test('nečekaná hodnota z RPC (null) se nepovažuje za povolení', async () => {
    rpcImpl = () => ({ data: null, error: null })
    expect(await recordAndCheckRate(7, '/x')).toMatchObject({ ok: false, status: 429 })
  })

  describe('bez migrace 0096 (funkce neexistuje) se použije původní cesta, ale fail-closed', () => {
    let count: number | null
    let countError: unknown
    let insertError: unknown
    const inserts: unknown[] = []
    beforeEach(() => {
      count = 0
      countError = null
      insertError = null
      inserts.length = 0
      rpcImpl = () => ({ data: null, error: { code: 'PGRST202', message: 'no function' } })
      fromImpl = () => {
        const q: Record<string, unknown> = {}
        Object.assign(q, {
          select: () => q, eq: () => q, gte: () => q,
          insert: async (row: unknown) => { inserts.push(row); return { error: insertError } },
          then: (res: (v: unknown) => void) => res({ data: null, error: countError, count }),
        })
        return q
      }
    })

    test('pod limitem zapíše a pustí', async () => {
      count = 119
      expect(await recordAndCheckRate(7, '/x', 120)).toEqual({ ok: true })
      expect(inserts).toEqual([{ key_id: 7, path: '/x' }])
    })
    test('na limitu 429 a nezapisuje', async () => {
      count = 120
      expect(await recordAndCheckRate(7, '/x', 120)).toMatchObject({ ok: false, status: 429 })
      expect(inserts).toHaveLength(0)
    })
    test('chyba čtení počtu = 503 (dřív se počet vzal jako 0 a povolilo se)', async () => {
      countError = { code: '57014', message: 'timeout' }
      count = null
      expect(await recordAndCheckRate(7, '/x')).toEqual(RATE_UNAVAILABLE)
      expect(inserts).toHaveLength(0)
    })
    test('chyba zápisu = 503', async () => {
      insertError = { code: '42P01', message: 'missing' }
      expect(await recordAndCheckRate(7, '/x')).toEqual(RATE_UNAVAILABLE)
    })
    test('klient bez rpc (výjimka) spadne na původní cestu, ne na povolení', async () => {
      rpcImpl = () => { throw new Error('rpc is not a function') }
      count = 120
      expect(await recordAndCheckRate(7, '/x', 120)).toMatchObject({ ok: false, status: 429 })
      countError = { code: 'x' }
      expect(await recordAndCheckRate(7, '/x', 120)).toEqual(RATE_UNAVAILABLE)
    })
  })
})

describe('N7: registrace OAuth klientů', () => {
  const client = { clientId: 'cockpit-client_abc', clientName: 'Claude', redirectUris: ['https://claude.ai/cb'] }

  test('RPC true = created, false = limit; strop je UNAPPROVED_CLIENT_LIMIT', async () => {
    rpcImpl = () => ({ data: true, error: null })
    expect(await registerOAuthClient((await import('@/lib/supabase/admin')).createAdminClient(), client)).toBe('created')
    expect(rpcCalls[0]).toEqual({
      name: 'oauth_client_register',
      args: { p_client_id: 'cockpit-client_abc', p_client_name: 'Claude', p_redirect_uris: ['https://claude.ai/cb'], p_max_unapproved: UNAPPROVED_CLIENT_LIMIT },
    })
    rpcImpl = () => ({ data: false, error: null })
    expect(await registerOAuthClient((await import('@/lib/supabase/admin')).createAdminClient(), client)).toBe('limit')
  })

  test('jiná chyba RPC = error; bez funkce se klient vloží přímo jako dřív', async () => {
    const admin = (await import('@/lib/supabase/admin')).createAdminClient()
    rpcImpl = () => ({ data: null, error: { code: '57014' } })
    expect(await registerOAuthClient(admin, client)).toBe('error')
    rpcImpl = () => ({ data: null, error: { code: '42883' } })
    useMemory = true
    expect(await registerOAuthClient(admin, client)).toBe('created')
    expect(db.rows('oauth_client')).toEqual([expect.objectContaining({ client_id: 'cockpit-client_abc', client_name: 'Claude' })])
  })

  test('approved_at se nastaví jen neschválenému; chybějící sloupec se toleruje', async () => {
    const admin = (await import('@/lib/supabase/admin')).createAdminClient()
    useMemory = true
    db.seed('oauth_client', [{ client_id: 'a', approved_at: null }, { client_id: 'b', approved_at: '2026-01-01T00:00:00Z' }])
    await markOAuthClientApproved(admin, 'a')
    await markOAuthClientApproved(admin, 'b')
    const rows = Object.fromEntries(db.rows('oauth_client').map((r) => [r.client_id, r.approved_at]))
    expect(typeof rows.a).toBe('string')
    expect(rows.b).toBe('2026-01-01T00:00:00Z')

    useMemory = false
    fromImpl = () => ({ update: () => ({ eq: () => ({ is: async () => ({ error: { code: '42703' } }) }) }) })
    await expect(markOAuthClientApproved(admin, 'a')).resolves.toBeUndefined()
    expect(logError).not.toHaveBeenCalled()
  })

  const regReq = (body: unknown, ip: string) =>
    new Request('http://localhost/api/oauth/register', { method: 'POST', headers: { 'x-forwarded-for': ip }, body: JSON.stringify(body) })

  test('/api/oauth/register: nad stropem 429 + Retry-After, klient se nevytvoří', async () => {
    useMemory = true
    rpcImpl = () => ({ data: false, error: null })
    const res = await register(regReq({ client_name: 'Nový', redirect_uris: ['https://claude.ai/cb'] }, '10.9.0.1'))
    expect(res.status).toBe(429)
    expect(res.headers.get('Retry-After')).toBe('3600')
    expect(await res.json()).toEqual({ error: 'temporarily_unavailable' })
    expect(db.rows('oauth_client')).toEqual([])
  })

  test('/api/oauth/register: chyba DB = 500', async () => {
    useMemory = true
    rpcImpl = () => ({ data: null, error: { code: '57014' } })
    const res = await register(regReq({ client_name: 'Nový', redirect_uris: ['https://claude.ai/cb'] }, '10.9.0.2'))
    expect(res.status).toBe(500)
  })

  test('/api/oauth/register: existující klient (stejné jméno a adresy) se vrací i při plném stropu', async () => {
    useMemory = true
    rpcImpl = () => ({ data: false, error: null })
    db.seed('oauth_client', [{ client_id: 'cockpit-client_stary', client_name: 'Claude', redirect_uris: ['https://claude.ai/cb'] }])
    const res = await register(regReq({ client_name: 'Claude', redirect_uris: ['https://claude.ai/cb'] }, '10.9.0.3'))
    expect(res.status).toBe(201)
    expect((await res.json()).client_id).toBe('cockpit-client_stary')
    expect(rpcCalls).toHaveLength(0)
  })

  test('dedupe: sto klientů téhož jména s jinými adresami skutečného klienta nezakryje', async () => {
    useMemory = true
    rpcImpl = () => ({ data: false, error: null })
    db.seed('oauth_client', Array.from({ length: 120 }, (_, i) => ({
      client_id: `cockpit-client_spam${i}`, client_name: 'Claude', redirect_uris: [`https://claude.ai/spam${i}`], created_at: `2026-09-01T00:00:${String(i % 60).padStart(2, '0')}Z`,
    })))
    db.seed('oauth_client', [{ client_id: 'cockpit-client_pravy', client_name: 'Claude', redirect_uris: ['https://claude.ai/cb'], created_at: '2026-09-30T00:00:00Z' }])
    const res = await register(regReq({ client_name: 'Claude', redirect_uris: ['https://claude.ai/cb'] }, '10.9.0.4'))
    expect(res.status).toBe(201)
    expect((await res.json()).client_id).toBe('cockpit-client_pravy')
  })
})

describe('délkové limity zápisů přes API/MCP', () => {
  const ok = { account_id: 1, subject: 'x' }
  test.each([
    ['subject', { ...ok, subject: 'x'.repeat(API_TEXT_LIMITS.subject + 1) }],
    ['body', { ...ok, body: 'x'.repeat(API_TEXT_LIMITS.body + 1) }],
    ['occurred_at', { ...ok, occurred_at: '2'.repeat(101) }],
  ])('aktivita: %s nad limit se odmítne', (_n, input) => {
    expect(activityInput.safeParse(input).success).toBe(false)
  })
  test('aktivita na hraně limitu projde', () => {
    expect(activityInput.safeParse({ ...ok, subject: 'x'.repeat(API_TEXT_LIMITS.subject), body: 'x'.repeat(API_TEXT_LIMITS.body) }).success).toBe(true)
  })
  test('úkol a další krok mají stejné pojistky', () => {
    expect(taskInput.safeParse({ title: 'x'.repeat(API_TEXT_LIMITS.title + 1) }).success).toBe(false)
    expect(taskInput.safeParse({ title: 'ok', description: 'x'.repeat(API_TEXT_LIMITS.description + 1) }).success).toBe(false)
    expect(taskInput.safeParse({ title: 'ok', description: 'x'.repeat(API_TEXT_LIMITS.description) }).success).toBe(true)
    expect(nextStepInput.safeParse({ deal_id: 1, next_step: 'x'.repeat(API_TEXT_LIMITS.nextStep + 1) }).success).toBe(false)
    expect(nextStepInput.safeParse({ deal_id: 1, next_step: 'poslat nabídku', next_step_due: '2026-10-01' }).success).toBe(true)
  })
})
