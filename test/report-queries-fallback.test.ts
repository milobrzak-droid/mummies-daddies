import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { getDueFollowUps } from '@/domain/crm/queries/followUps'
import { getContractedOverTime, getImpactSummary } from '@/lib/queries/dashboard'
import { getBlockedDeals, getDigestFollowUps } from '@/domain/crm/queries/digest'
import { createSupabaseFake, hasOp, opArgs, type QueryCall, type QueryResult } from './helpers/supabaseFake'

// Dotazy pro přehled a dashboard: pohled z 0046 vs. JS fallback (jen když
// pohled chybí — jiná chyba se nesmí schovat) a skládání blokovaných obchodů
// a follow-upů pro digest. Supabase je fake.

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/domain/crm/queries/followUps', () => ({ getDueFollowUps: vi.fn(async () => []) }))

const ok = (data: unknown): QueryResult => ({ data, error: null })
function fake(resolve: (c: QueryCall) => QueryResult) {
  const f = createSupabaseFake({ resolve })
  vi.mocked(createClient).mockResolvedValue(f.client as never)
  return f
}
const MISSING = { code: 'PGRST205', message: 'Could not find the table' }

beforeEach(() => vi.clearAllMocks())

describe('getContractedOverTime', () => {
  test('pohled existuje → čísla z pohledu (i z řetězců), tabulka deal se nečte', async () => {
    const f = fake(() => ok([{ month: '2026-08', amount: '1500.50' }, { month: '2026-09', amount: null }]))
    expect(await getContractedOverTime()).toEqual([{ month: '2026-08', amount: 1500.5 }, { month: '2026-09', amount: 0 }])
    expect(f.calls.map((c) => c.table)).toEqual(['v_contracted_over_time'])
  })

  test('pohled chybí → vyhrané obchody seskupené po měsících', async () => {
    const f = fake((c) => (c.table === 'v_contracted_over_time'
      ? { data: null, error: MISSING }
      : ok([
        { won_at: '2026-09-02', amount_one_time: 100 },
        { won_at: '2026-08-31', amount_one_time: '50' },
        { won_at: '2026-09-30', amount_one_time: 25 },
        { won_at: null, amount_one_time: 999 },
      ])))
    expect(await getContractedOverTime()).toEqual([{ month: '2026-08', amount: 50 }, { month: '2026-09', amount: 125 }])
    const deal = f.calls.find((c) => c.table === 'deal')!
    expect(opArgs(deal, 'eq')).toEqual(['stage', 'vyhráno'])
  })

  test('jiná chyba pohledu (oprávnění) se vyhodí, fallback neběží', async () => {
    const f = fake(() => ({ data: null, error: { code: '42501', message: 'denied' } }))
    await expect(getContractedOverTime()).rejects.toMatchObject({ code: '42501' })
    expect(f.calls.some((c) => c.table === 'deal')).toBe(false)
  })

  test('chyba fallbacku se vyhodí', async () => {
    fake((c) => (c.table === 'deal' ? { data: null, error: { code: 'XX' } } : { data: null, error: { code: '42P01' } }))
    await expect(getContractedOverTime()).rejects.toMatchObject({ code: 'XX' })
  })
})

describe('getImpactSummary', () => {
  test('z pohledu: zaokrouhlené procento důkazů a hodiny týdně', async () => {
    fake(() => ok({ engagements_total: 3, with_audit: 2, trained_total: '40', minutes_per_week: 150, roi_total: '1000', reference_count: 1 }))
    expect(await getImpactSummary()).toEqual({
      proofRatePct: 67, engagementsTotal: 3, withAudit: 2, trainedTotal: 40, hoursPerWeek: 3, roiTotal: 1000, referenceCount: 1,
    })
  })

  test('prázdný pohled (null) → nuly, žádné dělení nulou', async () => {
    fake(() => ok(null))
    expect(await getImpactSummary()).toEqual({
      proofRatePct: 0, engagementsTotal: 0, withAudit: 0, trainedTotal: 0, hoursPerWeek: 0, roiTotal: 0, referenceCount: 0,
    })
  })

  test('pohled chybí → součty z dodávek', async () => {
    fake((c) => (c.table === 'v_impact_summary'
      ? { data: null, error: { code: '42P01' } }
      : ok([
        { post_adoption_pct: 40, post_captured_on: null, trained_count: 10, time_saved_min_week: 60, roi_czk_year: '500', reference_worthy: true },
        { post_adoption_pct: null, post_captured_on: null, trained_count: null, time_saved_min_week: null, roi_czk_year: null, reference_worthy: false },
      ])))
    expect(await getImpactSummary()).toEqual({
      proofRatePct: 50, engagementsTotal: 2, withAudit: 1, trainedTotal: 10, hoursPerWeek: 1, roiTotal: 500, referenceCount: 1,
    })
  })

  test('jiná chyba pohledu se vyhodí', async () => {
    fake(() => ({ data: null, error: { code: '42501' } }))
    await expect(getImpactSummary()).rejects.toMatchObject({ code: '42501' })
  })
})

describe('digest: blokované obchody a follow-upy', () => {
  test('getBlockedDeals: jen s blokerem, jméno klienta z embedu', async () => {
    const f = fake(() => ok([
      { id: 1, account_id: 2, title: 'A', status_blocker: 'Čeká na IT', account: { name: 'Acme' } },
      { id: 2, account_id: null, title: 'B', status_blocker: 'Právník', account: null },
      { id: 3, account_id: 4, title: 'C', status_blocker: null, account: { name: 'X' } },
    ]))
    expect(await getBlockedDeals()).toEqual([
      { id: 1, account_id: 2, title: 'A', account_name: 'Acme', status_blocker: 'Čeká na IT' },
      { id: 2, account_id: null, title: 'B', account_name: null, status_blocker: 'Právník' },
    ])
    expect(opArgs(f.calls[0], 'not')).toEqual(['status_blocker', 'is', null])
  })

  test('getBlockedDeals: chyba se vyhodí s kontextem', async () => {
    fake(() => ({ data: null, error: { message: 'boom' } }))
    await expect(getBlockedDeals()).rejects.toThrow('Načtení blokovaných obchodů selhalo: boom')
  })

  test('getDigestFollowUps: bez follow-upů žádný dotaz', async () => {
    const f = fake(() => ok([]))
    expect(await getDigestFollowUps()).toEqual([])
    expect(f.from).not.toHaveBeenCalled()
  })

  test('getDigestFollowUps: klient dotažený podle deal_id jedním dotazem bez duplicit', async () => {
    vi.mocked(getDueFollowUps).mockResolvedValueOnce([
      { deal_id: 1, title: 'A' }, { deal_id: 1, title: 'A2' }, { deal_id: 2, title: 'B' },
    ] as never)
    const f = fake(() => ok([{ id: 1, account_id: 10 }]))
    const out = await getDigestFollowUps()
    expect(out.map((n) => [n.deal_id, n.account_id])).toEqual([[1, 10], [1, 10], [2, null]])
    expect(f.calls).toHaveLength(1)
    expect(hasOp(f.calls[0], 'in')).toBe(true)
    expect(opArgs(f.calls[0], 'in')).toEqual(['id', [1, 2]])
  })

  test('getDigestFollowUps: chyba dotazu se vyhodí', async () => {
    vi.mocked(getDueFollowUps).mockResolvedValueOnce([{ deal_id: 1 }] as never)
    fake(() => ({ data: null, error: { message: 'x' } }))
    await expect(getDigestFollowUps()).rejects.toThrow(/follow-upům selhalo/)
  })
})
