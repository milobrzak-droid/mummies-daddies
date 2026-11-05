import { describe, it, expect, vi, beforeEach } from 'vitest'

// Stránkování /api/v1/{accounts,deals,partners}. Supabase i auth mockované — žádná síť.

type Call = {
  table: string; select: string; orders: string[]; range: [number, number] | null; inIds: unknown[] | null
  filters: { method: string; args: unknown[] }[]
}
let calls: Call[] = []
let rows: Record<string, Record<string, unknown>[]> = {}

function chain(table: string) {
  const call: Call = { table, select: '', orders: [], range: null, inIds: null, filters: [] }
  calls.push(call)
  const result = () => {
    let data = rows[table] ?? []
    if (call.inIds) data = data.filter((r) => call.inIds!.includes(r.id))
    const total = data.length
    if (call.range) data = data.slice(call.range[0], call.range[1] + 1)
    return { data, error: null, count: total }
  }
  const filter = (method: string) => (...args: unknown[]) => { call.filters.push({ method, args }); return q }
  const q: Record<string, unknown> = {
    select: (cols: string) => { call.select = cols; return q },
    eq: filter('eq'), is: filter('is'), or: filter('or'), not: filter('not'), ilike: filter('ilike'),
    order: (col: string) => { call.orders.push(col); return q },
    range: (a: number, b: number) => { call.range = [a, b]; return q },
    in: (c: string, ids: unknown[]) => {
      if (c === 'id') call.inIds = ids
      else call.filters.push({ method: 'in', args: [c, ids] })
      return q
    },
    then: (res: (v: unknown) => void) => res(result()),
  }
  return q
}

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ from: (t: string) => chain(t) }) }))
let authOk = true
vi.mock('@/lib/apiKeyAuth', () => ({
  requireApiKey: vi.fn(async () => (authOk ? { ok: true } : { ok: false, error: 'unauthorized', status: 401 })),
}))

import { API_PAGE_DEFAULT, parseAccountListParams, parseDealListParams, parsePagination } from '@/domain/crm/queries/apiV1'
import { OPEN_DEAL_STAGE_FILTER } from '@/domain/crm/sales'
import { GET as getAccounts } from '@/app/api/v1/accounts/route'
import { GET as getDeals } from '@/app/api/v1/deals/route'
import { GET as getPartners } from '@/app/api/v1/partners/route'

const req = (path: string) => new Request(`http://localhost${path}`)
const acc = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `a${i}`, name: `A${i}` }))

beforeEach(() => {
  calls = []
  rows = { account: acc(5), deal: acc(3), partner: [] }
  authOk = true
})

describe('parseAccountListParams / parseDealListParams', () => {
  it('limit max 500, offset bez limit smí (výchozí stránka), boolean jen true/false', () => {
    expect(parseAccountListParams(new URLSearchParams('offset=100'))).toEqual({ ok: true, value: { offset: 100 } })
    expect(parseAccountListParams(new URLSearchParams('has_open_deal=false&search=Ac'))).toEqual({ ok: true, value: { has_open_deal: false, search: 'Ac' } })
    expect(parseAccountListParams(new URLSearchParams('limit=501')).ok).toBe(false)
    expect(parseAccountListParams(new URLSearchParams('has_open_deal=ano')).ok).toBe(false)
    expect(parseAccountListParams(new URLSearchParams('search=A')).ok).toBe(false)
    expect(parseDealListParams(new URLSearchParams('account_id=3&only_open=true'))).toEqual({ ok: true, value: { account_id: 3, only_open: true } })
    expect(parseDealListParams(new URLSearchParams('account_id=-1')).ok).toBe(false)
  })
})

describe('parsePagination', () => {
  it('accepts empty, valid limit/offset', () => {
    expect(parsePagination(new URLSearchParams(''))).toEqual({ ok: true, value: {} })
    expect(parsePagination(new URLSearchParams('limit=10&offset=20'))).toEqual({ ok: true, value: { limit: 10, offset: 20 } })
    expect(parsePagination(new URLSearchParams('limit=500')).ok).toBe(true)
  })
  it.each(['limit=0', 'limit=501', 'limit=abc', 'limit=1.5', 'limit=5&offset=-1', 'offset=5'])('rejects %s', (qs) => {
    expect(parsePagination(new URLSearchParams(qs)).ok).toBe(false)
  })
})

describe('GET /api/v1 lists', () => {
  it('bez limit: první stránka (výchozí 100) + next_offset, nikdy tichý strop', async () => {
    const res = await getAccounts(req('/api/v1/accounts'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.accounts).toHaveLength(5)
    expect(body.next_offset).toBeNull()
    expect(body.total).toBe(5)
    expect(calls[0].range).toEqual([0, API_PAGE_DEFAULT])
    rows.account = acc(250)
    const big = await (await getAccounts(req('/api/v1/accounts'))).json()
    expect(big.accounts).toHaveLength(API_PAGE_DEFAULT)
    expect(big.next_offset).toBe(API_PAGE_DEFAULT)
    expect(big.total).toBe(250)
    const next = await (await getAccounts(req(`/api/v1/accounts?offset=${big.next_offset}`))).json()
    expect(next.accounts[0].id).toBe(`a${API_PAGE_DEFAULT}`)
  })

  it('úzký výčet sloupců, žádné *', async () => {
    await getAccounts(req('/api/v1/accounts'))
    await getDeals(req('/api/v1/deals'))
    expect(calls[0].select).not.toContain('*')
    expect(calls[0].select).not.toContain('notes')
    expect(calls[1].select).not.toContain('*')
    expect(calls[1].select).not.toMatch(/\bnote\b|problem|decision/)
  })

  it('filtry klientů: search (název nebo IČO, escapované), has_open_deal true/false', async () => {
    await getAccounts(req('/api/v1/accounts?search=Acme%25,x&has_open_deal=true'))
    expect(calls[0].select).toContain('open_deals:deal!deal_account_id_fkey!inner(id)')
    expect(calls[0].filters).toContainEqual({ method: 'in', args: ['open_deals.stage', OPEN_DEAL_STAGE_FILTER] })
    expect(calls[0].filters).toContainEqual({ method: 'or', args: ['name.ilike."%Acme\\\\%,x%",ico.ilike."%Acme\\\\%,x%"'] })
    await getAccounts(req('/api/v1/accounts?has_open_deal=false'))
    expect(calls[1].select).toContain('open_deals:deal!deal_account_id_fkey(id)')
    expect(calls[1].filters).toContainEqual({ method: 'is', args: ['open_deals', null] })
  })

  it('vnořené open_deals se z výstupu odstraní', async () => {
    rows.account = [{ id: 1, name: 'A', open_deals: [{ id: 3 }] }]
    const body = await (await getAccounts(req('/api/v1/accounts?has_open_deal=true'))).json()
    expect(body.accounts).toEqual([{ id: 1, name: 'A' }])
  })

  it('filtry obchodů: account_id, only_open, search', async () => {
    await getDeals(req('/api/v1/deals?account_id=7&only_open=true&search=audit'))
    expect(calls[0].filters).toEqual(expect.arrayContaining([
      { method: 'eq', args: ['account_id', 7] },
      { method: 'in', args: ['stage', OPEN_DEAL_STAGE_FILTER] },
      { method: 'ilike', args: ['title', '%audit%'] },
    ]))
    await getDeals(req('/api/v1/deals?only_open=false'))
    expect(calls[1].filters[0]).toMatchObject({ method: 'not', args: ['stage', 'in', expect.stringContaining('"kvalifikace"')] })
  })

  it('partneři bez limitu: všichni po stránkách (žádný strop 1000)', async () => {
    rows.partner = Array.from({ length: 1500 }, (_, i) => ({ id: `p${i}`, name: `P${i}`, via_partner_id: null }))
    const body = await (await getPartners(req('/api/v1/partners'))).json()
    expect(body.partners).toHaveLength(1500)
    expect(body.next_offset).toBeNull()
    expect(calls.filter((c) => c.table === 'partner').map((c) => c.range)).toEqual([[0, 999], [1000, 1999]])
  })

  it('orders stably with id tiebreaker', async () => {
    await getAccounts(req('/api/v1/accounts'))
    await getDeals(req('/api/v1/deals'))
    await getPartners(req('/api/v1/partners'))
    expect(calls.map((c) => c.orders)).toEqual([['name', 'id'], ['created_at', 'id'], ['name', 'id']])
  })

  it('paginates with next_offset', async () => {
    const r1 = await (await getAccounts(req('/api/v1/accounts?limit=2'))).json()
    expect(r1.accounts.map((a: { id: string }) => a.id)).toEqual(['a0', 'a1'])
    expect(r1.next_offset).toBe(2)
    expect(calls[0].range).toEqual([0, 2])
    const r3 = await (await getAccounts(req('/api/v1/accounts?limit=2&offset=4'))).json()
    expect(r3.accounts.map((a: { id: string }) => a.id)).toEqual(['a4'])
    expect(r3.next_offset).toBeNull()
  })

  it('exact last page has next_offset null', async () => {
    const r = await (await getDeals(req('/api/v1/deals?limit=3'))).json()
    expect(r.deals).toHaveLength(3)
    expect(r.next_offset).toBeNull()
  })

  it('returns 400 on invalid params', async () => {
    const res = await getDeals(req('/api/v1/deals?limit=9999'))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('invalid_pagination')
  })

  it('auth check runs before param validation', async () => {
    authOk = false
    const res = await getPartners(req('/api/v1/partners?limit=bad'))
    expect(res.status).toBe(401)
    expect(calls).toHaveLength(0)
  })

  it('partners resolve via name even when via partner is off-page', async () => {
    rows.partner = [
      { id: 'p1', name: 'P1', via_partner_id: 'p9' },
      { id: 'p2', name: 'P2', via_partner_id: null },
      { id: 'p9', name: 'P9', via_partner_id: null },
    ]
    const r = await (await getPartners(req('/api/v1/partners?limit=1'))).json()
    expect(r.partners[0].via).toEqual({ id: 'p9', name: 'P9' })
    expect(r.next_offset).toBe(1)
  })
})
