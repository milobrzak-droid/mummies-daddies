// Kap. 6 / 0061: dopad dodávky, souhlas s referencí, vlastnictví.
// Statická shoda SQL ↔ TS (měna, realizační týmy) + čistá logika.
import { readFileSync } from 'node:fs'
import { describe, expect, test } from 'vitest'
import { COMPANY } from '@/config'
import {
  CURRENCY_PATTERN,
  containsCurrency,
  formatDelta,
  impactDelta,
  metricObservationSchema,
  ownershipSchema,
  referenceConsentOk,
  referenceConsentSchema,
} from '@/domain/delivery/impact'

const raw = readFileSync('supabase/migrations/0061_delivery_impact.sql', 'utf8')
const sql = raw.replace(/--[^\n]*/g, '')

describe('0061 ↔ TS', () => {
  test('CHECK proti měně používá stejný vzor jako CURRENCY_PATTERN (jednotka i metrika)', () => {
    const occurrences = sql.split(`!~ '${CURRENCY_PATTERN}'`).length - 1
    expect(occurrences).toBe(2)
  })
  test('engagement_delivery_team_check = COMPANY.deliveryTeams', () => {
    const m = /engagement_delivery_team_check\s+CHECK \(delivery_team IS NULL OR delivery_team IN \(([^)]*)\)\)/.exec(sql)
    expect(m).not.toBeNull()
    const keys = m![1].split(',').map((k) => k.trim().replace(/'/g, ''))
    expect(keys).toEqual(COMPANY.deliveryTeams.map((t) => t.key))
  })
  test('souhlas s referencí: CHECK vyžaduje doklad i datum', () => {
    expect(sql).toMatch(/CHECK \(NOT approved_public OR \(consent_evidence_id IS NOT NULL AND consent_at IS NOT NULL\)\)/)
  })
  test('RLS: team + RESTRICTIVE AAL2 a zápis do ledgeru', () => {
    expect(sql).toMatch(/ALTER TABLE metric_observation ENABLE ROW LEVEL SECURITY/)
    expect(sql).toMatch(/CREATE POLICY require_aal2 ON metric_observation\s+AS RESTRICTIVE/)
    expect(sql).toMatch(/VALUES \('0061'/)
  })
})

describe('containsCurrency', () => {
  test.each(['CZK', 'Kč', 'tis. Kč', 'EUR/měsíc', '€', '$', 'korun', 'úspora v czk'])('odmítne „%s"', (t) => {
    expect(containsCurrency(t)).toBe(true)
  })
  test.each(['min', '%', 'ks', 'tikety/týden', 'europoslanci', 'Kčeření', null, ''])('pustí „%s"', (t) => {
    expect(containsCurrency(t)).toBe(false)
  })
})

describe('metricObservationSchema', () => {
  const base = { metric: 'Doba zpracování', unit: 'min', baseline: '12,5', actual: '', observed_on: '2026-09-01', note: '', document_id: '' }
  test('platné měření, čárka jako desetinný oddělovač', () => {
    const r = metricObservationSchema.parse(base)
    expect(r).toMatchObject({ baseline: 12.5, actual: null, unit: 'min', note: null, document_id: null })
  })
  test('prázdné měření neprojde', () => {
    const r = metricObservationSchema.safeParse({ ...base, baseline: '' })
    expect(r.success).toBe(false)
  })
  test('měna v jednotce ani v metrice neprojde', () => {
    expect(metricObservationSchema.safeParse({ ...base, unit: 'Kč' }).success).toBe(false)
    expect(metricObservationSchema.safeParse({ ...base, metric: 'Úspora EUR' }).success).toBe(false)
  })
  test('nečíselná hodnota neprojde', () => {
    expect(metricObservationSchema.safeParse({ ...base, actual: 'hodně' }).success).toBe(false)
  })
})

describe('impactDelta / formatDelta', () => {
  test('rozdíl a procenta', () => {
    expect(impactDelta(20, 15)).toEqual({ abs: -5, pct: -25 })
    expect(impactDelta(0, 3)).toEqual({ abs: 3, pct: null })
    expect(impactDelta(null, 3)).toBeNull()
  })
  test('formát', () => {
    expect(formatDelta(null, 'min')).toBe('—')
    expect(formatDelta({ abs: -5, pct: -25 }, 'min')).toBe('−5 min (−25 %)')
    expect(formatDelta({ abs: 3, pct: null }, null)).toBe('+3')
  })
})

describe('ownershipSchema', () => {
  const a = '11111111-1111-4111-8111-111111111111'
  const b = '22222222-2222-4222-8222-222222222222'
  test('vlastník, zástupce, tým', () => {
    expect(ownershipSchema.parse({ owner_id: a, deputy_id: b, delivery_team: 'cukrarna' })).toEqual({ owner_id: a, deputy_id: b, delivery_team: 'cukrarna' })
  })
  test('prázdné = null', () => {
    expect(ownershipSchema.parse({ owner_id: '', deputy_id: '', delivery_team: '' })).toEqual({ owner_id: null, deputy_id: null, delivery_team: null })
  })
  test('zástupce ≠ vlastník, zástupce bez vlastníka, neznámý tým', () => {
    expect(ownershipSchema.safeParse({ owner_id: a, deputy_id: a, delivery_team: '' }).success).toBe(false)
    expect(ownershipSchema.safeParse({ owner_id: '', deputy_id: b, delivery_team: '' }).success).toBe(false)
    expect(ownershipSchema.safeParse({ owner_id: a, deputy_id: '', delivery_team: 'mars' }).success).toBe(false)
  })
})

describe('souhlas s referencí', () => {
  test('schema vyžaduje doklad', () => {
    expect(referenceConsentSchema.safeParse({ consent_on: '2026-09-01', document_id: '' }).success).toBe(false)
    expect(referenceConsentSchema.safeParse({ consent_on: '2026-09-01', document_id: '5' }).success).toBe(true)
    expect(referenceConsentSchema.safeParse({ consent_on: '2026-09-01', new_title: 'Souhlas', new_url: 'https://evil.example.com/x' }).success).toBe(false)
    expect(referenceConsentSchema.safeParse({ consent_on: '2026-09-01', new_title: 'Souhlas', new_url: 'https://mummiesdaddies.sharepoint.com/x' }).success).toBe(true)
  })
  test('referenceConsentOk zrcadlí CHECK', () => {
    expect(referenceConsentOk({ approved_public: false })).toBe(true)
    expect(referenceConsentOk({ approved_public: true, consent_evidence_id: null, consent_at: null })).toBe(false)
    expect(referenceConsentOk({ approved_public: true, consent_evidence_id: 1, consent_at: '2026-09-01' })).toBe(true)
  })
})
