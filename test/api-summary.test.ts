// get_summary (MCP) a /api/v1/summary: čísla jen z toho, co do nich patří.
// Pipeline, MD, počty a by_phase jen z otevřených obchodů; marže jen ze
// zakázek se známým nákladem (a kolik jich náklad nemá); MRR zvlášť; obchody
// bez pilíře/fáze ve skupině „nezařazeno"; souhrn čte všechny obchody po
// stránkách (žádný tichý strop 1000 řádků).
import { describe, expect, it, test, vi } from 'vitest'
import { getSummaryForApi, summarizeDealsForApi, UNASSIGNED_PHASE, type SummaryDealRow } from '@/domain/crm/queries/apiV1'
import { OPEN_DEAL_STAGES } from '@/domain/crm/sales'

let dealRows: SummaryDealRow[] = []
const ranges: [number, number][] = []
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    from: () => {
      const q = {
        select: () => q,
        order: () => q,
        range: (a: number, b: number) => {
          ranges.push([a, b])
          return Promise.resolve({ data: dealRows.slice(a, b + 1), error: null })
        },
      }
      return q
    },
  }),
}))

const deal = (over: Partial<SummaryDealRow>): SummaryDealRow => ({
  stage: 'kvalifikace', amount_one_time: 0, cogs_one_time: 0, expected_mrr: 0, estimate_md: null,
  status_blocker: null, pillar: 'cheesecaky', phase: 'realizovano', ...over,
})

describe('summarizeDealsForApi', () => {
  const s = summarizeDealsForApi([
    deal({ amount_one_time: '100000', cogs_one_time: '40000', estimate_md: 10, expected_mrr: 5000 }),
    deal({ amount_one_time: 50000, cogs_one_time: 0, estimate_md: 5, status_blocker: 'čeká na podpis', pillar: null, phase: null }),
    deal({ stage: 'nabídka', amount_one_time: 30000, cogs_one_time: null, pillar: 'b2b_akce', phase: null }), // stará fáze = otevřený
    deal({ stage: 'vyhráno', amount_one_time: 200000, cogs_one_time: 1000, estimate_md: 40, expected_mrr: 9000, status_blocker: 'x' }),
    deal({ stage: 'prohráno', amount_one_time: 70000, estimate_md: 99, status_blocker: 'y' }),
    deal({ stage: 'odloženo', amount_one_time: 10000, estimate_md: 3 }),
  ])

  it('pipeline, MD, počty a blokované jen z otevřených', () => {
    expect(s.pipeline_czk).toBe(180000)
    expect(s.total_md).toBe(15)
    expect(s.won_md).toBe(40)
    expect(s.deal_count).toBe(3)
    expect(s.blocked_count).toBe(1)
    expect({ won: s.won_count, lost: s.lost_count, postponed: s.postponed_count }).toEqual({ won: 1, lost: 1, postponed: 1 })
    expect({ won: s.won_czk, lost: s.lost_czk }).toEqual({ won: 200000, lost: 70000 })
  })

  it('marže jen ze zakázek se známým nákladem + kolik náklad nemá', () => {
    expect(s.total_cost_czk).toBe(40000)
    expect(s.margin_czk).toBe(60000)
    expect(s.margin_pct).toBe(60)
    expect(s.margin_deal_count).toBe(1)
    expect(s.deals_without_cost).toBe(2)
  })

  it('MRR otevřených a vyhraných zvlášť', () => {
    expect(s.open_mrr_czk).toBe(5000)
    expect(s.won_mrr_czk).toBe(9000)
  })

  it('by_phase jen otevřené; bez pilíře nebo fáze = nezařazeno', () => {
    expect(s.by_phase).toEqual([
      { pillar: 'cheesecaky', phase: 'realizovano', count: 1, amount_czk: 100000 },
      { pillar: UNASSIGNED_PHASE, phase: UNASSIGNED_PHASE, count: 1, amount_czk: 50000 },
      { pillar: 'b2b_akce', phase: UNASSIGNED_PHASE, count: 1, amount_czk: 30000 },
    ])
  })

  it('bez obchodů nuly, žádné dělení nulou', () => {
    expect(summarizeDealsForApi([])).toMatchObject({ pipeline_czk: 0, margin_pct: 0, deal_count: 0, by_phase: [] })
  })
})

describe('getSummaryForApi', () => {
  it('čte všechny obchody po stránkách 1000 (2 500 obchodů = 3 dotazy)', async () => {
    dealRows = Array.from({ length: 2500 }, () => deal({ amount_one_time: 1 }))
    const s = await getSummaryForApi()
    expect(s.pipeline_czk).toBe(2500)
    expect(s.deal_count).toBe(2500)
    expect(ranges).toEqual([[0, 999], [1000, 1999], [2000, 2999]])
  })
})

// Regrese: /api/v1/summary a MCP get_summary sčítaly do „pipeline" všechny
// obchody včetně prohraných a vyhraných. Při 5 obchodech to znamenalo
// 4 944 300 Kč místo skutečných 2 670 300 Kč — nadhodnocení o 85 %.
// Test hlídá samotné pravidlo, na kterém ten výpočet stojí.
test('open stages exclude won and lost', () => {
  expect(OPEN_DEAL_STAGES).not.toContain('vyhráno')
  expect(OPEN_DEAL_STAGES).not.toContain('prohráno')
  expect(OPEN_DEAL_STAGES).not.toContain('odloženo')
})

test('open stages cover every stage a deal can still be won from', () => {
  for (const s of ['kvalifikace', 'diagnostika', 'rozsah_nabidka', 'rozhodovani']) {
    expect(OPEN_DEAL_STAGES).toContain(s)
  }
})
