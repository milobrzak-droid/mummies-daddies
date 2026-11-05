import { expect, test } from 'vitest'
import {
  summarizeGates,
  DELIVERY_GATES,
  summarizeMilestonesForGates,
  describeMilestoneContext,
} from '@/domain/delivery/deliveryGates'

const all = (v: boolean | null) =>
  Object.fromEntries(DELIVERY_GATES.map((g) => [g.key, v]))

test('there are exactly the six gates the standard defines', () => {
  expect(DELIVERY_GATES).toHaveLength(6)
})

test('all six met means the delivery passed', () => {
  const s = summarizeGates(all(true))
  expect(s.overall).toBe('passed')
  expect(s.passed).toBe(6)
})

test('nothing rated yet is incomplete, never passed', () => {
  // Nevyplněná dodávka se nesmí tvářit jako prošlá.
  expect(summarizeGates({}).overall).toBe('incomplete')
  expect(summarizeGates(all(null)).overall).toBe('incomplete')
})

test('one failed gate fails the delivery', () => {
  const s = summarizeGates({ ...all(true), gate_peer_learning: false })
  expect(s.overall).toBe('failed')
  expect(s.failed).toBe(1)
})

test('a failed gate outweighs gates nobody rated', () => {
  // Neprošlo se dozvíme hned, nečeká se na doplnění zbytku.
  const s = summarizeGates({ ...all(null), gate_safety_followed: false })
  expect(s.overall).toBe('failed')
})

test('five of six is still not a pass', () => {
  const s = summarizeGates({ ...all(true), gate_pack_delivered: null })
  expect(s.overall).toBe('incomplete')
  expect(s.passed).toBe(5)
  expect(s.unrated).toBe(1)
})

// summarizeMilestonesForGates / describeMilestoneContext — kap. 6: souhrn
// skutečných dat milníků vedle bran, žádná vazba milník → brána (viz
// zdůvodnění v domain/delivery/deliveryGates.ts).

test('no milestones yet: no context and no note', () => {
  const ctx = summarizeMilestonesForGates([])
  expect(ctx).toEqual({ total: 0, accepted: 0, pending: 0, lastAcceptedOn: null })
  expect(describeMilestoneContext(ctx)).toBeNull()
})

test('pending milestones are counted and named in the note', () => {
  const ctx = summarizeMilestonesForGates([
    { status: 'v_praci', accepted_at: null },
    { status: 'ceka_na_schvaleni', accepted_at: null },
  ])
  expect(ctx.pending).toBe(2)
  expect(ctx.accepted).toBe(0)
  expect(describeMilestoneContext(ctx)).toBe('2 milníky čeká na akceptaci klienta')
})

test('accepted and uzavreno both count as accepted, not pending', () => {
  const ctx = summarizeMilestonesForGates([
    { status: 'prijato', accepted_at: '2026-09-20T10:00:00Z' },
    { status: 'uzavreno', accepted_at: '2026-09-28T10:00:00Z' },
  ])
  expect(ctx.accepted).toBe(2)
  expect(ctx.pending).toBe(0)
  // Poslední = pozdější datum, ne poslední v poli.
  expect(ctx.lastAcceptedOn).toBe('2026-09-28')
  expect(describeMilestoneContext(ctx)).toBe('poslední milník přijat 28.09.2026')
})

test('note combines pending count and last acceptance date when both apply', () => {
  const ctx = summarizeMilestonesForGates([
    { status: 'prijato', accepted_at: '2026-09-01T10:00:00Z' },
    { status: 'ceka_na_vstup', accepted_at: null },
  ])
  expect(describeMilestoneContext(ctx)).toBe('1 milník čeká na akceptaci klienta · poslední milník přijat 01.09.2026')
})

test('milestone word forms: 1 / 2-4 / 5+', () => {
  const one = summarizeMilestonesForGates([{ status: 'v_praci', accepted_at: null }])
  const three = summarizeMilestonesForGates(Array(3).fill({ status: 'v_praci', accepted_at: null }))
  const five = summarizeMilestonesForGates(Array(5).fill({ status: 'v_praci', accepted_at: null }))
  expect(describeMilestoneContext(one)).toContain('1 milník čeká')
  expect(describeMilestoneContext(three)).toContain('3 milníky čeká')
  expect(describeMilestoneContext(five)).toContain('5 milníků čeká')
})
