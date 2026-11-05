import { describe, it, expect, vi, beforeEach } from 'vitest'

// Scope API klíče (0043): klíč 'read' nesmí volat zápisový MCP nástroj
// ani zápisovou /api/v1 routu. Supabase je mockovaný — žádná síť.

type Result = { data: unknown; error: unknown; count?: number }
let keyRow: Record<string, unknown> | null = null
let missingScopeColumn = false

function chain(table: string) {
  let selected = ''
  const q: Record<string, unknown> = {}
  const resolveSelect = (): Result => {
    // Vlastník klíče: aktivní obchodník (klíč bez vlastníka od 0069 neplatí).
    if (table === 'team_member') return { data: { role: 'obchodnik', deactivated_at: null }, error: null }
    if (table !== 'api_key') return { data: null, error: null, count: 0 }
    if (missingScopeColumn && selected.includes('scope')) return { data: null, error: { code: '42703' } }
    if (!keyRow) return { data: null, error: null }
    const { scope, ...rest } = keyRow
    return { data: selected.includes('scope') ? { ...rest, scope } : rest, error: null }
  }
  Object.assign(q, {
    select: (cols: string) => { selected = cols; return q },
    eq: () => q,
    gte: () => q,
    update: () => q,
    insert: async () => ({ error: null }),
    maybeSingle: async () => resolveSelect(),
    then: (res: (v: Result) => void) => res({ data: null, error: null, count: 0 }),
  })
  return q
}

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ from: (t: string) => chain(t) }) }))
vi.mock('@/domain/crm/queries/apiV1', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/domain/crm/queries/apiV1')>()),
  listAccountsPageForApi: vi.fn(async () => ({ items: [], next_offset: null })),
  listDealsPageForApi: vi.fn(async () => ({ items: [], next_offset: null })),
  listPartnersForApi: vi.fn(async () => []),
  getSummaryForApi: vi.fn(async () => ({})),
}))
const createActivity = vi.fn(async () => ({ ok: true, data: { id: 7 } }))
const createTask = vi.fn(async () => ({ ok: true, data: { id: 8 } }))
vi.mock('@/domain/crm/apiWrite', () => ({
  createActivity: (...a: unknown[]) => createActivity(...(a as [])),
  setNextStep: vi.fn(),
  createTask: (...a: unknown[]) => createTask(...(a as [])),
}))

import { requireApiKey, validateApiKey, normalizeScope } from '@/lib/apiKeyAuth'
import { serveMcp } from '@/lib/mcpServer'
import { POST as postTask } from '@/app/api/v1/tasks/route'

const MCP_HEADERS = {
  'Content-Type': 'application/json',
  Accept: 'application/json, text/event-stream',
  'mcp-protocol-version': '2025-06-18',
}
function mcpCall(name: string, args: unknown, auth?: string): Request {
  return new Request('http://localhost/api/mcp', {
    method: 'POST',
    headers: auth ? { ...MCP_HEADERS, Authorization: `Bearer ${auth}` } : MCP_HEADERS,
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  })
}
const activityArgs = { account_id: 1, subject: 'x' }

beforeEach(() => {
  keyRow = { id: 1, revoked_at: null, created_by: 'u-owner', scope: 'read' }
  missingScopeColumn = false
  createActivity.mockClear()
  createTask.mockClear()
})

describe('scope klíče', () => {
  it('normalizeScope: cokoli kromě full je read', () => {
    expect(normalizeScope('full')).toBe('full')
    expect(normalizeScope('read')).toBe('read')
    expect(normalizeScope(null)).toBe('read')
    expect(normalizeScope('admin')).toBe('read')
  })

  it('validateApiKey vrací scope z DB', async () => {
    const r = await validateApiKey('cockpit_x')
    expect(r.ok && r.scope).toBe('read')
  })

  it('bez sloupce scope (nenasazená 0043) se klíč bere jako full', async () => {
    missingScopeColumn = true
    const r = await validateApiKey('cockpit_x')
    expect(r.ok && r.scope).toBe('full')
  })

  it('read klíč na zápisové routě dostane 403', async () => {
    const r = await requireApiKey(
      new Request('http://localhost/api/v1/tasks', { headers: { Authorization: 'Bearer cockpit_x' } }),
      { write: true },
    )
    expect(r).toEqual({ ok: false, status: 403, error: 'insufficient_scope' })
  })

  it('read klíč smí na čtecí routu', async () => {
    const r = await requireApiKey(
      new Request('http://localhost/api/v1/deals', { headers: { Authorization: 'Bearer cockpit_x' } }),
    )
    expect(r.ok).toBe(true)
  })

  it('POST /api/v1/tasks s read klíčem = 403 a nic se nezapíše', async () => {
    const res = await postTask(new Request('http://localhost/api/v1/tasks', {
      method: 'POST',
      headers: { Authorization: 'Bearer cockpit_x', 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 't' }),
    }))
    expect(res.status).toBe(403)
    expect(createTask).not.toHaveBeenCalled()
  })

  it('POST /api/v1/tasks s full klíčem projde', async () => {
    keyRow = { ...keyRow!, scope: 'full' }
    const res = await postTask(new Request('http://localhost/api/v1/tasks', {
      method: 'POST',
      headers: { Authorization: 'Bearer cockpit_x', 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 't' }),
    }))
    expect(res.status).toBe(201)
  })
})

describe('MCP zápisové nástroje podle scope', () => {
  it('scope read předaný volajícím: create_activity odmítnut', async () => {
    const res = await serveMcp(mcpCall('create_activity', activityArgs), null, 'read')
    const json = await res.json()
    expect(json.result.isError).toBe(true)
    expect(json.result.content[0].text).toContain('jen pro čtení')
    expect(createActivity).not.toHaveBeenCalled()
  })

  it('scope full: create_activity projde (obchodní role)', async () => {
    const res = await serveMcp(mcpCall('create_activity', activityArgs), 'u-owner', 'full')
    const json = await res.json()
    expect(json.result.isError).toBeFalsy()
    expect(createActivity).toHaveBeenCalledOnce()
  })

  it('scope full, ale ne-obchodní role: create_activity odmítnuto', async () => {
    const res = await serveMcp(mcpCall('create_activity', activityArgs), 'u-owner', 'full', false)
    const json = await res.json()
    expect(json.result.isError).toBe(true)
    expect(createActivity).not.toHaveBeenCalled()
  })

  it('bez předaného scope se zjistí z klíče v požadavku (read → odmítnuto)', async () => {
    const res = await serveMcp(mcpCall('create_activity', activityArgs, 'cockpit_x'), null)
    const json = await res.json()
    expect(json.result.isError).toBe(true)
    expect(createActivity).not.toHaveBeenCalled()
  })

  it('bez klíče v požadavku a bez scope = fail closed', async () => {
    const res = await serveMcp(mcpCall('create_activity', activityArgs), null)
    const json = await res.json()
    expect(json.result.isError).toBe(true)
    expect(createActivity).not.toHaveBeenCalled()
  })
})
