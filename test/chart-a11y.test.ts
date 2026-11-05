import { describe, it, expect } from 'vitest'
import { summarizeSeries, describeDelta, formatNumber, formatCzkValue } from '@/components/Sparkline'
import { summarizeArea } from '@/components/AreaChart'
import { summarizeBars } from '@/components/BarChart'

describe('summarizeSeries', () => {
  it('formats range, trend, min and max in CZK', () => {
    expect(summarizeSeries([120_000, 90_000, 480_000], 'Nasmlouváno', formatCzkValue)).toBe(
      'Nasmlouváno: počet hodnot 3, od 120 tis. Kč do 480 tis. Kč (rostoucí), minimum 90 000 Kč, maximum 480 tis. Kč',
    )
  })
  it('handles empty and single point', () => {
    expect(summarizeSeries([], 'X')).toBe('X: žádná data')
    expect(summarizeSeries([NaN])).toBe('žádná data')
    expect(summarizeSeries([5], 'X')).toBe('X: jediná hodnota 5')
  })
  it('handles negative values and falling trend', () => {
    expect(summarizeSeries([3, -2.5, -10])).toBe('počet hodnot 3, od 3 do -10 (klesající), minimum -10, maximum 3')
    expect(summarizeSeries([1, 1])).toContain('beze změny')
  })
  it('formatNumber uses Czech decimals and plain spaces', () => {
    expect(formatNumber(1234.5)).toBe('1 234,5')
  })
})

describe('describeDelta', () => {
  it('puts direction into words', () => {
    expect(describeDelta('+12 %')).toBe('nárůst o 12 %')
    expect(describeDelta('-3')).toBe('pokles o 3')
    expect(describeDelta('−5 pp')).toBe('pokles o 5 pp')
    expect(describeDelta('0 %')).toBe('beze změny (0 %)')
    expect(describeDelta('+0')).toBe('beze změny (+0)')
    expect(describeDelta('nové')).toBe('změna nové')
    expect(describeDelta(undefined)).toBe('')
  })
})

describe('chart summaries', () => {
  it('area: period + per-series summaries, empty', () => {
    expect(summarizeArea(['led', 'úno'], [{ name: 'A', color: '#000', values: [1, 2] }], 'Tržby')).toBe(
      'Tržby (led – úno). A: počet hodnot 2, od 1 do 2 (rostoucí), minimum 1, maximum 2',
    )
    expect(summarizeArea([], [], 'Tržby')).toBe('Tržby: žádná data')
  })
  it('bars: highest/lowest, single, empty, negative', () => {
    expect(summarizeBars([{ label: 'A', value: -4 }, { label: 'B', value: 7 }], 'Cap')).toBe(
      'Cap: počet položek 2, nejvyšší B 7, nejnižší A -4',
    )
    expect(summarizeBars([{ label: 'A', value: 1 }])).toBe('Sloupcový graf: A 1')
    expect(summarizeBars([], 'Cap')).toBe('Cap: žádná data')
  })
})
