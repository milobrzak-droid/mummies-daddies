// planMeeting + milník dodávky (0085): schůzka se k milníku přiváže, milník
// bez termínu dostane termín podle schůzky (převzatý → bude se s ní posouvat),
// termín zadaný člověkem se nemění. Špatná volba nesmí nic založit napůl.
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createAdminClient } from '@/lib/supabase/admin'
import { createMeetingEvent } from '@/connectors/graph'
import { planMeeting } from '@/domain/crm/actions/planMeeting'
import { followUpStepText } from '@/domain/crm/meetingCalendar'
import { createSupabaseFake, hasOp, opArgs, type QueryCall, type QueryResult } from './helpers/supabaseFake'

vi.mock('@/lib/auth/requireUser', () => ({
  requireUser: vi.fn(async () => ({ id: 'user-1' })),
  tryRequireUser: vi.fn(async () => ({ id: 'user-1' })),
  AUTH_ERROR_MESSAGE: 'auth',
}))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/connectors/ares', () => ({ aresSearchByName: vi.fn(async () => []), pickAresMatch: vi.fn(() => null) }))
vi.mock('@/connectors/graph', () => ({
  graphTokenForCurrentUser: vi.fn(async () => ({ ok: true, accessToken: 'tok' })),
  createMeetingEvent: vi.fn(async () => ({ id: 'ev-1', joinUrl: null })),
}))
vi.mock('@/core/connectorState', () => ({ recordConnectorError: vi.fn(), recordConnectorSuccess: vi.fn() }))
vi.mock('@/lib/queries/access', () => ({ canCurrentUserSeeSales: vi.fn(async () => true) }))

type Milestone = { id: number; title: string; status: string; due_on: string | null; due_from_activity_id: number | null; engagement_id: number }

function fakeAdmin(opts: {
  milestone?: Milestone | null
  milestoneError?: { code: string }
  engagementAccount?: number
  previousOutcome?: string
  deal?: { id: number } | null
} = {}) {
  const resolve = (call: QueryCall): QueryResult => {
    if (call.table === 'engagement_milestone') {
      if (hasOp(call, 'update')) return { data: [{ id: 9 }], error: null }
      if (opts.milestoneError) return { data: null, error: opts.milestoneError }
      return { data: opts.milestone ?? null, error: null }
    }
    if (call.table === 'engagement') return { data: { account_id: opts.engagementAccount ?? 5 }, error: null }
    if (call.table === 'sales_activity') {
      if (hasOp(call, 'insert')) return { data: { id: 77 }, error: null }
      return { data: { outcome: opts.previousOutcome ?? 'planned' }, error: null }
    }
    if (call.table === 'deal' && hasOp(call, 'select')) return { data: opts.deal ?? null, error: null }
    return { data: null, error: null }
  }
  const f = createSupabaseFake({ resolve })
  vi.mocked(createAdminClient).mockReturnValue(f.client as never)
  return f
}

function fd(fields: Record<string, string>): FormData {
  const f = new FormData()
  for (const [k, v] of Object.entries(fields)) f.set(k, v)
  return f
}

// 1. 10. 10:00 Praha = 08:00Z.
const FORM = { account_id: '5', title: 'Workshop AI', start: '2026-10-01T10:00', duration_min: '60', follow_up_days: '10' }
const MS: Milestone = { id: 9, title: 'Workshop', status: 'pripraveno', due_on: null, due_from_activity_id: null, engagement_id: 3 }

const call = (f: ReturnType<typeof fakeAdmin>, table: string, op: string) => f.calls.find((c) => c.table === table && hasOp(c, op))

beforeEach(() => vi.clearAllMocks())

describe('planMeeting — milník dodávky', () => {
  test('milník bez termínu: schůzka k němu patří a milník dostane den schůzky jako převzatý termín', async () => {
    const f = fakeAdmin({ milestone: MS })
    const res = await planMeeting(null, fd({ ...FORM, milestone_id: '9' }))
    expect(res).toMatchObject({ ok: true, milestone: { title: 'Workshop', dueFromMeeting: true, dueOn: '2026-10-01' } })

    const activity = opArgs(call(f, 'sales_activity', 'insert')!, 'insert')?.[0] as Record<string, unknown>
    expect(activity).toMatchObject({ milestone_id: 9, outcome: 'planned', ms_event_id: 'ev-1', occurred_at: '2026-10-01T08:00:00.000Z' })

    const update = call(f, 'engagement_milestone', 'update')!
    expect(opArgs(update, 'update')?.[0]).toEqual({ due_on: '2026-10-01', due_from_activity_id: 77 })
    // Podmíněně: jen když termín pořád nemá.
    expect(update.ops).toContainEqual({ method: 'is', args: ['due_on', null] })
    expect(update.ops).toContainEqual({ method: 'eq', args: ['id', 9] })
  })

  test('termín zadaný člověkem se nemění; schůzka k milníku jen patří', async () => {
    const f = fakeAdmin({ milestone: { ...MS, due_on: '2026-10-05' } })
    const res = await planMeeting(null, fd({ ...FORM, milestone_id: '9' }))
    expect(res).toMatchObject({ ok: true, milestone: { dueFromMeeting: false, dueOn: '2026-10-05' } })
    expect(call(f, 'engagement_milestone', 'update')).toBeUndefined()
    expect((opArgs(call(f, 'sales_activity', 'insert')!, 'insert')?.[0] as Record<string, unknown>).milestone_id).toBe(9)
  })

  test('termín převzatý ze zrušené schůzky převezme nová schůzka', async () => {
    const f = fakeAdmin({ milestone: { ...MS, due_on: '2026-09-30', due_from_activity_id: 41 }, previousOutcome: 'cancelled' })
    const res = await planMeeting(null, fd({ ...FORM, milestone_id: '9' }))
    expect(res).toMatchObject({ ok: true, milestone: { dueFromMeeting: true, dueOn: '2026-10-01' } })
    const update = call(f, 'engagement_milestone', 'update')!
    expect(update.ops).toContainEqual({ method: 'eq', args: ['due_from_activity_id', 41] })
  })

  test('termín převzatý z jiné pořád naplánované schůzky zůstává', async () => {
    const f = fakeAdmin({ milestone: { ...MS, due_on: '2026-09-30', due_from_activity_id: 41 }, previousOutcome: 'planned' })
    const res = await planMeeting(null, fd({ ...FORM, milestone_id: '9' }))
    expect(res).toMatchObject({ ok: true, milestone: { dueFromMeeting: false } })
    expect(call(f, 'engagement_milestone', 'update')).toBeUndefined()
  })

  test.each([
    ['milník jiného klienta', { milestone: MS, engagementAccount: 99 }, 'Vybraný milník u tohoto klienta není'],
    ['neexistující milník', { milestone: null }, 'Vybraný milník u tohoto klienta není'],
    ['uzavřený milník', { milestone: { ...MS, status: 'uzavreno' } }, 'přijatý nebo uzavřený'],
    ['chybí migrace 0085', { milestoneError: { code: '42703' } }, 'po migraci 0085'],
  ])('%s → chyba dřív, než vznikne událost v Outlooku nebo záznam', async (_name, opts, message) => {
    const f = fakeAdmin(opts)
    const res = await planMeeting(null, fd({ ...FORM, milestone_id: '9' }))
    expect(res.ok).toBe(false)
    expect(res.ok ? '' : res.error).toContain(message)
    expect(createMeetingEvent).not.toHaveBeenCalled()
    expect(f.calls.some((c) => hasOp(c, 'insert') || hasOp(c, 'update'))).toBe(false)
  })

  test('milník u nového klienta nejde', async () => {
    fakeAdmin({ milestone: MS })
    const res = await planMeeting(null, fd({ ...FORM, account_id: '', new_account_name: 'Nová firma', milestone_id: '9' }))
    expect(res).toEqual({ ok: false, error: 'Milník jde vybrat jen u existujícího klienta.' })
    expect(createMeetingEvent).not.toHaveBeenCalled()
  })

  test('bez milníku („" z formuláře) se nic nemění: žádné milestone_id, žádný dotaz na milníky', async () => {
    const f = fakeAdmin()
    const res = await planMeeting(null, fd({ ...FORM, milestone_id: '' }))
    expect(res).toMatchObject({ ok: true })
    expect(res.ok && res.milestone).toBeFalsy()
    expect(f.calls.some((c) => c.table === 'engagement_milestone')).toBe(false)
    expect(opArgs(call(f, 'sales_activity', 'insert')!, 'insert')?.[0]).not.toHaveProperty('milestone_id')
  })

  test('další krok obchodu má text, podle kterého ho kontrola kalendáře pozná', async () => {
    const f = fakeAdmin({ deal: { id: 12 } })
    await planMeeting(null, fd(FORM))
    const update = call(f, 'deal', 'update')!
    expect(opArgs(update, 'update')?.[0]).toMatchObject({ next_step: followUpStepText('Workshop AI'), next_step_due: '2026-10-11' })
  })
})
