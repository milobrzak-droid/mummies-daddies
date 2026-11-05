import { describe, expect, test } from 'vitest'
import { buildSalesDashboard, buildSalesFocus, isOpenDeal, weightedValue, type SalesDealLike } from '@/domain/crm/sales'
import type { DealStage, TeamMember } from '@/lib/types'

function deal(p: Partial<SalesDealLike> & { id: number; stage: DealStage }): SalesDealLike {
  return {
    amount_one_time: 0, probability_pct: null, owner_id: null, won_at: null, closed_at: null,
    expected_close: null, next_step: 'Call', next_step_due: '2026-12-31', last_activity_at: '2026-09-29T00:00:00.000Z',
    created_at: '2026-07-01T00:00:00.000Z', updated_at: '2026-08-12T00:00:00.000Z',
    account: null, owner: null, primary_contact: null, ...p,
  } as SalesDealLike
}

describe('weightedValue', () => {
  test('explicit 0 % overrides stage default', () => {
    expect(weightedValue({ stage: 'rozhodovani', amount_one_time: 1000, probability_pct: 0 } as never)).toBe(0)
  })
  test('null probability falls back per stage', () => {
    const w = (stage: DealStage) => weightedValue({ stage, amount_one_time: 1000, probability_pct: null } as never)
    expect([w('kvalifikace'), w('diagnostika'), w('rozhodovani'), w('vyhráno'), w('odloženo')]).toEqual([100, 300, 750, 1000, 0])
  })
  test('string / null / garbage amounts', () => {
    expect(weightedValue({ stage: 'kvalifikace', amount_one_time: '2500' as never, probability_pct: 50 } as never)).toBe(1250)
    expect(weightedValue({ stage: 'kvalifikace', amount_one_time: null, probability_pct: 50 } as never)).toBe(0)
    expect(weightedValue({ stage: 'kvalifikace', amount_one_time: 'x' as never, probability_pct: 50 } as never)).toBe(0)
  })
  test('fractional result is not rounded', () => {
    expect(weightedValue({ stage: 'kvalifikace', amount_one_time: 333, probability_pct: 33 } as never)).toBeCloseTo(109.89)
  })
})

describe('isOpenDeal', () => {
  test('odloženo is closed', () => {
    expect(isOpenDeal('odloženo')).toBe(false)
    expect(isOpenDeal('rozsah_nabidka')).toBe(true)
  })
})

describe('buildSalesFocus boundaries', () => {
  const now = new Date('2026-09-28T10:00:00.000Z')
  test('due today is not overdue; closed deals ignored', () => {
    const f = buildSalesFocus([
      deal({ id: 1, stage: 'kvalifikace', next_step_due: '2026-09-28' }),
      deal({ id: 2, stage: 'vyhráno', next_step_due: '2020-01-01' }),
    ], now)
    expect(f).toEqual([])
  })
  test('closing window is inclusive of today and today+7', () => {
    const f = buildSalesFocus([
      deal({ id: 1, stage: 'kvalifikace', expected_close: '2026-09-28' }),
      deal({ id: 2, stage: 'kvalifikace', expected_close: '2026-10-05' }),
      deal({ id: 3, stage: 'kvalifikace', expected_close: '2026-10-06' }),
    ], now)
    expect(f.map((i) => [i.deal.id, i.reason])).toEqual([[1, 'closing_soon'], [2, 'closing_soon']])
  })
  test('missing next_step text alone counts as missing plan', () => {
    const f = buildSalesFocus([deal({ id: 1, stage: 'kvalifikace', next_step: null })], now)
    expect(f[0].reason).toBe('missing_next_step')
  })
  test('stale uses created_at when no activity; exact 14 days is not stale', () => {
    const f = buildSalesFocus([
      deal({ id: 1, stage: 'kvalifikace', last_activity_at: null, created_at: '2026-09-01T00:00:00.000Z' }),
      deal({ id: 2, stage: 'kvalifikace', last_activity_at: '2026-09-14T10:00:00.000Z' }),
    ], now)
    expect(f.map((i) => i.deal.id)).toEqual([1])
    expect(f[0].reason).toBe('stale')
  })
  test('ties sort by due date then larger amount', () => {
    const f = buildSalesFocus([
      deal({ id: 1, stage: 'kvalifikace', next_step_due: '2026-09-20', amount_one_time: 10 }),
      deal({ id: 2, stage: 'kvalifikace', next_step_due: '2026-09-20', amount_one_time: 500 }),
      deal({ id: 3, stage: 'kvalifikace', next_step_due: '2026-09-10', amount_one_time: 1 }),
    ], now)
    expect(f.map((i) => i.deal.id)).toEqual([3, 2, 1])
  })
})

describe('buildSalesDashboard month and owner edges', () => {
  const members = [
    { id: 'a', full_name: 'Anna', role: 'obchodnik' },
    { id: 'p', full_name: 'Petr', role: 'projektak' },
  ] as TeamMember[]

  test('month buckets follow Europe/Prague calendar, not UTC', () => {
    // 2026-09-28 v Praze; obchod 1. 9. 01:30 Praha (= 31. 8. 23:30 UTC) patří do září.
    const now = new Date('2026-09-28T10:00:00.000Z')
    const d = buildSalesDashboard([
      deal({ id: 1, stage: 'vyhráno', amount_one_time: 100, won_at: '2026-09-01' }),
      deal({ id: 2, stage: 'vyhráno', amount_one_time: 50, won_at: '2026-08-31T23:30:00.000Z' }),
      deal({ id: 3, stage: 'vyhráno', amount_one_time: 7, won_at: '2026-08-31T21:30:00.000Z' }), // 23:30 Praha 31. 8.
    ], [], members, now)
    expect(d.wonThisMonth).toBe(150)
  })
  test('current month is Prague month when UTC is still previous month', () => {
    // 2026-09-30T22:30Z je v Praze už 1. 10. (CEST, +2)
    const now = new Date('2026-09-30T22:30:00.000Z')
    const d = buildSalesDashboard([
      deal({ id: 1, stage: 'vyhráno', amount_one_time: 100, won_at: '2026-09-30' }),
      deal({ id: 2, stage: 'vyhráno', amount_one_time: 50, won_at: '2026-09-30T22:15:00.000Z' }),
    ], [], members, now)
    expect(d.wonThisMonth).toBe(50)
  })
  test('DST edge: end of October switch to CET (+1)', () => {
    // 2026-10-25 přechod na zimní čas; 2026-10-31T23:30Z = 1. 11. 00:30 Praha.
    const now = new Date('2026-10-31T23:30:00.000Z')
    const d = buildSalesDashboard([
      deal({ id: 1, stage: 'vyhráno', amount_one_time: 10, won_at: '2026-10-31T22:59:00.000Z' }), // 23:59 Praha, říjen
      deal({ id: 2, stage: 'vyhráno', amount_one_time: 20, won_at: '2026-10-31T23:00:00.000Z' }), // 00:00 Praha, listopad
    ], [], members, now)
    expect(d.wonThisMonth).toBe(20)
  })
  test('DST edge: end of March in CET (+1), April starts at 22:00Z', () => {
    // 2026-03-29 přechod na letní čas; 1. 4. 00:00 Praha = 2026-03-31T22:00Z.
    const now = new Date('2026-04-15T10:00:00.000Z')
    const d = buildSalesDashboard([
      deal({ id: 1, stage: 'vyhráno', amount_one_time: 10, won_at: '2026-03-31T21:59:00.000Z' }), // 23:59 Praha, březen
      deal({ id: 2, stage: 'vyhráno', amount_one_time: 20, won_at: '2026-03-31T22:00:00.000Z' }), // 00:00 Praha, duben
    ], [], members, now)
    expect(d.wonThisMonth).toBe(20)
  })
  test('conversion is 0 with no closed deals and counts prohráno', () => {
    const now = new Date('2026-09-28T10:00:00.000Z')
    expect(buildSalesDashboard([], [], members, now).conversionPct).toBe(0)
    const d = buildSalesDashboard([
      deal({ id: 1, stage: 'vyhráno', won_at: '2026-09-02', closed_at: '2026-09-02' }),
      deal({ id: 2, stage: 'prohráno', closed_at: '2026-09-03' }),
      deal({ id: 3, stage: 'prohráno', closed_at: '2026-09-04' }),
    ], [], members, now)
    expect(d.conversionPct).toBe(33)
  })
  test('deals owned by non-sales roles appear in the leaderboard under their own owner', () => {
    const now = new Date('2026-09-28T10:00:00.000Z')
    const d = buildSalesDashboard([
      deal({ id: 1, stage: 'kvalifikace', owner_id: 'p', amount_one_time: 1000, owner: { id: 'p', full_name: 'Petr' } }),
      deal({ id: 2, stage: 'kvalifikace', owner_id: null, amount_one_time: 200 }),
    ], [], members, now)
    expect(d.openPipeline).toBe(1200)
    // Petr (role projektak) má obchod, takže dostává řádek; obchodnice Anna zůstává i bez obchodů.
    expect(d.leaderboard.map((r) => [r.ownerName, r.openPipeline]).sort())
      .toEqual([['Anna', 0], ['Nepřiřazeno', 200], ['Petr', 1000]])
  })

  test('member with no deals keeps a zero row only for obchodnik/vedeni roles', () => {
    const now = new Date('2026-09-28T10:00:00.000Z')
    const d = buildSalesDashboard([
      deal({ id: 1, stage: 'kvalifikace', owner_id: 'a', amount_one_time: 300 }),
    ], [], members, now)
    // Petr (projektak) nevlastní žádný obchod, takže se v leaderboardu vůbec neobjeví.
    expect(d.leaderboard.map((r) => r.ownerName).sort()).toEqual(['Anna'])
  })

  test('per-person leaderboard sums equal dashboard totals, including deals with no owner', () => {
    const now = new Date('2026-09-28T10:00:00.000Z')
    const deals = [
      deal({ id: 1, stage: 'kvalifikace', owner_id: 'a', amount_one_time: 1000, probability_pct: 50 }),
      deal({ id: 2, stage: 'rozhodovani', owner_id: 'p', amount_one_time: 2000, probability_pct: 25 }),
      deal({ id: 3, stage: 'kvalifikace', owner_id: null, amount_one_time: 500, probability_pct: 10 }),
      deal({
        id: 4, stage: 'vyhráno', owner_id: 'p', amount_one_time: 400,
        won_at: '2026-09-15', closed_at: '2026-09-15',
      }),
      deal({
        id: 5, stage: 'vyhráno', owner_id: null, amount_one_time: 100,
        won_at: '2026-09-16', closed_at: '2026-09-16',
      }),
    ]
    const d = buildSalesDashboard(deals, [], members, now)

    const sumOpenPipeline = d.leaderboard.reduce((sum, r) => sum + r.openPipeline, 0)
    const sumWeightedPipeline = d.leaderboard.reduce((sum, r) => sum + r.weightedPipeline, 0)
    const sumWonThisMonth = d.leaderboard.reduce((sum, r) => sum + r.wonThisMonth, 0)

    expect(sumOpenPipeline).toBe(d.openPipeline)
    expect(sumWeightedPipeline).toBe(d.weightedPipeline)
    expect(sumWonThisMonth).toBe(d.wonThisMonth)
  })
  test('closing30d inclusive of day +30', () => {
    const now = new Date('2026-09-28T10:00:00.000Z')
    const d = buildSalesDashboard([
      deal({ id: 1, stage: 'kvalifikace', amount_one_time: 7, expected_close: '2026-10-28' }),
      deal({ id: 2, stage: 'kvalifikace', amount_one_time: 9, expected_close: '2026-10-29' }),
    ], [], members, now)
    expect(d.closing30d).toBe(7)
  })
})
