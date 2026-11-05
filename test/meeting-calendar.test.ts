// domain/crm/meetingCalendar.ts — co udělat, když se naplánovaná schůzka
// v Outlooku posune nebo zruší. Čisté funkce, žádná DB ani síť.
import { describe, expect, test } from 'vitest'
import {
  calendarSyncEnabledFromEnv,
  detectMeetingChange,
  followUpStepText,
  formatCalendarSyncSummary,
  meetingWhenLabel,
  planMeetingChange,
  rescheduleStepText,
  type ChangeOp,
  type DealCandidate,
  type MilestoneContext,
  type PlannedMeeting,
  type TaskDraft,
} from '@/domain/crm/meetingCalendar'

const NOW = new Date('2026-09-29T08:00:00Z')
const TODAY = '2026-09-29'
const OWNER = 'owner-uuid'
const MS_OWNER = 'milestone-owner-uuid'
const DEAL_OWNER = 'deal-owner-uuid'

// Workshop 1. 10. v 10:00 pražského času (08:00Z), follow-up 11. 10.
const meeting = (over: Partial<PlannedMeeting> = {}): PlannedMeeting => ({
  id: 41,
  account_id: 7,
  subject: 'Workshop AI',
  occurred_at: '2026-10-01T08:00:00+00:00',
  follow_up_on: '2026-10-11',
  ms_event_id: 'ev-41',
  created_by: OWNER,
  milestone_id: null,
  ...over,
})

const milestone = (over: Partial<MilestoneContext> = {}): MilestoneContext => ({
  id: 9,
  title: 'Workshop',
  status: 'pripraveno',
  due_on: '2026-10-01',
  due_from_activity_id: 41,
  owner_id: MS_OWNER,
  deputy_id: null,
  engagement_id: 3,
  engagement_owner_id: null,
  ...over,
})

const deal = (over: Partial<DealCandidate> = {}): DealCandidate => ({
  id: 5,
  owner_id: DEAL_OWNER,
  next_step: followUpStepText('Workshop AI'),
  next_step_due: '2026-10-11',
  ...over,
})

// Posun na so 3. 10. 14:00 Praha (12:00Z) = o dva dny.
const MOVED = { kind: 'moved' as const, from: '2026-10-01T08:00:00+00:00', to: '2026-10-03T12:00:00.000Z' }

const opsOf = (ops: ChangeOp[], kind: ChangeOp['op']) => ops.filter((o) => o.op === kind)
const tasksOf = (ops: ChangeOp[]): TaskDraft[] => ops.flatMap((o) => (o.op === 'task' ? [o.task] : []))

describe('texty sdílené s plánováním schůzky', () => {
  test('další krok obchodu má přesně tvar, který dnes zapisuje plánování (jinak by ho kontrola nenašla)', () => {
    expect(followUpStepText('Workshop AI')).toBe('Follow-up po schůzce „Workshop AI"')
    expect(rescheduleStepText('Workshop AI')).toBe('Domluvit nový termín schůzky „Workshop AI"')
  })

  test('čas schůzky česky v pražském čase', () => {
    expect(meetingWhenLabel('2026-10-03T12:00:00.000Z')).toBe('so 3. 10. 14:00')
    expect(meetingWhenLabel('2026-12-03T12:00:00.000Z')).toBe('čt 3. 12. 13:00')
  })

  test('vypínač: běží, dokud ho někdo výslovně nevypne', () => {
    expect(calendarSyncEnabledFromEnv({})).toBe(true)
    expect(calendarSyncEnabledFromEnv({ CALENDAR_SYNC_ENABLED: 'true' })).toBe(true)
    expect(calendarSyncEnabledFromEnv({ CALENDAR_SYNC_ENABLED: 'false' })).toBe(false)
  })
})

describe('detectMeetingChange', () => {
  test('stejný začátek (i s jiným zápisem času) → beze změny', () => {
    expect(detectMeetingChange(meeting(), { kind: 'event', start: '2026-10-01T08:00:00.000Z', isCancelled: false }, NOW))
      .toEqual({ kind: 'none' })
    expect(detectMeetingChange(meeting(), { kind: 'event', start: '2026-10-01T08:00:30.000Z', isCancelled: false }, NOW))
      .toEqual({ kind: 'none' })
  })

  test('jiný začátek → posunuto (z Cockpitu na Outlook)', () => {
    expect(detectMeetingChange(meeting(), { kind: 'event', start: '2026-10-03T12:00:00.000Z', isCancelled: false }, NOW))
      .toEqual(MOVED)
  })

  test('zrušená v Outlooku → zrušeno; smazaná budoucí → zrušeno; smazaná minulá → nic', () => {
    expect(detectMeetingChange(meeting(), { kind: 'event', start: '2026-10-01T08:00:00.000Z', isCancelled: true }, NOW))
      .toEqual({ kind: 'cancelled', reason: 'cancelled' })
    expect(detectMeetingChange(meeting(), { kind: 'not_found' }, NOW)).toEqual({ kind: 'cancelled', reason: 'deleted' })
    // Minulou schůzku organizátor klidně smaže až po ní — to zrušení není.
    expect(detectMeetingChange(meeting({ occurred_at: '2026-09-28T08:00:00+00:00' }), { kind: 'not_found' }, NOW))
      .toEqual({ kind: 'none' })
  })
})

describe('planMeetingChange — posun', () => {
  const base = { deals: [] as DealCandidate[], milestone: null, accountOwnerId: null, today: TODAY }

  test('termín milníku převzatý ze schůzky + odvozený další krok obchodu → posunout oba, žádný úkol', () => {
    const plan = planMeetingChange({ ...base, meeting: meeting({ milestone_id: 9 }), change: MOVED, milestone: milestone(), deals: [deal()] })
    expect(plan.ops).toEqual([
      { op: 'milestone_shift', milestoneId: 9, activityId: 41, fromDay: '2026-10-01', toDay: '2026-10-03' },
      { op: 'deal_shift', dealId: 5, stepText: followUpStepText('Workshop AI'), fromDue: '2026-10-11', toDue: '2026-10-13' },
      { op: 'activity_move', activityId: 41, from: MOVED.from, to: MOVED.to, followUpFrom: '2026-10-11', followUpTo: '2026-10-13' },
    ])
    expect(plan.milestone).toBe('shifted')
    expect(plan.deals.shifted).toBe(1)
  })

  test('termín milníku zadal člověk → nepřepisovat, úkol vlastníkovi milníku (vysoká priorita, když je schůzka až po termínu)', () => {
    const plan = planMeetingChange({
      ...base,
      meeting: meeting({ milestone_id: 9 }),
      change: MOVED,
      milestone: milestone({ due_on: '2026-10-02', due_from_activity_id: null }),
    })
    expect(opsOf(plan.ops, 'milestone_shift')).toEqual([])
    const [task] = tasksOf(plan.ops)
    expect(task).toMatchObject({
      assignee_id: MS_OWNER,
      priority: 'high',
      due_on: TODAY,
      account_id: 7,
      engagement_id: 3,
      title: 'Schůzka k milníku „Workshop“ se posunula na so 3. 10. 14:00 – zkontroluj termín milníku',
    })
    expect(task.description).toContain('Termín milníku (2. 10.) Cockpit nezměnil')
    expect(task.description).toContain('až po termínu milníku')
    expect(plan.ops.at(-1)?.op).toBe('activity_move')
    expect(plan.milestone).toBe('task')
  })

  test('posun před termín milníku → úkol s běžnou prioritou; vlastník chybí → zástup, dodávka, organizátor', () => {
    const early = { kind: 'moved' as const, from: MOVED.from, to: '2026-09-30T08:00:00.000Z' }
    const plan = planMeetingChange({
      ...base,
      meeting: meeting({ milestone_id: 9 }),
      change: early,
      milestone: milestone({ due_on: '2026-10-05', due_from_activity_id: null, owner_id: null, engagement_owner_id: 'eng-owner' }),
    })
    expect(tasksOf(plan.ops)[0]).toMatchObject({ priority: 'normal', assignee_id: 'eng-owner' })
    const noOne = planMeetingChange({
      ...base,
      meeting: meeting({ milestone_id: 9 }),
      change: early,
      milestone: milestone({ due_on: null, due_from_activity_id: null, owner_id: null }),
    })
    expect(tasksOf(noOne.ops)[0]).toMatchObject({ assignee_id: OWNER, priority: 'normal' })
    expect(tasksOf(noOne.ops)[0].description).toContain('Milník nemá termín.')
  })

  test('opakovaný běh po pádu: milník i obchod už mají nový termín → žádný další zápis ani úkol', () => {
    const plan = planMeetingChange({
      ...base,
      meeting: meeting({ milestone_id: 9 }),
      change: MOVED,
      milestone: milestone({ due_on: '2026-10-03' }),
      deals: [deal({ next_step_due: '2026-10-13' })],
    })
    expect(plan.ops.map((o) => o.op)).toEqual(['activity_move'])
    expect(plan.milestone).toBe('already_shifted')
  })

  test('posun v rámci téhož dne → jen čas schůzky; dny milníku ani obchodu se nemění', () => {
    const sameDay = { kind: 'moved' as const, from: MOVED.from, to: '2026-10-01T12:00:00.000Z' }
    const plan = planMeetingChange({
      ...base,
      meeting: meeting({ milestone_id: 9 }),
      change: sameDay,
      milestone: milestone({ due_on: '2026-09-30', due_from_activity_id: null }),
      deals: [deal()],
    })
    expect(plan.ops).toEqual([
      { op: 'activity_move', activityId: 41, from: MOVED.from, to: sameDay.to, followUpFrom: '2026-10-11', followUpTo: '2026-10-11' },
    ])
  })

  test('další krok s ručně změněným termínem, schůzka je teď až po něm → úkol vlastníkovi obchodu', () => {
    const plan = planMeetingChange({ ...base, meeting: meeting(), change: MOVED, deals: [deal({ next_step_due: '2026-10-02' })] })
    expect(opsOf(plan.ops, 'deal_shift')).toEqual([])
    expect(tasksOf(plan.ops)).toEqual([expect.objectContaining({ assignee_id: DEAL_OWNER, deal_id: 5, priority: 'normal' })])
    expect(plan.deals.flagged).toBe(1)
  })

  test('jiný další krok obchodu (člověk ho přepsal) → obchodu se nic neděje', () => {
    const plan = planMeetingChange({ ...base, meeting: meeting(), change: MOVED, deals: [deal({ next_step: 'Poslat nabídku' })] })
    expect(plan.ops.map((o) => o.op)).toEqual(['activity_move'])
  })

  test('přijatý nebo uzavřený milník termín nehlídá', () => {
    for (const status of ['prijato', 'uzavreno']) {
      const plan = planMeetingChange({ ...base, meeting: meeting({ milestone_id: 9 }), change: MOVED, milestone: milestone({ status, due_from_activity_id: null }) })
      expect(plan.ops.map((o) => o.op)).toEqual(['activity_move'])
    }
  })

  test('schůzka bez termínu dalšího kontaktu → posune se jen čas', () => {
    const plan = planMeetingChange({ ...base, meeting: meeting({ follow_up_on: null }), change: MOVED, deals: [deal()] })
    expect(plan.ops).toEqual([{ op: 'activity_move', activityId: 41, from: MOVED.from, to: MOVED.to, followUpFrom: null, followUpTo: null }])
  })
})

describe('planMeetingChange — zrušení', () => {
  const base = { deals: [] as DealCandidate[], milestone: null, accountOwnerId: 'account-owner', today: TODAY }
  const CANCELLED = { kind: 'cancelled' as const, reason: 'deleted' as const }

  test('stav zrušeno + úkol vlastníkovi schůzky; odvozený další krok → „Domluvit nový termín" dnes', () => {
    const plan = planMeetingChange({ ...base, meeting: meeting(), change: CANCELLED, deals: [deal()] })
    expect(plan.ops[0]).toEqual({
      op: 'deal_replan', dealId: 5, fromText: followUpStepText('Workshop AI'), fromDue: '2026-10-11',
      text: rescheduleStepText('Workshop AI'), due: TODAY,
    })
    const tasks = tasksOf(plan.ops)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({
      assignee_id: OWNER, priority: 'high', due_on: TODAY, account_id: 7, deal_id: 5,
      title: 'Schůzka „Workshop AI“ (čt 1. 10. 10:00) byla v Outlooku zrušena – domluv nový termín',
    })
    expect(tasks[0].description).toContain('organizátor ji zrušil nebo smazal')
    expect(tasks[0].description).toContain('Domluvit nový termín schůzky')
    expect(plan.ops.at(-1)).toEqual({ op: 'activity_cancel', activityId: 41 })
  })

  test('bez organizátora dostane úkol vlastník klienta', () => {
    const plan = planMeetingChange({ ...base, meeting: meeting({ created_by: null }), change: CANCELLED })
    expect(tasksOf(plan.ops)[0].assignee_id).toBe('account-owner')
  })

  test('milník jiného vlastníka → druhý úkol jemu; termín milníku se nemění', () => {
    const plan = planMeetingChange({ ...base, meeting: meeting({ milestone_id: 9 }), change: CANCELLED, milestone: milestone() })
    const tasks = tasksOf(plan.ops)
    expect(tasks.map((t) => t.assignee_id)).toEqual([OWNER, MS_OWNER])
    expect(tasks[1]).toMatchObject({ priority: 'high', engagement_id: 3 })
    expect(tasks[1].title).toBe('Schůzka k milníku „Workshop“ byla zrušena – zkontroluj termín milníku')
    expect(`${tasks[1].title} ${tasks[1].description}`).not.toContain('Workshop AI')
    expect(opsOf(plan.ops, 'milestone_shift')).toEqual([])
  })

  test('milník téhož vlastníka → jeden úkol, milník v popisu', () => {
    const plan = planMeetingChange({ ...base, meeting: meeting({ milestone_id: 9 }), change: CANCELLED, milestone: milestone({ owner_id: OWNER }) })
    const tasks = tasksOf(plan.ops)
    expect(tasks).toHaveLength(1)
    expect(tasks[0].engagement_id).toBe(3)
    expect(tasks[0].description).toContain('patřila k milníku „Workshop“ s termínem 1. 10.')
  })

  test('další krok s ručním termínem se nepřepisuje, jen se zmíní v úkolu', () => {
    const plan = planMeetingChange({ ...base, meeting: meeting(), change: { kind: 'cancelled', reason: 'cancelled' }, deals: [deal({ next_step_due: '2026-10-20' })] })
    expect(opsOf(plan.ops, 'deal_replan')).toEqual([])
    expect(tasksOf(plan.ops)[0].description).toContain('počítal s touhle schůzkou')
    expect(tasksOf(plan.ops)[0].description).toContain('Schůzka je v Outlooku zrušená.')
  })

  test('dlouhý název se v úkolu zkrátí', () => {
    const plan = planMeetingChange({ ...base, meeting: meeting({ subject: 'x'.repeat(400) }), change: CANCELLED })
    expect(tasksOf(plan.ops)[0].title.length).toBeLessThanOrEqual(300)
  })
})

describe('formatCalendarSyncSummary', () => {
  const zero = { checked: 0, moved: 0, cancelled: 0, tasksCreated: 0, milestonesShifted: 0, dealsShifted: 0, skipped: 0, errors: 0 }
  test('nic ke kontrole / beze změny / se změnami / nedokončené', () => {
    expect(formatCalendarSyncSummary(zero)).toBe('Žádná naplánovaná schůzka ke kontrole.')
    expect(formatCalendarSyncSummary({ ...zero, checked: 3 })).toBe('Zkontrolováno 3 schůzky, v Outlooku beze změny.')
    expect(formatCalendarSyncSummary({ ...zero, checked: 5, moved: 1, cancelled: 2, tasksCreated: 2, milestonesShifted: 1 }))
      .toBe('Zkontrolováno 5 schůzek: 1 posunutá, 2 zrušené. Posunuté termíny milníků: 1, nové úkoly: 2.')
    expect(formatCalendarSyncSummary({ ...zero, checked: 1, skipped: 2 })).toContain('zkusí se to znovu')
  })
})
