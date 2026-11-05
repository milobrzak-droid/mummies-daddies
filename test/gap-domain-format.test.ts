import { describe, expect, test } from 'vitest'
import {
  dealMargin, dealStageLabel, defaultProbabilityForStage, isPillar, phaseIndex, phaseLabel,
  phasesFor, pillarLabel, pillarSub, roleLabel, seesByznys, stageForPhase, teamLabel,
} from '@/lib/domain'
import { formatCzk, formatCzkShort, formatDate, formatPct, formatPp } from '@/lib/format'
import { shouldFreezeRate } from '@/domain/finance/fx'

describe('stageForPhase', () => {
  test('poptávka maps to kvalifikace in b2b_akce and cheesecaky', () => {
    expect(stageForPhase('b2b_akce', 'poptavka')).toBe('kvalifikace')
    expect(stageForPhase('cheesecaky', 'poptavka')).toBe('kvalifikace')
  })
  test('delivery phases are won', () => {
    for (const pillar of ['b2b_akce', 'b2c_oslavy', 'cheesecaky']) {
      for (const p of ['potvrzeno', 'realizovano']) expect(stageForPhase(pillar, p)).toBe('vyhráno')
    }
  })
  test('pre-delivery non-poptávka phases are rozsah_nabidka', () => {
    expect(stageForPhase('b2b_akce', 'nabidka')).toBe('rozsah_nabidka')
    expect(stageForPhase('b2c_oslavy', 'nabidka')).toBe('rozsah_nabidka')
    expect(stageForPhase('cheesecaky', 'nabidka')).toBe('rozsah_nabidka')
  })
  test('invalid pillar or empty phase yields null', () => {
    expect(stageForPhase(null, 'poptavka')).toBeNull()
    expect(stageForPhase('Firemní akce', 'potvrzeno')).toBeNull()
    expect(stageForPhase('cheesecaky', '')).toBeNull()
    expect(stageForPhase('cheesecaky', null)).toBeNull()
  })
  test('phase from another pillar returns null', () => {
    // Fáze, kterou pilíř nemá → null (nevíme, co znamená).
    expect(stageForPhase('b2b_akce', 'provoz')).toBeNull()
    expect(stageForPhase('b2c_oslavy', 'workshopy')).toBeNull()
    expect(stageForPhase('cheesecaky', 'poptavka')).toBe('kvalifikace')
  })
})

describe('phase and label helpers', () => {
  test('phasesFor / phaseIndex / phaseLabel', () => {
    expect(phasesFor('cheesecaky')).toHaveLength(4)
    expect(phasesFor('xyz')).toEqual([])
    expect(phaseIndex('cheesecaky', 'realizovano')).toBe(3)
    expect(phaseIndex('cheesecaky', 'report')).toBe(-1)
    expect(phaseIndex(null, 'report')).toBe(-1)
    expect(phaseLabel('b2b_akce', 'potvrzeno')).toBe('Potvrzeno')
    expect(phaseLabel('b2b_akce', 'neznama')).toBe('neznama')
    expect(phaseLabel('b2b_akce', null)).toBe('—')
  })
  test('isPillar is strict', () => {
    expect(isPillar('b2c_oslavy')).toBe(true)
    expect(isPillar('LAUNCHPAD')).toBe(false)
    expect(isPillar(undefined)).toBe(false)
  })
  test('labels fall back sensibly', () => {
    expect(pillarLabel('cheesecaky')).toBe('Cheesecaky')
    expect(pillarLabel('nope')).toBe('—')
    expect(pillarSub('b2b_akce')).toBe('B2B')
    expect(pillarSub(null)).toBe('')
    expect(teamLabel('kuchyne')).toBe('Kuchyně')
    expect(teamLabel('')).toBe('—')
    expect(roleLabel('supplier')).toBe('Dodavatel')
    expect(roleLabel('unknown')).toBe('unknown')
    expect(dealStageLabel('diagnostika')).toBe('Upřesnění')
    expect(dealStageLabel('rozsah_nabidka')).toBe('Nabídka odeslána')
    expect(dealStageLabel('rozhodovani')).toBe('Zákazník rozhoduje')
    expect(dealStageLabel('xx')).toBe('xx')
    expect(dealStageLabel(null)).toBe('—')
  })
  test('diacritics in stage keys must match exactly', () => {
    expect(defaultProbabilityForStage('rozhodovani')).toBe(75)
    expect(defaultProbabilityForStage('rozhodování')).toBe(0)
    expect(defaultProbabilityForStage('vyhrano')).toBe(0)
    expect(defaultProbabilityForStage(undefined)).toBe(0)
  })
  test('seesByznys only for vedení and obchodník', () => {
    expect(seesByznys('vedeni')).toBe(true)
    expect(seesByznys('obchodnik')).toBe(true)
    expect(seesByznys('lektor')).toBe(false)
    expect(seesByznys(null)).toBe(false)
  })
})

describe('dealMargin edges', () => {
  test('negative margin and rounding', () => {
    expect(dealMargin(1000, 1500)).toEqual({ czk: -500, pct: -50 })
    expect(dealMargin('3', '2')).toEqual({ czk: 1, pct: 33 })
    expect(dealMargin(200, 199)).toEqual({ czk: 1, pct: 1 })
  })
  test('zero amount, NaN and nulls return null', () => {
    expect(dealMargin(0, 0)).toBeNull()
    expect(dealMargin('abc', 1)).toBeNull()
    expect(dealMargin(100, undefined)).toBeNull()
  })
  test('empty-string cogs is treated as zero cost', () => {
    // '' / mezery z formuláře = náklady nevyplněné → null.
    expect(dealMargin(1000, '')).toBeNull()
    expect(dealMargin(1000, '  ')).toBeNull()
    expect(dealMargin('', 100)).toBeNull()
  })
})

describe('format edges', () => {
  test('formatCzk rounds and handles negatives', () => {
    expect(formatCzk(1234.5)).toMatch(/^1 23[45] Kč$/)
    expect(formatCzk(-5000)).toBe('-5 000 Kč')
    expect(formatCzk('abc')).toBe('—')
  })
  test('whitespace string formats as zero', () => {
    expect(formatCzk('  ')).toBe('—')
  })
  test('formatPct / formatPp keep decimals as given', () => {
    expect(formatPct('12.50')).toBe('12.5 %')
    expect(formatPct(0)).toBe('0 %')
    expect(formatPp('x')).toBe('—')
    expect(formatPp(-3)).toBe('-3 pp')
  })
  test('formatDate for date-only and invalid strings', () => {
    expect(formatDate('2026-02-28')).toMatch(/28\. ?2\. ?2026/)
    expect(formatDate('not a date')).toBe('—')
    expect(formatDate('')).toBe('—')
  })
  test('formatCzkShort thresholds', () => {
    expect(formatCzkShort(1_000_000)).toBe('1,00 mil. Kč')
    expect(formatCzkShort(10_000_000)).toBe('10 mil. Kč')
    expect(formatCzkShort(-2_500_000)).toBe('-2,50 mil. Kč')
    expect(formatCzkShort(100_000)).toBe('100 tis. Kč')
    expect(formatCzkShort(-150_400)).toBe('-150 tis. Kč')
    expect(formatCzkShort(99_999)).toBe('99 999 Kč')
  })
  test('rounding just below thresholds', () => {
    // Jednotka se volí po zaokrouhlení → stejný tvar jako přesné 1 000 000 / 10 000 000.
    expect(formatCzkShort(999_999)).toBe(formatCzkShort(1_000_000))
    expect(formatCzkShort(999_999)).toBe('1,00 mil. Kč')
    expect(formatCzkShort(9_999_999)).toBe(formatCzkShort(10_000_000))
    expect(formatCzkShort(9_999_999)).toBe('10 mil. Kč')
    expect(formatCzkShort(-999_999)).toBe('-1,00 mil. Kč')
    expect(formatCzkShort(999_499)).toBe('999 tis. Kč')
  })
})

describe('shouldFreezeRate edges', () => {
  const closed = (amount: number | string | null) => ({ stage: 'vyhráno', currency: 'EUR', amount_one_time_original: amount })
  test('odloženo is not frozen', () => {
    expect(shouldFreezeRate({ stage: 'odloženo', currency: 'EUR', amount_one_time_original: 5 }, { currency: 'EUR', amount_one_time_original: 5 })).toBe(false)
  })
  test('null to null stays frozen', () => {
    expect(shouldFreezeRate(closed(null), { currency: 'EUR', amount_one_time_original: null })).toBe(true)
  })
  test('null vs 0 counts as unchanged', () => {
    // null a 0 jsou různé: nově zadaná 0 je změna.
    expect(shouldFreezeRate(closed(null), { currency: 'EUR', amount_one_time_original: 0 })).toBe(false)
    expect(shouldFreezeRate(closed(0), { currency: 'EUR', amount_one_time_original: null })).toBe(false)
    expect(shouldFreezeRate(closed(null), { currency: 'EUR', amount_one_time_original: null })).toBe(true)
  })
  test('decimal string equality', () => {
    expect(shouldFreezeRate(closed('1000.50'), { currency: 'EUR', amount_one_time_original: 1000.5 })).toBe(true)
    expect(shouldFreezeRate(closed('1000.50'), { currency: 'EUR', amount_one_time_original: 1000.51 })).toBe(false)
  })
})
