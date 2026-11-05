import { expect, test } from 'vitest'
import { dueFollowUps, type FollowUpDeal } from '@/domain/crm/followUp'

const base: FollowUpDeal = {
  id: 1, title: 'Agentizace', account_name: 'ALFATECH', owner_id: 'u1',
  next_step: 'Poslat nabídku', next_step_due: null, last_activity_at: null,
  follow_up_nudged_on: null, follow_up_escalated_on: null,
}
const TODAY = new Date('2026-08-20T09:00:00Z')
const d = (o: Partial<FollowUpDeal>): FollowUpDeal[] => [{ ...base, ...o }]

test('stays quiet before the deadline', () => {
  expect(dueFollowUps(d({ next_step_due: '2026-08-25' }), TODAY)).toEqual([])
})

test('nudges the owner on the day the deadline passes', () => {
  const r = dueFollowUps(d({ next_step_due: '2026-08-20' }), TODAY)
  expect(r).toHaveLength(1)
  expect(r[0].level).toBe('owner')
  expect(r[0].days_overdue).toBe(0)
})

test('escalates to the manager once it has been overdue long enough', () => {
  const r = dueFollowUps(d({ next_step_due: '2026-08-17' }), TODAY)
  expect(r[0].level).toBe('manager')
  expect(r[0].days_overdue).toBe(3)
})

test('stays quiet when an activity happened after the deadline', () => {
  // Follow-up proběhl — není co připomínat.
  const r = dueFollowUps(
    d({ next_step_due: '2026-08-18', last_activity_at: '2026-08-19T10:00:00Z' }), TODAY,
  )
  expect(r).toEqual([])
})

test('still nudges when the only activity predates the deadline', () => {
  const r = dueFollowUps(
    d({ next_step_due: '2026-08-18', last_activity_at: '2026-08-10T10:00:00Z' }), TODAY,
  )
  expect(r).toHaveLength(1)
})

test('does not repeat the same nudge twice in one day', () => {
  const r = dueFollowUps(d({ next_step_due: '2026-08-20', follow_up_nudged_on: '2026-08-20' }), TODAY)
  expect(r).toEqual([])
})

test('escalates even when the owner was already nudged earlier', () => {
  // Jiný adresát, jiná zpráva — dřívější upozornění vlastníka ji nebrzdí.
  const r = dueFollowUps(
    d({ next_step_due: '2026-08-17', follow_up_nudged_on: '2026-08-17' }), TODAY,
  )
  expect(r[0].level).toBe('manager')
})

test('ignores deals with no deadline set', () => {
  expect(dueFollowUps(d({ next_step_due: null }), TODAY)).toEqual([])
})

test('puts the most overdue first', () => {
  const r = dueFollowUps([
    { ...base, id: 1, next_step_due: '2026-08-19' },
    { ...base, id: 2, next_step_due: '2026-08-01' },
  ], TODAY)
  expect(r.map((x) => x.deal_id)).toEqual([2, 1])
})
