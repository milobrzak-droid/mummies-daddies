import { readFileSync } from 'node:fs'
import { expect, test } from 'vitest'
import {
  MILESTONE_STATUSES,
  transitionMilestone,
  validateHandoff,
  HANDOFF_ITEMS,
  nextMilestoneStatuses,
  isMilestoneStatus,
} from '@/domain/delivery/milestone'

const none = { acceptedAt: null, acceptedByContactId: null, acceptanceEvidenceId: null }
const accepted = { acceptedAt: '2026-09-28T10:00:00Z', acceptedByContactId: null, acceptanceEvidenceId: 3 }

test('odesláno není přijato: bez akceptace nejde do prijato', () => {
  expect(transitionMilestone('ceka_na_schvaleni', 'prijato', none).ok).toBe(false)
  expect(transitionMilestone('ceka_na_schvaleni', 'prijato', { ...none, acceptedAt: '2026-09-28' }).ok).toBe(false)
  expect(transitionMilestone('ceka_na_schvaleni', 'prijato', accepted)).toEqual({ ok: true, status: 'prijato' })
  // Kontakt bez evidence nestačí (kontakt může zmizet GDPR výmazem).
  expect(
    transitionMilestone('ceka_na_schvaleni', 'prijato', { acceptedAt: '2026-09-28', acceptedByContactId: 7, acceptanceEvidenceId: null }).ok,
  ).toBe(false)
  expect(
    transitionMilestone('ceka_na_schvaleni', 'prijato', { acceptedAt: '2026-09-28', acceptedByContactId: 7, acceptanceEvidenceId: 3 }).ok,
  ).toBe(true)
})

test('uzavreno jen z prijato a s akceptací', () => {
  expect(transitionMilestone('v_praci', 'uzavreno', accepted).ok).toBe(false)
  expect(transitionMilestone('prijato', 'uzavreno', none).ok).toBe(false)
  expect(transitionMilestone('prijato', 'uzavreno', accepted).ok).toBe(true)
  expect(transitionMilestone('uzavreno', 'v_praci', accepted).ok).toBe(false)
})

test('nelze přeskočit schválení', () => {
  expect(transitionMilestone('v_praci', 'prijato', accepted).ok).toBe(false)
})

test('stavy odpovídají CHECKu v migraci 0042', () => {
  const sql = readFileSync('supabase/migrations/0042_engagement_milestone.sql', 'utf8')
  const m = sql.match(/status IN \(([^)]*)\)/)
  const inSql = [...(m?.[1] ?? '').matchAll(/'([a-z_]+)'/g)].map((x) => x[1])
  expect(inSql).toEqual([...MILESTONE_STATUSES])
})

test('předávací balíček vypíše chybějící položky', () => {
  const r = validateHandoff({ goal: 'Adopce Copilotu', scope: '  ', owner: 'uuid', risks: [] })
  expect(r.ok).toBe(false)
  expect(r.missing).toEqual([
    'scope', 'approvedOffer', 'clientSponsor', 'dates', 'baselineMetric', 'financialFrame', 'materials',
  ])
  const full = Object.fromEntries(HANDOFF_ITEMS.map((i) => [i.key, 'x']))
  expect(validateHandoff({ ...full, risks: [] })).toEqual({ ok: true, missing: [] })
  expect(validateHandoff({ ...full, risks: undefined }).missing).toEqual(['risks'])
})

test('graf přechodů: Přijato jen z Čeká na schválení, Uzavřeno je koncové, každý stav dosažitelný', () => {
  for (const s of MILESTONE_STATUSES) {
    expect(nextMilestoneStatuses(s).includes('prijato')).toBe(s === 'ceka_na_schvaleni')
  }
  expect(nextMilestoneStatuses('uzavreno')).toEqual([])
  const reached = new Set<string>(['pripraveno'])
  const queue = ['pripraveno' as const as (typeof MILESTONE_STATUSES)[number]]
  while (queue.length) {
    for (const n of nextMilestoneStatuses(queue.shift()!)) if (!reached.has(n)) { reached.add(n); queue.push(n) }
  }
  expect([...reached].sort()).toEqual([...MILESTONE_STATUSES].sort())
  expect(isMilestoneStatus('prijato')).toBe(true)
  expect(isMilestoneStatus('hotovo')).toBe(false)
})
