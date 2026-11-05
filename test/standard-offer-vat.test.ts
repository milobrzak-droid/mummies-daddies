// DPH po sazbách podle druhu plnění a ceny včetně DPH pro spotřebitele
// (core/standardOffer.ts, P3) — nad pevnou ukázkovou mapou s vlastními
// sazbami, a nad mapou firmy (jen tvar textu).
import { describe, expect, test } from 'vitest'
import { COMPANY } from '@/config'
import { FIXTURE_COMPANY_NAME, FIXTURE_OFFER } from './helpers/priceMapFixture'
import { evaluateStandardOffer, priceMapProblems, renderOfferEmail } from '@/core/standardOffer'
import type { StandardOfferConfig } from '@/core/tenant'

const TODAY = '2026-11-05'

const WITH_RATES: StandardOfferConfig = {
  ...FIXTURE_OFFER,
  priceMap: {
    ...FIXTURE_OFFER.priceMap,
    vatRates: { food: 0.12, service: 0.12, delivery: 0.21, rental: 0.21, alcohol: 0.21 },
    segments: FIXTURE_OFFER.priceMap.segments.map((s) => (s.key === 'b2c' ? { ...s, pricesIncludeVat: true } : s)),
    extras: FIXTURE_OFFER.priceMap.extras.map((e) =>
      e.key === 'napoje_alko' ? { ...e, vatClass: 'alcohol' as const } : e.key === 'pronajem_stanu' ? { ...e, vatClass: 'rental' as const } : e),
  },
}

describe('DPH po řádcích', () => {
  test('každá sazba ze součtu svých základů; jídlo a obsluha 12 %, alkohol a doprava 21 %', () => {
    const r = evaluateStandardOffer(WITH_RATES, {
      segment: 'b2b', eventType: 'raut', eventDate: '2026-12-03', guests: 80, distanceKm: 35,
      extras: ['napoje_alko', 'pronajem_stanu'], dietary: [],
    }, TODAY)
    if (r.kind !== 'standard') throw new Error(r.kind)
    const q = r.quote
    const byKey = Object.fromEntries(q.lines.map((l) => [l.key, l.vatRate]))
    expect(byKey).toEqual({ 'package:raut_standard': 0.12, staff: 0.12, 'extra:napoje_alko': 0.21, 'extra:pronajem_stanu': 0.21, delivery: 0.21 })
    const food = 80 * 590 + 4 * 5 * 450
    const high = 80 * 220 + 6500 + 15 * 2 * 28
    expect(q.vatBreakdown).toEqual([
      { rate: 0.12, base: food, vat: Math.round(food * 0.12) },
      { rate: 0.21, base: high, vat: Math.round(high * 0.21) },
    ])
    expect(q.vat).toBe(Math.round(food * 0.12) + Math.round(high * 0.21))
    expect(q.total).toBe(q.subtotal + q.vat)
    expect(q.pricesIncludeVat).toBe(false)

    const { body } = renderOfferEmail(q, { companyName: FIXTURE_COMPANY_NAME, signature: 'Podpis' })
    expect(body).toContain('Cena (bez DPH):')
    expect(body).toMatch(/DPH 12 % ze základu 56\s200 Kč: 6\s744 Kč/)
    expect(body).toMatch(/DPH 21 % ze základu 24\s940 Kč: 5\s237 Kč/)
    expect(body).toContain('Kalkulace je nezávazná')
    expect(body).not.toMatch(/Termín je potvrzený až po Vašem potvrzení/)
  })

  test('bez vlastních sazeb platí jediná sazba (zpětně kompatibilní)', () => {
    const r = evaluateStandardOffer(FIXTURE_OFFER, { segment: 'b2b', eventType: 'coffee_break', eventDate: '2026-12-03', guests: 50, distanceKm: 5 }, TODAY)
    if (r.kind !== 'standard') throw new Error(r.kind)
    expect(r.quote.vatBreakdown).toEqual([{ rate: 0.12, base: 50 * 180, vat: Math.round(50 * 180 * 0.12) }])
  })

  test('spotřebitel (B2C) vidí ceny včetně DPH; výpočet zůstává bez DPH', () => {
    const r = evaluateStandardOffer(WITH_RATES, {
      segment: 'b2c', eventType: 'oslava', eventDate: '2026-12-03', guests: 30, distanceKm: 10, extras: ['napoje_alko'], dietary: [],
    }, TODAY)
    if (r.kind !== 'standard') throw new Error(r.kind)
    const q = r.quote
    expect(q.pricesIncludeVat).toBe(true)
    expect(q.subtotal).toBe(30 * 520 + 2 * 5 * 450 + 30 * 220)
    const { body } = renderOfferEmail(q, { companyName: FIXTURE_COMPANY_NAME, signature: 'Podpis' })
    expect(body).toContain('Cena (včetně DPH):')
    // 520 Kč bez DPH = 582,40 Kč s 12 % DPH; 30 hostů = 17 472 Kč.
    expect(body).toMatch(/Raut na oslavu: 30 host × 582,4 Kč = 17\s472 Kč/)
    // Alkohol 21 %: 220 → 266,20 Kč.
    expect(body).toMatch(/Víno a pivo: 30 host × 266,2 Kč = 7\s986 Kč/)
    expect(body).toMatch(new RegExp(`Celkem včetně DPH: ${new Intl.NumberFormat('cs-CZ').format(q.total).replace(/\s/g, '\\s')} Kč`))
    expect(body).not.toContain('Celkem bez DPH')
  })

  test('mapa firmy: sazby v rozsahu, alkohol 21 %, B2C včetně DPH, pilotní strop samostatného odeslání', () => {
    const map = COMPANY.capabilities.standardOffer!.priceMap
    expect(priceMapProblems(map)).toEqual([])
    expect(map.vatRates?.alcohol).toBe(0.21)
    expect(map.extras.find((e) => e.key === 'napoje_alko')?.vatClass).toBe('alcohol')
    expect(map.segments.find((s) => s.key === 'b2c')?.pricesIncludeVat).toBe(true)
    expect(map.autoSendMaxTotal).toBeLessThanOrEqual(50_000)
    expect(priceMapProblems({ ...map, vatRates: { food: 1.2 } })).toContain('vatRates.food mimo 0–1')
  })
})
