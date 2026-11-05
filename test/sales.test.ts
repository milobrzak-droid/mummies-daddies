import { describe, expect, test } from 'vitest'
import { buildSalesDashboard, buildSalesFocus, weightedValue, type SalesActivityLike, type SalesDealLike } from '@/domain/crm/sales'
import type { DealStage, TeamMember } from '@/lib/types'

function deal(input: {
  id: number
  stage: DealStage
  amount: number
  probability?: number | null
  ownerId?: string | null
  wonAt?: string | null
  closedAt?: string | null
  expectedClose?: string | null
  nextStepDue?: string | null
  lastActivityAt?: string | null
}): SalesDealLike {
  return {
    id: input.id,
    stage: input.stage,
    amount_one_time: input.amount,
    probability_pct: input.probability ?? null,
    owner_id: input.ownerId ?? null,
    won_at: input.wonAt ?? null,
    closed_at: input.closedAt ?? null,
    expected_close: input.expectedClose ?? null,
    next_step_due: input.nextStepDue ?? null,
    last_activity_at: input.lastActivityAt ?? null,
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-08-12T00:00:00.000Z',
    account: { id: 1, name: 'Acme' },
    owner: input.ownerId ? { id: input.ownerId, full_name: input.ownerId === 'a' ? 'Anna' : 'Boris' } : null,
    primary_contact: null,
  } as SalesDealLike
}

const members = [
  { id: 'a', full_name: 'Anna', role: 'obchodnik' },
  { id: 'b', full_name: 'Boris', role: 'obchodnik' },
] as TeamMember[]

describe('sales dashboard', () => {
  test('uses stage probability when a deal has no manual probability', () => {
    expect(weightedValue(deal({ id: 1, stage: 'rozsah_nabidka', amount: 1_000_000 }))).toBe(550_000)
  })

  test('calculates pipeline, conversion, attention and leaderboard', () => {
    const deals = [
      deal({
        id: 1, stage: 'rozsah_nabidka', amount: 1_000_000, probability: 50, ownerId: 'a',
        expectedClose: '2026-08-25', nextStepDue: '2026-08-18', lastActivityAt: '2026-07-20T00:00:00.000Z',
      }),
      deal({ id: 2, stage: 'vyhráno', amount: 2_000_000, ownerId: 'a', wonAt: '2026-08-10', closedAt: '2026-08-10' }),
      deal({ id: 3, stage: 'prohráno', amount: 500_000, ownerId: 'b', closedAt: '2026-08-12' }),
    ]
    const activities = [{
      id: 1, account_id: 1, deal_id: 1, contact_id: null,
      kind: 'call', outcome: 'completed', subject: 'Call', body: null,
      occurred_at: '2026-08-15T10:00:00.000Z', follow_up_on: null,
      created_by: 'a', created_at: '2026-08-15T10:00:00.000Z',
    }] as SalesActivityLike[]

    const result = buildSalesDashboard(deals, activities, members, new Date('2026-08-19T12:00:00.000Z'))

    expect(result.openPipeline).toBe(1_000_000)
    expect(result.weightedPipeline).toBe(500_000)
    expect(result.wonThisMonth).toBe(2_000_000)
    expect(result.closing30d).toBe(1_000_000)
    expect(result.conversionPct).toBe(50)
    expect(result.overdueDeals.map((item) => item.id)).toEqual([1])
    expect(result.staleDeals.map((item) => item.id)).toEqual([1])
    expect(result.focus[0]).toMatchObject({ reason: 'overdue', deal: { id: 1 } })
    expect(result.leaderboard[0]).toMatchObject({
      ownerId: 'a', wonThisMonth: 2_000_000, activities30d: 1, overdueNextSteps: 1,
    })
  })

  test('prioritizes overdue work before missing plans, closing deals and stale work', () => {
    const deals = [
      deal({ id: 1, stage: 'kvalifikace', amount: 10_000, nextStepDue: '2026-08-18' }),
      deal({ id: 2, stage: 'rozsah_nabidka', amount: 20_000, lastActivityAt: '2026-08-18T00:00:00.000Z' }),
      deal({ id: 3, stage: 'rozhodovani', amount: 30_000, expectedClose: '2026-08-22', nextStepDue: '2026-08-21', lastActivityAt: '2026-08-18T00:00:00.000Z' }),
      deal({ id: 4, stage: 'kvalifikace', amount: 40_000, nextStepDue: '2026-09-01', lastActivityAt: '2026-07-01T00:00:00.000Z' }),
    ]
    deals[0].next_step = 'Zavolat'
    deals[1].next_step = null
    deals[2].next_step = 'Potvrdit podpis'
    deals[3].next_step = 'Ozvat se'

    expect(buildSalesFocus(deals, new Date('2026-08-19T12:00:00.000Z')).map((item) => item.reason))
      .toEqual(['overdue', 'missing_next_step', 'closing_soon', 'stale'])
  })
})
