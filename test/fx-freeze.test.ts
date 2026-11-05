import { expect, test } from 'vitest'
import { shouldFreezeRate } from '@/domain/finance/fx'

const won = { stage: 'vyhráno', currency: 'EUR', amount_one_time_original: 70000 }
const open = { stage: 'rozsah_nabidka', currency: 'EUR', amount_one_time_original: 70000 }
const same = { currency: 'EUR', amount_one_time_original: 70000 }

test('a closed deal keeps the rate it was closed at', () => {
  // Úprava poznámky u vyhraného obchodu nesmí posunout vykázanou tržbu.
  expect(shouldFreezeRate(won, same)).toBe(true)
})

test('a lost deal is frozen too', () => {
  expect(shouldFreezeRate({ ...won, stage: 'prohráno' }, same)).toBe(true)
})

test('an open deal is repriced at the current rate', () => {
  expect(shouldFreezeRate(open, same)).toBe(false)
})

test('changing the euro amount reprices even a closed deal', () => {
  // Když někdo částku opravdu mění, chce nový přepočet.
  expect(shouldFreezeRate(won, { currency: 'EUR', amount_one_time_original: 80000 })).toBe(false)
})

test('switching currency reprices', () => {
  expect(shouldFreezeRate(won, { currency: 'CZK', amount_one_time_original: 70000 })).toBe(false)
})

test('a new deal has nothing to freeze', () => {
  expect(shouldFreezeRate(null, same)).toBe(false)
})

test('string amounts from PostgREST compare correctly', () => {
  // PostgREST vrací numeric jako řetězec — porovnání musí projít.
  expect(shouldFreezeRate({ ...won, amount_one_time_original: '70000' }, same)).toBe(true)
})

test('both amounts missing counts as unchanged (still frozen)', () => {
  expect(
    shouldFreezeRate(
      { ...won, amount_one_time_original: null },
      { currency: 'EUR', amount_one_time_original: null },
    ),
  ).toBe(true)
})

test('newly entering an amount where there was none reprices', () => {
  expect(
    shouldFreezeRate(
      { ...won, amount_one_time_original: null },
      { currency: 'EUR', amount_one_time_original: 70000 },
    ),
  ).toBe(false)
})

test('clearing a previously set amount reprices', () => {
  expect(
    shouldFreezeRate(won, { currency: 'EUR', amount_one_time_original: null }),
  ).toBe(false)
})
