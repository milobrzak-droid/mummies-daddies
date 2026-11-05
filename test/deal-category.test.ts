import { expect, test } from 'vitest'
import { categoryForLine } from '@/lib/validation/schemas'

test('every revenue line maps to a category', () => {
  // one_time lines
  expect(categoryForLine.catering_firemni).toBe('one_time')
  expect(categoryForLine.oslava_soukroma).toBe('one_time')
  expect(categoryForLine.svatebni_hostina).toBe('one_time')
  expect(categoryForLine.cheesecaky_eshop).toBe('one_time')
  expect(categoryForLine.pronajem_prostor).toBe('one_time')
  // recurring / royalty
  expect(categoryForLine.firemni_pravidelny).toBe('recurring')
  expect(categoryForLine.provize).toBe('royalty')
})
