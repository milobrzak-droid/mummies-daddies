// Kontrakt objednávky cheesecaků (core/cheesecakeOrder.ts): cena z ceníku
// firmy, sezóna, předstih, payload pro RPC shop_order_submit.
import { describe, expect, test } from 'vitest'
import { COMPANY } from '@/config'
import { inSeason, priceShopOrder, shopOrderPayload, shopOrderSchema, type ShopOrderInput } from '@/core/cheesecakeOrder'

const SHOP = COMPANY.shop
const order = (over: Partial<ShopOrderInput> = {}): ShopOrderInput => ({
  clientToken: '0b0f5c7e-9d3c-4c4f-8c51-6c1f2a7b9e11',
  items: [{ productKey: 'mini_mix', quantity: 2 }, { productKey: 'daddy_vanilka', quantity: 1 }],
  fulfilmentDate: '2026-11-20', fulfilment: 'pickup',
  customer: { name: 'Petra Svobodová', email: 'petra@email.example', phone: '+420 600 000 000' },
  consent: { processing: true },
  ...over,
})

describe('priceShopOrder', () => {
  test('cena z ceníku firmy, bez doručení', () => {
    const r = priceShopOrder(SHOP, shopOrderSchema.parse(order()), '2026-11-10')
    expect(r).toEqual({
      ok: true,
      lines: [
        { productKey: 'mini_mix', label: 'Mini cheesecaky mix', quantity: 2, unitPriceCzk: 575, totalCzk: 1150 },
        { productKey: 'daddy_vanilka', label: 'Daddy vanilkový', quantity: 1, unitPriceCzk: 790, totalCzk: 790 },
      ],
      deliveryCzk: 0,
      totalCzk: 1940,
    })
  })

  test('předstih, neznámý produkt, množství a vypnuté doručení', () => {
    const p = (o: Partial<ShopOrderInput>, today = '2026-11-10') => priceShopOrder(SHOP, shopOrderSchema.parse(order(o)), today)
    expect(p({ fulfilmentDate: '2026-11-11' })).toEqual({ ok: false, problems: ['date_too_soon'] })
    expect(p({ fulfilmentDate: '2027-06-01' })).toEqual({ ok: false, problems: ['date_too_far'] })
    expect(p({ items: [{ productKey: 'neexistuje', quantity: 1 }] })).toEqual({ ok: false, problems: ['unknown_product'] })
    expect(p({ items: [{ productKey: 'mini_mix', quantity: SHOP.maxQuantityPerItem + 1 }] })).toEqual({ ok: false, problems: ['quantity_over_limit'] })
    expect(p({ fulfilment: 'delivery', deliveryAddress: 'Praha 2' })).toEqual({ ok: false, problems: ['delivery_unavailable'] })
  })

  test('sezónní vánoční dort jen v sezóně', () => {
    const p = (date: string, today: string) =>
      priceShopOrder(SHOP, shopOrderSchema.parse(order({ items: [{ productKey: 'mummy_vanilka_pomeranc_vanocni', quantity: 1 }], fulfilmentDate: date })), today)
    expect(p('2026-12-20', '2026-12-01').ok).toBe(true)
    expect(p('2027-02-10', '2027-01-20')).toEqual({ ok: false, problems: ['out_of_season'] })
  })

  test('sezóna přes přelom roku', () => {
    expect(inSeason({ season: { from: '12-01', to: '01-15' } }, '2027-01-10')).toBe(true)
    expect(inSeason({ season: { from: '12-01', to: '01-15' } }, '2027-02-10')).toBe(false)
    expect(inSeason({ season: null }, '2027-02-10')).toBe(true)
  })
})

describe('shopOrderSchema a payload', () => {
  test('doručení bez adresy neprojde', () => {
    expect(shopOrderSchema.safeParse(order({ fulfilment: 'delivery' })).success).toBe(false)
  })

  test('payload nese položky s cenou ze serveru', () => {
    const o = shopOrderSchema.parse(order())
    const pricing = priceShopOrder(SHOP, o, '2026-11-10')
    if (!pricing.ok) throw new Error('cena')
    const p = shopOrderPayload(o, pricing)
    expect(p).toMatchObject({ client_token: o.clientToken, fulfilment: 'pickup', total_czk: 1940, delivery_czk: 0 })
    expect(p.items).toEqual([
      { product_key: 'mini_mix', label: 'Mini cheesecaky mix', quantity: 2, unit_price_czk: 575, total_czk: 1150 },
      { product_key: 'daddy_vanilka', label: 'Daddy vanilkový', quantity: 1, unit_price_czk: 790, total_czk: 790 },
    ])
  })
})
