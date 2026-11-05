// Schopnost „standardní nabídka z mapy" (core/standardOffer.ts) nad
// ilustrační mapou pilotní cateringové firmy (config/mummiesDaddies.ts).
import { describe, expect, test } from 'vitest'
import { FIXTURE_COMPANY_NAME, FIXTURE_OFFER } from './helpers/priceMapFixture'
import {
  evaluateStandardOffer,
  priceMapProblems,
  renderInfoRequest,
  renderOfferEmail,
  type OfferInquiryInput,
  type OfferResult,
} from '@/core/standardOffer'
import type { PriceMapConfig, StandardOfferConfig } from '@/core/tenant'

const CFG: StandardOfferConfig = FIXTURE_OFFER
const TODAY = '2026-11-05' // čtvrtek

const BASE: OfferInquiryInput = {
  segment: 'b2b',
  eventType: 'raut',
  eventDate: '2026-12-03', // čtvrtek
  guests: 80,
  distanceKm: 35,
  extras: ['napoje_alko'],
  dietary: [{ key: 'vegan', guests: 5 }],
}

const run = (over: Partial<OfferInquiryInput> = {}, today = TODAY) => evaluateStandardOffer(CFG, { ...BASE, ...over }, today)

function codes(r: OfferResult): string[] {
  expect(r.kind).toBe('escalate')
  return r.kind === 'escalate' ? r.reasons.map((x) => x.code) : []
}

describe('standardní nabídka', () => {
  test('firemní raut spočítaný řádek po řádku', () => {
    const r = run()
    expect(r.kind).toBe('standard')
    if (r.kind !== 'standard') return
    const q = r.quote
    expect(q.lines.map((l) => [l.key, l.total])).toEqual([
      ['package:raut_standard', 80 * 590],
      ['diet:vegan', 5 * 60],
      ['staff', 4 * 5 * 450], // 80 hostů / 25 = 4 číšníci, výchozích 5 h
      ['extra:napoje_alko', 80 * 220],
      ['delivery', 15 * 2 * 28], // 35 km − 20 v ceně, tam i zpět
    ])
    expect(q.subtotal).toBe(74_940)
    expect(q.vat).toBe(8_993)
    expect(q.total).toBe(83_933)
    expect(q.mapVersion).toBe(CFG.priceMap.version)
    expect(q.validUntil).toBe('2026-11-19') // 14 dní
  })

  test('víkend přidá příplatek z ceny jídla', () => {
    const r = run({ eventDate: '2026-12-05' }) // sobota
    if (r.kind !== 'standard') throw new Error(r.kind)
    expect(r.quote.lines.find((l) => l.key === 'weekend')?.total).toBe(Math.round(80 * 590 * 0.1))
  })

  test('balíček bez obsluhy nepočítá personál; doprava do 20 km je v ceně', () => {
    const r = run({ segment: 'b2c', eventType: 'rozvoz', guests: 30, distanceKm: 12, extras: [], dietary: [] })
    if (r.kind !== 'standard') throw new Error(r.kind)
    expect(r.quote.lines.map((l) => l.key)).toEqual(['package:rozvoz_box'])
    expect(r.quote.subtotal).toBe(30 * 390)
  })

  test('obsluha: nejméně minHours, delší akce se zaokrouhlí nahoru', () => {
    const short = run({ durationHours: 2 })
    const long = run({ durationHours: 6.5 })
    if (short.kind !== 'standard' || long.kind !== 'standard') throw new Error('kind')
    expect(short.quote.lines.find((l) => l.key === 'staff')?.quantity).toBe(4 * 4)
    expect(long.quote.lines.find((l) => l.key === 'staff')?.quantity).toBe(4 * 7)
  })

  test('platnost nabídky nepřesáhne den před akcí', () => {
    const r = run({ eventDate: '2026-11-12' }) // za 7 dní
    if (r.kind !== 'standard') throw new Error(r.kind)
    expect(r.quote.validUntil).toBe('2026-11-11')
  })

  test('výpočet je deterministický', () => {
    expect(run()).toEqual(run())
  })
})

describe('doptání chybějících údajů', () => {
  test('chybí počet hostů a místo → needs_info, nic se nenabízí', () => {
    const r = run({ guests: null, distanceKm: null })
    expect(r).toEqual({ kind: 'needs_info', missing: ['guests', 'distanceKm'] })
  })

  test('neplatné datum se doptá, nehádá', () => {
    expect(run({ eventDate: '2026-02-30' })).toEqual({ kind: 'needs_info', missing: ['eventDate'] })
  })

  test('text doptání obsahuje jen otázky na chybějící údaje', () => {
    const t = renderInfoRequest(['guests', 'eventDate'], { signature: CFG.signature })
    expect(t).toContain('Kolik hostů')
    expect(t).toContain('Na jaký den')
    expect(t).not.toContain('Kč')
  })
})

describe('eskalace mimo mapu', () => {
  test.each<[string, Partial<OfferInquiryInput>, string]>([
    ['neznámý segment', { segment: 'statni_sprava' }, 'unknown_segment'],
    ['typ akce mimo segment', { eventType: 'svatba' }, 'unknown_event_type'],
    ['balíček mimo typ akce', { packageKey: 'svatebni_menu' }, 'non_standard_package'],
    ['příliš mnoho hostů', { guests: 500 }, 'guests_out_of_range'],
    ['termín v minulosti', { eventDate: '2026-11-01' }, 'date_in_past'],
    ['krátký předstih', { eventDate: '2026-11-07' }, 'date_too_soon'],
    ['příliš daleko dopředu', { eventDate: '2028-01-10' }, 'date_too_far'],
    ['daleko od provozovny', { distanceKm: 300 }, 'distance_over_limit'],
    ['neznámý doplněk', { extras: ['ohnostroj'] }, 'unknown_extra'],
    ['nepodporovaná dieta', { dietary: [{ key: 'kosher', guests: 10 }] }, 'unsupported_diet'],
    ['víc diet než hostů', { dietary: [{ key: 'vegan', guests: 90 }] }, 'dietary_exceeds_guests'],
    ['zvláštní přání', { specialRequests: 'Chceme sushi bar a vlastní víno.' }, 'special_request'],
    ['VIP kontakt', { vipContact: true }, 'vip_contact'],
  ])('%s', (_name, over, code) => {
    expect(codes(run(over))).toContain(code)
  })

  test('nad limitem pro samostatné odeslání: eskalace s konceptem pro CSO', () => {
    const r = run({ eventType: 'raut', packageKey: 'raut_premium', guests: 200, extras: ['napoje_alko', 'barman'] })
    expect(codes(r)).toEqual(['over_auto_send_limit'])
    if (r.kind === 'escalate') expect(r.draft?.subtotal).toBeGreaterThan(CFG.priceMap.autoSendMaxTotal)
  })

  test('propadlá mapa: agent sám nic nespočítá', () => {
    expect(codes(run({}, '2027-07-01'))).toContain('map_expired')
  })

  test('výjimka má přednost před doptáním a nese i chybějící údaje', () => {
    const r = run({ guests: null, specialRequests: 'raut bez masa a ryb' })
    expect(r.kind).toBe('escalate')
    if (r.kind === 'escalate') {
      expect(r.missing).toEqual(['guests'])
      expect(r.draft).toBeNull()
    }
  })

  test('neplatný vstup od modelu (záporní hosté) schéma odmítne', () => {
    expect(() => run({ guests: -5 })).toThrow()
  })
})

describe('text nabídky', () => {
  test('obsahuje jen spočítané částky, termín a platnost', () => {
    const r = run()
    if (r.kind !== 'standard') throw new Error(r.kind)
    const { subject, body } = renderOfferEmail(r.quote, { companyName: FIXTURE_COMPANY_NAME, signature: CFG.signature, customerName: 'paní Nováková' })
    expect(subject).toContain('3. 12. 2026')
    expect(subject).toContain('80 hostů')
    expect(body).toContain('Dobrý den, paní Nováková,')
    expect(body).toMatch(/Celkem s DPH: 83\s933 Kč/)
    expect(body).toContain('Kalkulace je nezávazná a platí do 19. 11. 2026')
    for (const i of r.quote.package.includes) expect(body).toContain(i)
  })
})

describe('kontrola mapy', () => {
  test('mapa pilotní firmy nemá vnitřní rozpory', () => {
    expect(priceMapProblems(CFG.priceMap)).toEqual([])
  })

  test('odhalí výchozí balíček mimo seznam a neznámý balíček', () => {
    const broken: PriceMapConfig = {
      ...CFG.priceMap,
      segments: [{ key: 'b2b', label: 'B2B', eventTypes: [{ key: 'raut', label: 'Raut', packages: ['neexistuje'], defaultPackage: 'raut_standard' }] }],
    }
    expect(priceMapProblems(broken)).toEqual([
      'výchozí balíček b2b.raut není mezi balíčky typu',
      'typ b2b.raut odkazuje na neznámý balíček neexistuje',
    ])
  })
})
