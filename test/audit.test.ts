import { expect, test } from 'vitest'
import { dealAuditDiff } from '@/core/audit'

const base = { amount_one_time: 580000, stage: 'rozsah_nabidka' }

test('amount changed only produces one deal.amount_changed entry', () => {
  const diffs = dealAuditDiff(base, { amount_one_time: 620000, stage: 'rozsah_nabidka' })
  expect(diffs).toEqual([
    { action: 'deal.amount_changed', before: { amount_one_time: 580000 }, after: { amount_one_time: 620000 } },
  ])
})

test('stage changed only produces one deal.stage_changed entry', () => {
  const diffs = dealAuditDiff(base, { amount_one_time: 580000, stage: 'vyhráno' })
  expect(diffs).toEqual([
    { action: 'deal.stage_changed', before: { stage: 'rozsah_nabidka' }, after: { stage: 'vyhráno' } },
  ])
})

test('both amount and stage changed produce both entries', () => {
  const diffs = dealAuditDiff(base, { amount_one_time: 620000, stage: 'vyhráno' })
  expect(diffs).toEqual([
    { action: 'deal.amount_changed', before: { amount_one_time: 580000 }, after: { amount_one_time: 620000 } },
    { action: 'deal.stage_changed', before: { stage: 'rozsah_nabidka' }, after: { stage: 'vyhráno' } },
  ])
})

test('neither changed produces no entries', () => {
  const diffs = dealAuditDiff(base, { amount_one_time: 580000, stage: 'rozsah_nabidka' })
  expect(diffs).toEqual([])
})

test('string vs number amount from PostgREST is not treated as a change', () => {
  // PostgREST vrací numeric jako řetězec — '580000' vs 580000 nesmí vyjít jako změna.
  const diffs = dealAuditDiff({ ...base, amount_one_time: '580000' }, { amount_one_time: 580000, stage: 'rozsah_nabidka' })
  expect(diffs).toEqual([])
})

test('a real change is still detected even when existing is a string', () => {
  const diffs = dealAuditDiff({ ...base, amount_one_time: '580000' }, { amount_one_time: 600000, stage: 'rozsah_nabidka' })
  expect(diffs).toEqual([
    { action: 'deal.amount_changed', before: { amount_one_time: '580000' }, after: { amount_one_time: 600000 } },
  ])
})
