import { expect, test } from 'vitest'
import { wouldCreateDirectCycle } from '@/domain/crm/queries/companyRelationships'

test('no existing relationships means no cycle', () => {
  expect(wouldCreateDirectCycle([], { parent_account_id: 1, child_account_id: 2 })).toBe(false)
})

test('an unrelated existing relationship does not block a new one', () => {
  const existing = [{ parent_account_id: 3, child_account_id: 4 }]
  expect(wouldCreateDirectCycle(existing, { parent_account_id: 1, child_account_id: 2 })).toBe(false)
})

test('the same direction already existing is not itself a cycle (caught by the DB unique index instead)', () => {
  const existing = [{ parent_account_id: 1, child_account_id: 2 }]
  expect(wouldCreateDirectCycle(existing, { parent_account_id: 1, child_account_id: 2 })).toBe(false)
})

test('the reverse direction already existing is a direct A→B→A cycle', () => {
  const existing = [{ parent_account_id: 2, child_account_id: 1 }]
  expect(wouldCreateDirectCycle(existing, { parent_account_id: 1, child_account_id: 2 })).toBe(true)
})

test('detects the reverse pair among several unrelated relationships', () => {
  const existing = [
    { parent_account_id: 5, child_account_id: 6 },
    { parent_account_id: 2, child_account_id: 1 },
    { parent_account_id: 7, child_account_id: 8 },
  ]
  expect(wouldCreateDirectCycle(existing, { parent_account_id: 1, child_account_id: 2 })).toBe(true)
})
