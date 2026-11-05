import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Obchody a částky jen pro obchodní role (0058) i přes API v1 a MCP.
// Ty čtou přes admin klienta mimo RLS, takže role vlastníka klíče
// (api_key.created_by → team_member.role) se hlídá v kódu. Supabase je
// celý falešný — žádná síť, žádná živá DB.

type Result = { data: unknown; error: unknown; count?: number }
let keyRow: { id: number; revoked_at: string | null; created_by: string | null; scope: string; expires_at?: string | null } | null
let deactivated = new Set<string>()
let roles: Record<string, string> = {}
let teamMemberError = false
const tablesQueried: string[] = []

function chain(table: string) {
  tablesQueried.push(table)
  let eqValue: unknown = null
  const q: Record<string, unknown> = {}
  const result = (): Result => {
    if (table === 'api_key') return { data: keyRow, error: null }
    if (table === 'api_request') return { data: null, error: null, count: 0 }
    if (table === 'team_member') {
      if (teamMemberError) return { data: null, error: { message: 'boom' } }
      const role = roles[String(eqValue)]
      const id = String(eqValue)
      return { data: role ? { role, deactivated_at: deactivated.has(id) ? '2026-09-01T00:00:00Z' : null } : null, error: null }
    }
    return { data: null, error: null }
  }
  Object.assign(q, {
    select: () => q,
    eq: (_c: string, v: unknown) => { eqValue = v; return q },
    gte: () => q,
    update: () => q,
    insert: async () => ({ error: null }),
    maybeSingle: async () => result(),
    then: (res: (v: Result) => void) => res(result()),
  })
  return q
}

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ from: (t: string) => chain(t) }) }))

const listDealsPageForApi = vi.fn(async () => ({ items: [{ id: 1, amount_one_time: 100 }], next_offset: null }))
const getSummaryForApi = vi.fn(async () => ({ pipeline_czk: 100 }))
const listAccountsPageForApi = vi.fn(async () => ({ items: [{ id: 1, name: 'Acme' }], next_offset: null }))
const listPartnersPageForApi = vi.fn(async () => ({ items: [], next_offset: null }))
vi.mock('@/domain/crm/queries/apiV1', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/domain/crm/queries/apiV1')>()),
  parsePagination: () => ({ ok: true, value: {} }),
  parseAccountListParams: () => ({ ok: true, value: {} }),
  parseDealListParams: () => ({ ok: true, value: {} }),
  listDealsPageForApi: () => listDealsPageForApi(),
  getSummaryForApi: () => getSummaryForApi(),
  listAccountsPageForApi: () => listAccountsPageForApi(),
  listPartnersPageForApi: () => listPartnersPageForApi(),
  listPartnersForApi: vi.fn(async () => []),
}))
const getDueFollowUps = vi.fn(async () => [])
const markNudged = vi.fn(async () => 1)
vi.mock('@/domain/crm/queries/followUps', () => ({
  getDueFollowUps: () => getDueFollowUps(),
  markNudged: () => markNudged(),
}))
const setNextStep = vi.fn(async () => ({ ok: true, data: { id: 1 } }))
const createActivity = vi.fn(async () => ({ ok: true, data: { id: 7, evidence_id: null } }))
vi.mock('@/domain/crm/apiWrite', () => ({
  setNextStep: () => setNextStep(),
  createActivity: () => createActivity(),
  createTask: vi.fn(async () => ({ ok: true, data: { id: 8 } })),
}))

import { isSalesRole, ownerCanSeeSales, requireApiKey, validateApiKey } from '@/lib/apiKeyAuth'
import { SALES_REFUSAL, serveMcp } from '@/lib/mcpServer'
import { GET as getDeals } from '@/app/api/v1/deals/route'
import { POST as postNextStep } from '@/app/api/v1/deals/next-step/route'
import { GET as getSummary } from '@/app/api/v1/summary/route'
import { GET as getFollowUps } from '@/app/api/v1/follow-ups/route'
import { POST as postMark } from '@/app/api/v1/follow-ups/mark/route'
import { GET as getAccounts } from '@/app/api/v1/accounts/route'
import { GET as getPartners } from '@/app/api/v1/partners/route'
import { POST as postActivity } from '@/app/api/v1/activities/route'

const SALES = 'u-sales'
const BOSS = 'u-boss'
const DELIVERY = 'u-delivery'

function req(path: string, body?: unknown): Request {
  return new Request(`http://localhost${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { Authorization: 'Bearer cockpit_x', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
}
const asOwner = (createdBy: string | null) => {
  keyRow = { id: 1, revoked_at: null, created_by: createdBy, scope: 'full' }
}

const MCP_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
  'mcp-protocol-version': '2025-06-18',
}
function mcpCall(name: string, args: unknown = {}): Request {
  return new Request('http://localhost/api/mcp', {
    method: 'POST',
    headers: MCP_HEADERS,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  })
}
async function callTool(name: string, createdBy: string | null, args: unknown = {}, canSeeSales?: boolean) {
  const json = await (await serveMcp(mcpCall(name, args), createdBy, 'full', canSeeSales)).json()
  return json.result as { isError?: boolean; content: { text: string }[] }
}

beforeEach(() => {
  roles = { [SALES]: 'obchodnik', [BOSS]: 'vedeni', [DELIVERY]: 'projektak' }
  teamMemberError = false
  deactivated = new Set()
  tablesQueried.length = 0
  asOwner(SALES)
  vi.clearAllMocks()
})

describe('role vlastníka klíče', () => {
  it('isSalesRole = přesně vedeni a obchodnik (jako can_see_sales v 0020)', () => {
    expect(isSalesRole('vedeni')).toBe(true)
    expect(isSalesRole('obchodnik')).toBe(true)
    for (const r of ['projektak', 'lektor', 'partner', '', null, undefined, 42]) expect(isSalesRole(r)).toBe(false)
  })

  it('validateApiKey vrací canSeeSales podle role', async () => {
    asOwner(SALES)
    expect(await validateApiKey('cockpit_x')).toMatchObject({ ok: true, canSeeSales: true })
    asOwner(BOSS)
    expect(await validateApiKey('cockpit_x')).toMatchObject({ ok: true, canSeeSales: true })
    asOwner(DELIVERY)
    expect(await validateApiKey('cockpit_x')).toMatchObject({ ok: true, canSeeSales: false })
  })

  it('klíč bez vlastníka (smazaný člověk) = 401, team_member se ani nedotazuje', async () => {
    asOwner(null)
    expect(await validateApiKey('cockpit_x')).toEqual({ ok: false, status: 401, error: 'unauthorized' })
    expect(tablesQueried).not.toContain('team_member')
  })

  it('vlastník, který už v týmu není, nebo chyba dotazu = fail closed (401)', async () => {
    asOwner('u-gone')
    expect(await validateApiKey('cockpit_x')).toEqual({ ok: false, status: 401, error: 'unauthorized' })
    teamMemberError = true
    expect(await ownerCanSeeSales(SALES)).toBe(false)
    asOwner(SALES)
    expect(await validateApiKey('cockpit_x')).toMatchObject({ ok: false, status: 401 })
  })

  it('deaktivovaný vlastník = klíč neplatí, i když nebyl zneplatněn', async () => {
    asOwner(BOSS)
    deactivated.add(BOSS)
    expect(await validateApiKey('cockpit_x')).toEqual({ ok: false, status: 401, error: 'unauthorized' })
    expect(await ownerCanSeeSales(BOSS)).toBe(false)
  })

  it('prošlý klíč (expires_at, OAuth) = 401; budoucí expirace projde', async () => {
    keyRow = { id: 1, revoked_at: null, created_by: SALES, scope: 'read', expires_at: '2020-01-01T00:00:00Z' }
    expect(await validateApiKey('cockpit_x')).toEqual({ ok: false, status: 401, error: 'unauthorized' })
    keyRow = { id: 1, revoked_at: null, created_by: SALES, scope: 'read', expires_at: '2999-01-01T00:00:00Z' }
    expect(await validateApiKey('cockpit_x')).toMatchObject({ ok: true })
  })

  it('requireApiKey { sales: true } s ne-obchodní rolí = 403 sales_role_required', async () => {
    asOwner(DELIVERY)
    expect(await requireApiKey(req('/api/v1/deals'), { sales: true }))
      .toEqual({ ok: false, status: 403, error: 'sales_role_required' })
  })
})

describe('REST /api/v1 — obchodní routy', () => {
  const gated: [string, () => Promise<Response>, () => unknown][] = [
    ['GET /deals', () => getDeals(req('/api/v1/deals')), () => listDealsPageForApi],
    ['GET /summary', () => getSummary(req('/api/v1/summary')), () => getSummaryForApi],
    ['GET /follow-ups', () => getFollowUps(req('/api/v1/follow-ups')), () => getDueFollowUps],
    ['POST /deals/next-step', () => postNextStep(req('/api/v1/deals/next-step', { deal_id: 1, next_step: 'x' })), () => setNextStep],
    ['POST /follow-ups/mark', () => postMark(req('/api/v1/follow-ups/mark', { marks: [{ deal_id: 1, level: 'owner' }] })), () => markNudged],
  ]

  for (const [name, call, fn] of gated) {
    it(`${name}: obchodník projde`, async () => {
      asOwner(SALES)
      const res = await call()
      expect(res.status).toBe(200)
      expect(fn()).toHaveBeenCalledOnce()
    })

    it(`${name}: ne-obchodní role = 403 a data se nenačtou`, async () => {
      asOwner(DELIVERY)
      const res = await call()
      expect(res.status).toBe(403)
      expect(await res.json()).toEqual({ error: 'sales_role_required' })
      expect(fn()).not.toHaveBeenCalled()
    })

    it(`${name}: klíč bez vlastníka = 401`, async () => {
      asOwner(null)
      const res = await call()
      expect(res.status).toBe(401)
      expect(fn()).not.toHaveBeenCalled()
    })
  }
})

describe('REST /api/v1 — bez částek zůstává ne-obchodním rolím', () => {
  it('GET /accounts a /partners projdou', async () => {
    asOwner(DELIVERY)
    expect((await getAccounts(req('/api/v1/accounts'))).status).toBe(200)
    expect((await getPartners(req('/api/v1/partners'))).status).toBe(200)
  })

  it('POST /activities: ne-obchodní role = 403 (sales_activity je v DB jen pro obchodní role)', async () => {
    asOwner(DELIVERY)
    const res = await postActivity(req('/api/v1/activities', { account_id: 1, subject: 'x' }))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'sales_role_required' })
    expect(createActivity).not.toHaveBeenCalled()
  })

  it('POST /activities: obchodník projde', async () => {
    asOwner(SALES)
    const res = await postActivity(req('/api/v1/activities', { account_id: 1, subject: 'x' }))
    expect(res.status).toBe(201)
    expect(createActivity).toHaveBeenCalledOnce()
  })
})

describe('MCP nástroje', () => {
  for (const [tool, args, fn] of [
    ['get_deals', {}, () => listDealsPageForApi],
    ['get_summary', {}, () => getSummaryForApi],
    ['set_next_step', { deal_id: 1, next_step: 'x' }, () => setNextStep],
  ] as const) {
    it(`${tool}: obchodník (role dohledaná z vlastníka) projde`, async () => {
      const r = await callTool(tool, SALES, args)
      expect(r.isError).toBeFalsy()
      expect(fn()).toHaveBeenCalledOnce()
    })

    it(`${tool}: ne-obchodní role = srozumitelná chyba nástroje`, async () => {
      const r = await callTool(tool, DELIVERY, args)
      expect(r.isError).toBe(true)
      expect(r.content[0].text).toBe(SALES_REFUSAL)
      expect(fn()).not.toHaveBeenCalled()
    })

    it(`${tool}: klíč bez vlastníka = odmítnuto`, async () => {
      const r = await callTool(tool, null, args)
      expect(r.isError).toBe(true)
      expect(fn()).not.toHaveBeenCalled()
    })

    it(`${tool}: canSeeSales předané volajícím má přednost (bez dotazu na roli)`, async () => {
      const denied = await callTool(tool, SALES, args, false)
      expect(denied.isError).toBe(true)
      const allowed = await callTool(tool, DELIVERY, args, true)
      expect(allowed.isError).toBeFalsy()
      expect(tablesQueried).not.toContain('team_member')
    })
  }

  it('get_accounts zůstává ne-obchodní roli dostupný', async () => {
    const r = await callTool('get_accounts', DELIVERY)
    expect(r.isError).toBeFalsy()
    expect(listAccountsPageForApi).toHaveBeenCalledOnce()
  })

  it('set_next_step s read scope odmítne scope dřív než roli', async () => {
    const json = await (await serveMcp(mcpCall('set_next_step', { deal_id: 1 }), SALES, 'read')).json()
    expect(json.result.isError).toBe(true)
    expect(json.result.content[0].text).toContain('jen pro čtení')
  })
})

describe('0059 touch_deal_last_activity (statická kontrola)', () => {
  const dir = join(__dirname, '..', 'supabase', 'migrations')
  const strip = (sql: string) => sql.replace(/--[^\n]*/g, '')
  const m0059 = strip(readFileSync(join(dir, '0059_deal_activity_trigger.sql'), 'utf8'))
  const m0020 = strip(readFileSync(join(dir, '0020_core_sales_crm.sql'), 'utf8'))
  const fn = (sql: string) =>
    /CREATE OR REPLACE FUNCTION touch_deal_last_activity\(\)([\s\S]*?)\$\$([\s\S]*?)\$\$;/.exec(sql)
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim()

  it('je SECURITY DEFINER s search_path = public, pg_temp', () => {
    const header = fn(m0059)?.[1] ?? ''
    expect(header).toMatch(/SECURITY DEFINER/)
    expect(header).toMatch(/SET search_path = public, pg_temp/)
    expect(header).toMatch(/RETURNS trigger/)
  })

  it('tělo funkce je shodné s 0020 (chování beze změny)', () => {
    expect(fn(m0020)?.[2]).toBeTruthy()
    expect(norm(fn(m0059)![2])).toBe(norm(fn(m0020)![2]))
  })

  it('nesahá na trigger ani na nic dalšího; je idempotentní a zapisuje 0059', () => {
    expect(m0059).not.toMatch(/DROP\s+(TRIGGER|FUNCTION)/i)
    expect(m0059).not.toMatch(/CREATE\s+TRIGGER/i)
    expect(m0059).not.toMatch(/^\s*(BEGIN|COMMIT)\s*;/im)
    expect(m0059).toMatch(/INSERT INTO schema_migration[^;]*'0059'[^;]*ON CONFLICT \(version\) DO NOTHING/)
  })
})
