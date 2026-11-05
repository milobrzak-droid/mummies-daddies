// Přehled objednávek cheesecaků z webu (P5): počty a tržba za období,
// nejbližší nepředané objednávky a žádné osobní údaje ve výstupu.
import { describe, expect, test } from 'vitest'
import { buildShopOrderOverview, itemsSummary, type ShopOrderOverviewRow } from '@/domain/crm/shopOrderOverview'

const o = (id: number, over: Partial<ShopOrderOverviewRow> = {}): ShopOrderOverviewRow => ({
  id, received_at: '2026-11-02T09:00:00Z', status: 'new', fulfilment_date: '2026-11-08', fulfilment: 'pickup',
  items: [{ product_key: 'daddy_vanilka', label: 'Daddy vanilkový', quantity: 1 }], total_czk: 790, ...over,
})

describe('buildShopOrderOverview', () => {
  test('počty, tržba bez zrušených a nejbližší předání', () => {
    const r = buildShopOrderOverview({
      from: '2026-10-07', to: '2026-11-05', today: '2026-11-05',
      received: [o(1), o(2, { status: 'cancelled', total_czk: 1290 }), o(3, { status: 'handed_over', fulfilment_date: '2026-11-04' }), o(4, { received_at: '2026-09-01T09:00:00Z', status: 'handed_over' })],
      upcoming: [o(5, { status: 'confirmed', fulfilment_date: '2026-11-06', fulfilment: 'delivery', total_czk: '1150' }), o(1)],
    })
    expect(r).toMatchObject({ received: 3, revenueCzk: 1580, cancelled: 1, awaitingConfirmation: 1 })
    expect(r.byStatus.map((s) => [s.key, s.count])).toEqual([['new', 1], ['handed_over', 1], ['cancelled', 1]])
    expect(r.upcoming.map((u) => [u.id, u.day, u.fulfilmentLabel, u.statusLabel, u.totalCzk])).toEqual([
      [5, '2026-11-06', 'Doručení', 'Potvrzená', 1150],
      [1, '2026-11-08', 'Vyzvednutí', 'Nová', 790],
    ])
  })

  test('souhrn položek', () => {
    expect(itemsSummary([{ label: 'Mini mix', quantity: 2 }, { product_key: 'x', quantity: 1 }])).toBe('2× Mini mix, 1× x')
    expect(itemsSummary(null)).toBe('')
  })
})
