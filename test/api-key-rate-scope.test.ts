import { beforeEach, describe, expect, test, vi } from 'vitest'

// lib/apiKeyAuth.ts: scope z hlavičky pro MCP (fail closed), rate limit
// a pořadí kontrol v requireApiKey. Supabase admin je mockovaný.

type KeyRow = { id: number; revoked_at: string | null; created_by: string | null; scope?: unknown }
let keyRow: KeyRow | null = null
let missingScopeColumn = false
let keyLookupError: { code: string } | null = null
let requestCount: number | null = 0
let memberRole: string | null = null
let adminThrows = false
const inserts: { table: string; row: unknown }[] = []
const countFilters: unknown[][] = []

function chain(table: string) {
  let selected = ''
  const q: Record<string, unknown> = {}
  Object.assign(q, {
    select: (cols: string) => { selected = cols; return q },
    eq: (...args: unknown[]) => { if (table === 'api_request') countFilters.push(args); return q },
    gte: (...args: unknown[]) => { countFilters.push(args); return q },
    update: () => q,
    insert: async (row: unknown) => { inserts.push({ table, row }); return { error: null } },
    maybeSingle: async () => {
      if (table === 'team_member') return { data: memberRole === null ? null : { role: memberRole }, error: null }
      if (keyLookupError) return { data: null, error: keyLookupError }
      if (missingScopeColumn && selected.includes('scope')) return { data: null, error: { code: 'PGRST204' } }
      if (!keyRow) return { data: null, error: null }
      const { scope, ...rest } = keyRow
      return { data: selected.includes('scope') ? { ...rest, scope } : rest, error: null }
    },
    then: (res: (v: unknown) => void) => res({ data: null, error: null, count: requestCount }),
  })
  return q
}

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => {
    if (adminThrows) throw new Error('env chybí')
    return { from: (t: string) => chain(t) }
  },
}))

import { canWrite, recordAndCheckRate, requireApiKey, scopeFromRequest } from '@/lib/apiKeyAuth'

const req = (auth?: string, path = '/api/v1/accounts') =>
  new Request(`http://localhost${path}`, { headers: auth ? { Authorization: auth } : {} })

beforeEach(() => {
  keyRow = { id: 7, revoked_at: null, created_by: 'u1', scope: 'full' }
  missingScopeColumn = false
  keyLookupError = null
  requestCount = 0
  memberRole = 'obchodnik'
  adminThrows = false
  inserts.length = 0
  countFilters.length = 0
})

test('canWrite: jen full', () => {
  expect(canWrite('full')).toBe(true)
  expect(canWrite('read')).toBe(false)
})

describe('scopeFromRequest (fail closed)', () => {
  test('bez hlavičky nebo s jiným schématem → read', async () => {
    expect(await scopeFromRequest(req())).toBe('read')
    expect(await scopeFromRequest(req('Basic abc'))).toBe('read')
    expect(await scopeFromRequest(req('Bearer '))).toBe('read')
  })

  test('platný full klíč → full, read klíč → read', async () => {
    expect(await scopeFromRequest(req('Bearer cockpit_x'))).toBe('full')
    keyRow = { ...keyRow!, scope: 'read' }
    expect(await scopeFromRequest(req('Bearer cockpit_x'))).toBe('read')
  })

  test('neznámá hodnota scope se bere jako read', async () => {
    keyRow = { ...keyRow!, scope: 'admin' }
    expect(await scopeFromRequest(req('Bearer cockpit_x'))).toBe('read')
  })

  test('odvolaný nebo neexistující klíč → read', async () => {
    keyRow = { ...keyRow!, revoked_at: '2026-09-01T00:00:00Z' }
    expect(await scopeFromRequest(req('Bearer cockpit_x'))).toBe('read')
    keyRow = null
    expect(await scopeFromRequest(req('Bearer cockpit_x'))).toBe('read')
  })

  test('před migrací 0043 (chybí sloupec scope) → full jako dřív', async () => {
    missingScopeColumn = true
    expect(await scopeFromRequest(req('Bearer cockpit_x'))).toBe('full')
  })

  test('jiná chyba dotazu → read (ne fallback na full)', async () => {
    keyLookupError = { code: '42501' }
    expect(await scopeFromRequest(req('Bearer cockpit_x'))).toBe('read')
  })

  test('výjimka při vytvoření klienta → read', async () => {
    adminThrows = true
    expect(await scopeFromRequest(req('Bearer cockpit_x'))).toBe('read')
  })
})

describe('recordAndCheckRate', () => {
  test('pod limitem: zapíše volání a pustí dál', async () => {
    requestCount = 119
    expect(await recordAndCheckRate(7, '/api/v1/deals')).toEqual({ ok: true })
    expect(inserts).toEqual([{ table: 'api_request', row: { key_id: 7, path: '/api/v1/deals' } }])
    expect(countFilters[0]).toEqual(['key_id', 7])
    // okno je poslední minuta
    const since = Date.parse(countFilters[1][1] as string)
    expect(Date.now() - since).toBeGreaterThanOrEqual(59_000)
    expect(Date.now() - since).toBeLessThan(65_000)
  })

  test('na limitu 120/min: 429 a volání se nezapíše', async () => {
    requestCount = 120
    expect(await recordAndCheckRate(7, '/x')).toEqual({ ok: false, status: 429, error: 'rate_limited' })
    expect(inserts).toHaveLength(0)
  })

  test('count null (head dotaz bez počtu) se bere jako 0', async () => {
    requestCount = null
    expect(await recordAndCheckRate(7, '/x')).toEqual({ ok: true })
  })
})

describe('requireApiKey', () => {
  test('bez Bearer → 401 bez dotazu na klíč', async () => {
    expect(await requireApiKey(req())).toEqual({ ok: false, status: 401, error: 'unauthorized' })
    expect(await requireApiKey(req('Token abc'))).toEqual({ ok: false, status: 401, error: 'unauthorized' })
  })

  test('odvolaný klíč → 401', async () => {
    keyRow = { ...keyRow!, revoked_at: '2026-01-01' }
    expect(await requireApiKey(req('Bearer k'))).toMatchObject({ ok: false, status: 401 })
  })

  test('zápis s read klíčem → 403 insufficient_scope a nic se nezaloguje', async () => {
    keyRow = { ...keyRow!, scope: 'read' }
    expect(await requireApiKey(req('Bearer k'), { write: true })).toEqual({ ok: false, status: 403, error: 'insufficient_scope' })
    expect(inserts).toHaveLength(0)
  })

  test('obchodní routa s vlastníkem bez obchodní role → 403 sales_role_required', async () => {
    memberRole = 'projektak'
    expect(await requireApiKey(req('Bearer k'), { sales: true })).toEqual({ ok: false, status: 403, error: 'sales_role_required' })
  })

  test('obchodní routa s klíčem bez vlastníka → 401 (isKeyUsable fail-closed dřív, než se dostane na sales kontrolu)', async () => {
    keyRow = { ...keyRow!, created_by: null }
    expect(await requireApiKey(req('Bearer k'), { sales: true })).toMatchObject({ ok: false, status: 401 })
  })

  test('překročený limit → 429 i pro jinak platný klíč', async () => {
    requestCount = 500
    expect(await requireApiKey(req('Bearer k'))).toEqual({ ok: false, status: 429, error: 'rate_limited' })
  })

  test('úspěch: vrátí vlastníka, scope a canSeeSales; zaloguje cestu bez query', async () => {
    const r = await requireApiKey(req('Bearer k', '/api/v1/deals?limit=5'), { write: true, sales: true })
    expect(r).toEqual({ ok: true, createdBy: 'u1', keyId: 7, scope: 'full', canSeeSales: true })
    expect(inserts).toEqual([{ table: 'api_request', row: { key_id: 7, path: '/api/v1/deals' } }])
  })
})
