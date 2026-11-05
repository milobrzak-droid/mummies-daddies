import { expect, test } from 'vitest'
import { dealMargin } from '@/lib/domain'

test('computes margin in Kč and percent from amount and cogs', () => {
  const m = dealMargin(1000000, 200000)
  expect(m).toEqual({ czk: 800000, pct: 80 })
})

test('rounds the percent to the nearest whole number', () => {
  const m = dealMargin(300000, 100000)
  expect(m?.pct).toBe(67)
})

test('returns null when cogs is missing (not yet filled in)', () => {
  expect(dealMargin(1000000, null)).toBeNull()
  expect(dealMargin(1000000, undefined)).toBeNull()
})

test('returns null when amount is missing', () => {
  expect(dealMargin(null, 100000)).toBeNull()
})

test('returns null when amount is zero (avoids divide-by-zero)', () => {
  expect(dealMargin(0, 0)).toBeNull()
})

test('handles string-typed numeric values (as PostgREST returns them)', () => {
  const m = dealMargin('500000', '100000')
  expect(m).toEqual({ czk: 400000, pct: 80 })
})

test('a negative margin (cogs exceeds amount) is reported, not clamped', () => {
  const m = dealMargin(100000, 150000)
  expect(m).toEqual({ czk: -50000, pct: -50 })
})
