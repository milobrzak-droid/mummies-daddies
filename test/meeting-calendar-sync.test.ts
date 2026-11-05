// Kontrola naplánovaných schůzek v Outlooku — celý běh (domain/crm/
// meetingCalendarSync.ts) nad databází v paměti přes skutečný Supabase
// adaptér (meetingCalendarService.ts) a skutečný transport Graphu
// (connectors/graph/calendar.ts) s podvrženými odpověďmi Microsoftu.
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { MemoryDb, type Row } from './helpers/memoryDb'

vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))

import { fetchCalendarEvent } from '@/connectors/graph'
import { followUpStepText, rescheduleStepText } from '@/domain/crm/meetingCalendar'
import { createMeetingCalendarDb } from '@/domain/crm/meetingCalendarService'
import {
  CALENDAR_FORBIDDEN_ERROR,
  CALENDAR_MASS_MISSING_ERROR,
  runMeetingCalendarSync,
  type MeetingCalendarDb,
  type MeetingCalendarDeps,
} from '@/domain/crm/meetingCalendarSync'

const NOW = new Date('2026-09-29T08:00:00Z')
const VIKTOR = '11111111-1111-4111-8111-111111111111'
const PETRA = '22222222-2222-4222-8222-222222222222'
const DEAL_OWNER = '33333333-3333-4333-8333-333333333333'

type GraphReply = { status: number; body?: unknown; headers?: Record<string, string> }

/** Podvržený Microsoft Graph: odpověď podle id události, záznam dotazů. */
function fakeGraph(replies: Record<string, GraphReply>) {
  const calls: string[] = []
  const fetchImpl = vi.fn(async (url: string) => {
    const id = decodeURIComponent(url.split('/me/events/')[1].split('?')[0])
    calls.push(id)
    const r = replies[id] ?? { status: 404, body: { error: { code: 'ErrorItemNotFound' } } }
    return new Response(r.body === undefined ? null : JSON.stringify(r.body), {
      status: r.status,
      headers: { 'Content-Type': 'application/json', ...(r.headers ?? {}) },
    })
  })
  return { calls, fetchImpl }
}

const eventAt = (id: string, utc: string, isCancelled = false): GraphReply => ({
  status: 200,
  body: { id, start: { dateTime: `${utc}.0000000`, timeZone: 'UTC' }, end: null, isCancelled },
})

function freshDb(opts: ConstructorParameters<typeof MemoryDb>[0] = {}) {
  const db = new MemoryDb({
    unique: { sales_activity: [{ columns: ['source', 'external_id'] }] },
    // Jako DEFAULT now() v DB — podle created_at se hledá už založený úkol.
    defaults: { task: () => ({ created_at: NOW.toISOString() }) },
    ...opts,
  })
  db.seed('account', [{ id: 7, name: 'ALFATECH', owner_id: VIKTOR }])
  db.seed('engagement', [{ id: 3, account_id: 7, kind: 'edu', owner_id: PETRA }])
  db.seed('engagement_milestone', [
    // Termín převzatý ze schůzky 41 (plánování ho nastavilo).
    { id: 9, engagement_id: 3, title: 'Workshop', status: 'pripraveno', due_on: '2026-10-01', due_from_activity_id: 41, owner_id: PETRA, deputy_id: null },
  ])
  db.seed('deal', [
    { id: 5, account_id: 7, stage: 'diagnostika', owner_id: DEAL_OWNER, next_step: followUpStepText('Workshop AI'), next_step_due: '2026-10-11' },
  ])
  db.seed('sales_activity', [
    {
      id: 41, account_id: 7, kind: 'meeting', outcome: 'planned', source: 'cockpit', subject: 'Workshop AI',
      occurred_at: '2026-10-01T08:00:00+00:00', follow_up_on: '2026-10-11', ms_event_id: 'ev-41', created_by: VIKTOR,
      milestone_id: 9, external_id: null,
    },
  ])
  return db
}

function deps(db: MemoryDb, graph: ReturnType<typeof fakeGraph>, over: Partial<MeetingCalendarDeps> = {}): MeetingCalendarDeps {
  return {
    db: createMeetingCalendarDb(db.client as never, db.client as never),
    token: async () => ({ ok: true, accessToken: 'tok' }),
    fetchEvent: (accessToken, eventId) => fetchCalendarEvent(accessToken, eventId, graph.fetchImpl),
    now: () => NOW,
    ...over,
  }
}

const row = (db: MemoryDb, table: string, id: number): Row => db.rows(table).find((r) => r.id === id)!

let db: MemoryDb
beforeEach(() => {
  db = freshDb()
})

describe('posunutý workshop', () => {
  test('schůzka, převzatý termín milníku i odvozený další krok obchodu se posunou; úkol nevznikne', async () => {
    const graph = fakeGraph({ 'ev-41': eventAt('ev-41', '2026-10-03T12:00:00') })
    const stats = await runMeetingCalendarSync(deps(db, graph))

    expect(graph.calls).toEqual(['ev-41'])
    expect(stats).toMatchObject({ meetings: 1, checked: 1, moved: 1, milestonesShifted: 1, dealsShifted: 1, tasksCreated: 0, errors: 0 })
    expect(row(db, 'sales_activity', 41)).toMatchObject({ occurred_at: '2026-10-03T12:00:00.000Z', follow_up_on: '2026-10-13', outcome: 'planned' })
    expect(row(db, 'engagement_milestone', 9)).toMatchObject({ due_on: '2026-10-03', due_from_activity_id: 41 })
    expect(row(db, 'deal', 5)).toMatchObject({ next_step: followUpStepText('Workshop AI'), next_step_due: '2026-10-13', follow_up_nudged_on: null })
    expect(db.rows('task')).toHaveLength(0)
  })

  test('druhý běh nic nezmění ani nezdvojí (idempotence)', async () => {
    const graph = fakeGraph({ 'ev-41': eventAt('ev-41', '2026-10-03T12:00:00') })
    await runMeetingCalendarSync(deps(db, graph))
    const writes = db.calls.filter((c) => c.op !== 'select').length
    const again = await runMeetingCalendarSync(deps(db, graph))
    expect(again).toMatchObject({ checked: 1, unchanged: 1, moved: 0, tasksCreated: 0 })
    expect(db.calls.filter((c) => c.op !== 'select').length).toBe(writes)
  })

  test('termín milníku zadal člověk → nezmění se, vlastník milníku dostane úkol (jednou)', async () => {
    Object.assign(row(db, 'engagement_milestone', 9), { due_on: '2026-10-02', due_from_activity_id: null })
    const graph = fakeGraph({ 'ev-41': eventAt('ev-41', '2026-10-05T08:00:00') })
    const stats = await runMeetingCalendarSync(deps(db, graph))

    expect(stats).toMatchObject({ moved: 1, milestonesShifted: 0, milestoneTasks: 1, tasksCreated: 1 })
    expect(row(db, 'engagement_milestone', 9).due_on).toBe('2026-10-02')
    const [task] = db.rows('task')
    expect(task).toMatchObject({
      assignee_id: PETRA, priority: 'high', status: 'todo', due_on: '2026-09-29', engagement_id: 3, account_id: 7, created_by: null,
    })
    expect(String(task.title)).toBe('Schůzka k milníku „Workshop“ se posunula na po 5. 10. 10:00 – zkontroluj termín milníku')
    // Stejná změna podruhé (třeba po pádu před potvrzením schůzky) úkol nezdvojí.
    row(db, 'sales_activity', 41).occurred_at = '2026-10-01T08:00:00+00:00'
    await runMeetingCalendarSync(deps(db, graph))
    expect(db.rows('task')).toHaveLength(1)
  })
})

describe('zrušená schůzka', () => {
  test('404 u budoucí schůzky → zrušeno, další krok „Domluvit nový termín", úkoly organizátorovi a vlastníkovi milníku', async () => {
    const graph = fakeGraph({})
    const stats = await runMeetingCalendarSync(deps(db, graph))

    expect(stats).toMatchObject({ checked: 1, cancelled: 1, dealsReplanned: 1, tasksCreated: 2 })
    expect(row(db, 'sales_activity', 41).outcome).toBe('cancelled')
    expect(row(db, 'deal', 5)).toMatchObject({ next_step: rescheduleStepText('Workshop AI'), next_step_due: '2026-09-29' })
    // Termín milníku se potichu nemění.
    expect(row(db, 'engagement_milestone', 9).due_on).toBe('2026-10-01')
    const tasks = db.rows('task')
    expect(tasks.map((t) => t.assignee_id).sort()).toEqual([VIKTOR, PETRA].sort())
    expect(tasks.every((t) => t.priority === 'high')).toBe(true)
    expect(tasks.find((t) => t.assignee_id === VIKTOR)).toMatchObject({ deal_id: 5, account_id: 7 })

    // Zrušená schůzka už naplánovaná není → další běh ji nekontroluje.
    const again = await runMeetingCalendarSync(deps(db, graph))
    expect(again.meetings).toBe(0)
    expect(db.rows('task')).toHaveLength(2)
  })

  test('výslovně zrušená (isCancelled) platí i u proběhlé schůzky; smazaná proběhlá ne', async () => {
    row(db, 'sales_activity', 41).occurred_at = '2026-09-28T08:00:00+00:00'
    const gone = await runMeetingCalendarSync(deps(db, fakeGraph({})))
    expect(gone).toMatchObject({ checked: 1, unchanged: 1, cancelled: 0 })
    expect(row(db, 'sales_activity', 41).outcome).toBe('planned')

    const cancelled = await runMeetingCalendarSync(deps(db, fakeGraph({ 'ev-41': eventAt('ev-41', '2026-09-28T08:00:00', true) })))
    expect(cancelled.cancelled).toBe(1)
    expect(row(db, 'sales_activity', 41).outcome).toBe('cancelled')
  })
})

describe('co se nekontroluje a chyby', () => {
  test('jen schůzky z Cockpitu s událostí, naplánované a nejvýš 7 dní zpět', async () => {
    db.seed('sales_activity', [
      { id: 50, account_id: 7, kind: 'meeting', outcome: 'completed', source: 'cockpit', subject: 'Hotovo', occurred_at: '2026-09-28T08:00:00+00:00', ms_event_id: 'ev-50', created_by: VIKTOR },
      { id: 51, account_id: 7, kind: 'meeting', outcome: 'planned', source: 'api', subject: 'Z API', occurred_at: '2026-10-02T08:00:00+00:00', ms_event_id: 'ev-51', created_by: VIKTOR },
      { id: 52, account_id: 7, kind: 'meeting', outcome: 'planned', source: 'cockpit', subject: 'Bez události', occurred_at: '2026-10-02T08:00:00+00:00', ms_event_id: null, created_by: VIKTOR },
      { id: 53, account_id: 7, kind: 'meeting', outcome: 'planned', source: 'cockpit', subject: 'Stará', occurred_at: '2026-09-01T08:00:00+00:00', ms_event_id: 'ev-53', created_by: VIKTOR },
    ])
    const graph = fakeGraph({ 'ev-41': eventAt('ev-41', '2026-10-01T08:00:00') })
    const stats = await runMeetingCalendarSync(deps(db, graph))
    expect(graph.calls).toEqual(['ev-41'])
    expect(stats).toMatchObject({ meetings: 1, unchanged: 1 })
  })

  test('ruční kontrola jen schůzek přihlášeného člena', async () => {
    db.seed('sales_activity', [
      { id: 60, account_id: 7, kind: 'meeting', outcome: 'planned', source: 'cockpit', subject: 'Petřina', occurred_at: '2026-10-02T08:00:00+00:00', ms_event_id: 'ev-60', created_by: PETRA },
    ])
    const graph = fakeGraph({ 'ev-60': eventAt('ev-60', '2026-10-02T08:00:00') })
    const stats = await runMeetingCalendarSync(deps(db, graph), { memberId: PETRA })
    expect(graph.calls).toEqual(['ev-60'])
    expect(stats.meetings).toBe(1)
  })

  test('bez tokenu organizátora se jeho schůzky přeskočí a chyba jde do stavu', async () => {
    const graph = fakeGraph({})
    const stats = await runMeetingCalendarSync(deps(db, graph, { token: async () => ({ ok: false, error: 'Outlook není pro sync připojený' }) }))
    expect(graph.calls).toEqual([])
    expect(stats).toMatchObject({ memberErrors: 1, accessError: 'Outlook není pro sync připojený', skipped: 1, cancelled: 0 })
    expect(row(db, 'sales_activity', 41).outcome).toBe('planned')
  })

  test('chybí-li v kalendáři všechny (3+) schůzky organizátora, nic se neruší (jiný účet v Outlooku?)', async () => {
    db.seed('sales_activity', [
      { id: 42, account_id: 7, kind: 'meeting', outcome: 'planned', source: 'cockpit', subject: 'Druhá', occurred_at: '2026-10-05T08:00:00+00:00', ms_event_id: 'ev-42', created_by: VIKTOR },
      { id: 43, account_id: 7, kind: 'meeting', outcome: 'planned', source: 'cockpit', subject: 'Třetí', occurred_at: '2026-10-06T08:00:00+00:00', ms_event_id: 'ev-43', created_by: VIKTOR },
    ])
    const stats = await runMeetingCalendarSync(deps(db, fakeGraph({})))
    expect(stats).toMatchObject({ cancelled: 0, memberErrors: 1, accessError: CALENDAR_MASS_MISSING_ERROR, skipped: 3 })
    expect(db.rows('sales_activity').every((r) => r.outcome === 'planned')).toBe(true)
    expect(db.rows('task')).toHaveLength(0)

    // Jedna z nich v kalendáři je → ostatní dvě jsou opravdu zrušené.
    const partly = await runMeetingCalendarSync(deps(db, fakeGraph({ 'ev-43': eventAt('ev-43', '2026-10-06T08:00:00') })))
    expect(partly).toMatchObject({ cancelled: 2, unchanged: 1, memberErrors: 0 })
  })

  test('nedokončená kontrola člena (chyba u jiné události) → chybějící událost schůzku nezruší', async () => {
    db.seed('sales_activity', [
      { id: 42, account_id: 7, kind: 'meeting', outcome: 'planned', source: 'cockpit', subject: 'Druhá', occurred_at: '2026-10-05T08:00:00+00:00', ms_event_id: 'ev-42', created_by: VIKTOR },
    ])
    const graph = fakeGraph({ 'ev-42': { status: 500, body: { error: { code: 'generalException' } } } })
    const stats = await runMeetingCalendarSync(deps(db, graph))
    expect(stats).toMatchObject({ cancelled: 0, errors: 1, skipped: 1 })
    expect(row(db, 'sales_activity', 41).outcome).toBe('planned')
  })

  test('403 z Graphu → srozumitelná chyba přístupu, nic se nezruší', async () => {
    const stats = await runMeetingCalendarSync(deps(db, fakeGraph({ 'ev-41': { status: 403, body: { error: { code: 'ErrorAccessDenied' } } } })))
    expect(stats).toMatchObject({ memberErrors: 1, accessError: CALENDAR_FORBIDDEN_ERROR, checked: 0 })
    expect(row(db, 'sales_activity', 41).outcome).toBe('planned')
  })

  test('throttling ukončí běh, zbytek příště', async () => {
    db.seed('sales_activity', [
      { id: 42, account_id: 7, kind: 'meeting', outcome: 'planned', source: 'cockpit', subject: 'Druhá', occurred_at: '2026-10-05T08:00:00+00:00', ms_event_id: 'ev-42', created_by: VIKTOR },
    ])
    const graph = fakeGraph({ 'ev-41': { status: 429, headers: { 'Retry-After': '30' } } })
    const stats = await runMeetingCalendarSync(deps(db, graph))
    expect(graph.calls).toEqual(['ev-41'])
    expect(stats).toMatchObject({ throttled: true, skipped: 2, checked: 0 })
  })

  test('nečitelná odpověď jedné události běh nezastaví', async () => {
    db.seed('sales_activity', [
      { id: 42, account_id: 7, kind: 'meeting', outcome: 'planned', source: 'cockpit', subject: 'Druhá', occurred_at: '2026-10-05T08:00:00+00:00', ms_event_id: 'ev-42', created_by: VIKTOR },
    ])
    const graph = fakeGraph({ 'ev-41': { status: 500, body: { error: { code: 'generalException' } } }, 'ev-42': eventAt('ev-42', '2026-10-05T08:00:00') })
    const stats = await runMeetingCalendarSync(deps(db, graph))
    expect(stats).toMatchObject({ errors: 1, checked: 1, unchanged: 1 })
  })

  test('vyčerpaný čas → zbytek přeskočen', async () => {
    let t = NOW.getTime()
    const graph = fakeGraph({ 'ev-41': eventAt('ev-41', '2026-10-01T08:00:00') })
    const stats = await runMeetingCalendarSync(deps(db, graph, { now: () => new Date((t += 30_000)) }), { budgetMs: 25_000 })
    expect(stats).toMatchObject({ skipped: 1, checked: 0 })
  })

  test('bez migrace 0085 (chybí milestone_id) se schůzka posune dál, jen bez milníku', async () => {
    let first = true
    db = freshDb({
      fail: (table, op) => {
        if (table === 'sales_activity' && op === 'select' && first) {
          first = false
          return { code: '42703', message: 'column sales_activity.milestone_id does not exist' }
        }
        return null
      },
    })
    const stats = await runMeetingCalendarSync(deps(db, fakeGraph({ 'ev-41': eventAt('ev-41', '2026-10-03T12:00:00') })))
    expect(stats).toMatchObject({ moved: 1, milestonesShifted: 0, milestoneTasks: 0 })
    expect(row(db, 'sales_activity', 41).occurred_at).toBe('2026-10-03T12:00:00.000Z')
    expect(row(db, 'engagement_milestone', 9).due_on).toBe('2026-10-01')
  })
})

describe('souběh: člověk mezitím změnil řádek', () => {
  test('podmíněný zápis nesedí → schůzka se nepotvrdí, příští běh změnu posoudí znovu', async () => {
    const inner = createMeetingCalendarDb(db.client as never, db.client as never)
    const racing: MeetingCalendarDb = {
      ...inner,
      async shiftDeal(op) {
        // Mezi načtením a zápisem někdo další krok přepsal.
        row(db, 'deal', 5).next_step = 'Poslat nabídku'
        return inner.shiftDeal(op)
      },
    }
    const graph = fakeGraph({ 'ev-41': eventAt('ev-41', '2026-10-03T12:00:00') })
    const stats = await runMeetingCalendarSync({ ...deps(db, graph), db: racing })
    expect(stats).toMatchObject({ conflicts: 1, moved: 0 })
    expect(row(db, 'sales_activity', 41).occurred_at).toBe('2026-10-01T08:00:00+00:00')
    expect(row(db, 'deal', 5).next_step).toBe('Poslat nabídku')

    // Příští běh: milník už posunutý (pozná to), obchod s cizím krokem nechá být, schůzku posune.
    const next = await runMeetingCalendarSync(deps(db, graph))
    expect(next).toMatchObject({ moved: 1, milestonesShifted: 0, tasksCreated: 0 })
    expect(row(db, 'engagement_milestone', 9).due_on).toBe('2026-10-03')
    expect(row(db, 'sales_activity', 41).occurred_at).toBe('2026-10-03T12:00:00.000Z')
  })
})
