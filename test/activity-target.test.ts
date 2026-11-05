import { expect, test } from 'vitest'
import { salesActivitySchema } from '@/lib/validation/schemas'

const base = {
  kind: 'call',
  subject: 'Telefonát',
  occurred_at: '2026-09-03T10:00',
}

test('an activity on a client is accepted', () => {
  expect(salesActivitySchema.safeParse({ ...base, account_id: '23' }).success).toBe(true)
})

test('an activity on a partner is accepted', () => {
  // Hovor s BETA TRADEem nebo TAUPARTNERem — přes ně chodí většina obchodů.
  expect(salesActivitySchema.safeParse({ ...base, partner_id: '2' }).success).toBe(true)
})

test('an activity on both at once is refused', () => {
  const r = salesActivitySchema.safeParse({ ...base, account_id: '23', partner_id: '2' })
  expect(r.success).toBe(false)
})

test('an activity on neither is refused', () => {
  // Bez toho by aktivita spadla do prázdna a nikde by se nezobrazila.
  expect(salesActivitySchema.safeParse(base).success).toBe(false)
})

test('the subject stays required', () => {
  expect(salesActivitySchema.safeParse({ ...base, subject: '', account_id: '23' }).success).toBe(false)
})
