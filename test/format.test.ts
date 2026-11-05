import { expect, test } from 'vitest'
import { formatCzk, formatCzkShort, formatPct, formatDate, formatPp } from '@/lib/format'

test('formatCzk formats whole CZK with thousands separators', () => {
  expect(formatCzk(11000000)).toBe('11 000 000 Kč')
})
test('formatCzk handles null', () => {
  expect(formatCzk(null)).toBe('—')
})
test('formatPct appends percent', () => {
  expect(formatPct(78)).toBe('78 %')
})
test('formatPct handles null', () => {
  expect(formatPct(null)).toBe('—')
})
test('formatDate renders cs locale or dash', () => {
  expect(formatDate('2026-05-01')).toBe('1. 5. 2026')
  expect(formatDate(null)).toBe('—')
})
test('formatPp drops trailing decimals from a numeric string', () => {
  expect(formatPp('61.00')).toBe('61 pp')
  expect(formatPp('61.50')).toBe('61.5 pp')
  expect(formatPp(70)).toBe('70 pp')
  expect(formatPp(null)).toBe('—')
})

test('formatCzkShort compacts millions', () => {
  expect(formatCzkShort(4364300)).toBe('4,36 mil. Kč')
  expect(formatCzkShort(12500000)).toBe('13 mil. Kč')
})
test('formatCzkShort compacts hundreds of thousands', () => {
  expect(formatCzkShort(621000)).toBe('621 tis. Kč')
})
test('formatCzkShort leaves small amounts alone', () => {
  expect(formatCzkShort(25000)).toBe('25 000 Kč')
})
test('formatCzkShort handles empty values', () => {
  expect(formatCzkShort(null)).toBe('—')
  expect(formatCzkShort(0)).toBe('0 Kč')
})
