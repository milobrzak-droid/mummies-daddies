// Čisté agregační funkce dashboardu + kontrola, že SQL pohledy (0046) a TS
// fallback mají zdokumentovanou stejnou sémantiku (měsíc, měna).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test, vi } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

import {
  bucketContractedByMonth, deriveImpactSummary, isMissingRelation, sumImpact,
  type EngagementImpactRow,
} from '@/lib/queries/dashboard'

const ROOT = join(__dirname, '..')
const SQL = readFileSync(join(ROOT, 'supabase/migrations/0046_dashboard_aggregates.sql'), 'utf8')
const TS = readFileSync(join(ROOT, 'lib/queries/dashboard.ts'), 'utf8')

describe('bucketContractedByMonth', () => {
  test('seskupí podle YYYY-MM z DATE, seřadí, NULL částka = 0, bez won_at přeskočí', () => {
    expect(bucketContractedByMonth([
      { won_at: '2026-03-31', amount_one_time: '1000.50' },
      { won_at: '2026-01-01', amount_one_time: 200 },
      { won_at: '2026-03-01', amount_one_time: null },
      { won_at: '2026-03-15', amount_one_time: 499.5 },
      { won_at: null, amount_one_time: 999 },
    ])).toEqual([
      { month: '2026-01', amount: 200 },
      { month: '2026-03', amount: 1500 },
    ])
  })
  test('poslední den měsíce zůstává v tom měsíci (žádný posun zóny)', () => {
    expect(bucketContractedByMonth([{ won_at: '2025-12-31', amount_one_time: 1 }]))
      .toEqual([{ month: '2025-12', amount: 1 }])
  })
  test('prázdný vstup', () => expect(bucketContractedByMonth([])).toEqual([]))
})

describe('impact', () => {
  const row = (p: Partial<EngagementImpactRow>): EngagementImpactRow => ({
    post_adoption_pct: null, post_captured_on: null, trained_count: null,
    time_saved_min_week: null, roi_czk_year: null, reference_worthy: false, ...p,
  })
  test('součty a odvozené hodnoty', () => {
    const rows = [
      row({ post_adoption_pct: '78', trained_count: 82, time_saved_min_week: 40, roi_czk_year: '100000.00', reference_worthy: true }),
      row({ post_captured_on: '2026-01-02', time_saved_min_week: 50 }),
      row({}),
    ]
    const t = sumImpact(rows)
    expect(t).toEqual({ engagementsTotal: 3, withAudit: 2, trainedTotal: 82, minutesPerWeek: 90, roiTotal: 100000, referenceCount: 1 })
    expect(deriveImpactSummary(t)).toEqual({
      proofRatePct: 67, engagementsTotal: 3, withAudit: 2, trainedTotal: 82,
      hoursPerWeek: 2, roiTotal: 100000, referenceCount: 1,
    })
  })
  test('prázdno → nuly', () => {
    expect(deriveImpactSummary(sumImpact([]))).toMatchObject({ proofRatePct: 0, hoursPerWeek: 0, engagementsTotal: 0 })
  })
})

test('isMissingRelation', () => {
  expect(isMissingRelation({ code: '42P01' })).toBe(true)
  expect(isMissingRelation({ code: 'PGRST205' })).toBe(true)
  expect(isMissingRelation({ code: '42501' })).toBe(false)
  expect(isMissingRelation(null)).toBe(false)
})

describe('SQL a TS mají stejnou zdokumentovanou sémantiku', () => {
  test('měsíc: to_char(won_at, YYYY-MM) ⇔ won_at.slice(0, 7), DATE bez zóny', () => {
    expect(SQL).toMatch(/to_char\(won_at, 'YYYY-MM'\)/)
    expect(SQL).toContain('won_at.slice(0, 7)')
    expect(TS).toContain("to_char(won_at, 'YYYY-MM')")
    expect(TS).toContain('won_at.slice(0, 7)')
    for (const src of [SQL, TS]) {
      expect(src).toMatch(/DATE/)
      expect(src).toMatch(/Europe\/Prague/)
    }
  })
  test('měna: vždy Kč, žádný FX převod (0016)', () => {
    for (const src of [SQL, TS]) {
      expect(src).toMatch(/Kč/)
      expect(src).toMatch(/FX/)
      expect(src).toContain('0016')
    }
  })
  test('stage vyhráno, security_invoker, fallback kódy', () => {
    expect(SQL).toContain("stage = 'vyhráno'")
    expect(SQL.match(/security_invoker = on/g)?.length).toBeGreaterThanOrEqual(4)
    for (const src of [SQL, TS]) { expect(src).toContain('42P01'); expect(src).toContain('PGRST205') }
  })
})
