// Kontrola naplánovaných schůzek v Outlooku — jeden běh nad vstříknutými
// závislostmi (DB, token, Graph), aby šel celý otestovat bez sítě a bez
// Supabase. Co se má při změně stát, rozhoduje domain/crm/meetingCalendar.ts;
// adaptér nad Supabase a živé spuštění je domain/crm/meetingCalendarService.ts.
//
// Kdo to spouští (žádný nový cron — Vercel Hobby):
//   * denně cron /api/cron/follow-ups PŘED hlídačem follow-upů (posunutý
//     další krok obchodu tak hlídač nevyhodnotí podle starého termínu),
//     všechny naplánované schůzky, token každého organizátora přes servisní
//     funkce calendar_token_*_for_service (0041);
//   * ručně tlačítkem (Schůzky → „Zkontrolovat změny v Outlooku", Nastavení →
//     „Synchronizovat úkoly a schůzky") jen schůzky přihlášeného člena
//     s jeho tokenem.
//
// Co se kontroluje: sales_activity druhu schůzka, outcome 'planned', se
// zdrojem 'cockpit' a id události (ms_event_id), začátek nejvýš
// LOOKBACK_DAYS dnů zpátky. Jeden GET na událost (connectors/graph/calendar.ts).
//
// Chyby: jedna nečitelná událost běh nezastaví (errors++). Bez tokenu nebo
// s odmítnutým přístupem (401/403) se schůzky člena přeskočí a chyba jde do
// stavu konektoru (graph_calendar). Throttling (429/503) běh ukončí, zbytek
// příště. Časový rozpočet hlídá, aby se běh vešel do maxDuration routy.
// Pojistka: chybí-li v kalendáři VŠECHNY (aspoň 3) naplánované schůzky
// člena, Cockpit nic neruší — spíš je Outlook připojený k jinému účtu.
import type { CalendarEventResult } from '@/connectors/graph'
import { logError } from '@/lib/log'
import { pragueToday } from '@/lib/pragueDate'
import {
  detectMeetingChange,
  followUpStepText,
  planMeetingChange,
  type ChangeOp,
  type DealCandidate,
  type EventObservation,
  type MeetingChange,
  type MilestoneContext,
  type PlannedMeeting,
  type TaskDraft,
} from '@/domain/crm/meetingCalendar'

const DAY_MS = 86_400_000

export const MEETING_CALENDAR_DEFAULTS = {
  /** Rozpočet času jednoho běhu (route má maxDuration 60 s, zbytek je pro další kroky). */
  budgetMs: 25_000,
  /** Jak daleko zpátky se ještě dívat (posunutá včerejší schůzka je pořád zajímavá). */
  lookbackDays: 7,
  /** Nejvýš schůzek na běh. */
  limit: 200,
} as const

/** Úkol se stejným názvem, řešitelem a klientem za posledních N dní = už založený. */
export const TASK_DEDUPE_DAYS = 30

export const CALENDAR_UNAUTHORIZED_ERROR =
  'Přihlášení k Outlooku vypršelo nebo bylo odvoláno — připoj Outlook znovu v Nastavení.'
export const CALENDAR_FORBIDDEN_ERROR =
  'Outlook nepovolil čtení kalendáře (chybí Calendars.ReadWrite) — připoj Outlook znovu v Nastavení.'

/**
 * Pojistka: když v kalendáři člena chybí VŠECHNY jeho naplánované schůzky
 * (aspoň tolik), nejspíš je Outlook připojený k jinému účtu, ne že by je
 * někdo všechny zrušil. Pak se nic neruší a chyba jde do stavu konektoru.
 */
export const MASS_MISSING_THRESHOLD = 3
export const CALENDAR_MASS_MISSING_ERROR =
  'V kalendáři organizátora chybí všechny jeho naplánované schůzky — Cockpit nic nezrušil. Je Outlook připojený ke správnému účtu?'

export type MilestoneShiftOp = Extract<ChangeOp, { op: 'milestone_shift' }>
export type DealShiftOp = Extract<ChangeOp, { op: 'deal_shift' }>
export type DealReplanOp = Extract<ChangeOp, { op: 'deal_replan' }>
export type ActivityMoveOp = Extract<ChangeOp, { op: 'activity_move' }>
export type ActivityCancelOp = Extract<ChangeOp, { op: 'activity_cancel' }>

/**
 * Přístup k datům. Zápisy (shift*, replan*, move*, cancel*) jsou podmíněné
 * na stav, ze kterého plán vycházel, a vrací false, když mezitím někdo
 * řádek změnil (nic se nepřepíše; příští běh změnu posoudí znovu).
 */
export interface MeetingCalendarDb {
  loadPlannedMeetings(opts: { memberId: string | null; sinceIso: string; limit: number }): Promise<PlannedMeeting[]>
  /** Otevřené obchody klienta s daným dalším krokem. */
  loadDealCandidates(accountId: number, stepText: string): Promise<DealCandidate[]>
  /** Milník schůzky; null, když neexistuje (nebo chybí migrace 0085). */
  loadMilestone(milestoneId: number): Promise<MilestoneContext | null>
  loadAccountOwner(accountId: number): Promise<string | null>
  shiftMilestone(op: MilestoneShiftOp): Promise<boolean>
  shiftDeal(op: DealShiftOp): Promise<boolean>
  replanDeal(op: DealReplanOp): Promise<boolean>
  /** Založí úkol, pokud stejný (název, řešitel, klient) od `sinceIso` nevznikl. */
  ensureTask(task: TaskDraft, sinceIso: string): Promise<'created' | 'exists'>
  moveActivity(op: ActivityMoveOp): Promise<boolean>
  cancelActivity(op: ActivityCancelOp): Promise<boolean>
}

export type CalendarTokenResult = { ok: true; accessToken: string } | { ok: false; error: string }

export type MeetingCalendarDeps = {
  db: MeetingCalendarDb
  token(memberId: string): Promise<CalendarTokenResult>
  fetchEvent(accessToken: string, eventId: string): Promise<CalendarEventResult>
  now(): Date
}

export type MeetingCalendarOptions = {
  /** Jen schůzky tohoto člena (ruční kontrola s jeho tokenem); jinak všech. */
  memberId?: string | null
  budgetMs?: number
  lookbackDays?: number
  limit?: number
}

export type MeetingCalendarStats = {
  /** Naplánovaných schůzek ke kontrole. */
  meetings: number
  members: number
  /** Schůzek, u kterých Outlook odpověděl. */
  checked: number
  unchanged: number
  moved: number
  cancelled: number
  /** Změna se nepromítla, protože mezitím někdo změnil řádek; zkusí se příště. */
  conflicts: number
  /** Neprověřené (čas, throttling, chybějící přístup). */
  skipped: number
  errors: number
  tasksCreated: number
  milestonesShifted: number
  milestoneTasks: number
  dealsShifted: number
  dealsReplanned: number
  /** Členové bez platného přístupu ke kalendáři. */
  memberErrors: number
  /** Poslední chyba přístupu (stav konektoru); nikdy jméno ani adresa. */
  accessError: string | null
  throttled: boolean
}

export function emptyMeetingCalendarStats(): MeetingCalendarStats {
  return {
    meetings: 0, members: 0, checked: 0, unchanged: 0, moved: 0, cancelled: 0, conflicts: 0, skipped: 0, errors: 0,
    tasksCreated: 0, milestonesShifted: 0, milestoneTasks: 0, dealsShifted: 0, dealsReplanned: 0,
    memberErrors: 0, accessError: null, throttled: false,
  }
}

function observationOf(res: Extract<CalendarEventResult, { kind: 'event' | 'not_found' }>): EventObservation {
  return res.kind === 'not_found'
    ? { kind: 'not_found' }
    : { kind: 'event', start: res.event.start, isCancelled: res.event.isCancelled }
}

/** Jeden běh kontroly. Nevyhazuje kvůli jedné schůzce; chyba načtení seznamu jde nahoru. */
export async function runMeetingCalendarSync(
  deps: MeetingCalendarDeps,
  opts: MeetingCalendarOptions = {},
): Promise<MeetingCalendarStats> {
  const stats = emptyMeetingCalendarStats()
  const startedAt = deps.now().getTime()
  const budgetMs = opts.budgetMs ?? MEETING_CALENDAR_DEFAULTS.budgetMs
  const outOfTime = () => deps.now().getTime() - startedAt > budgetMs
  const lookbackDays = opts.lookbackDays ?? MEETING_CALENDAR_DEFAULTS.lookbackDays

  const meetings = await deps.db.loadPlannedMeetings({
    memberId: opts.memberId ?? null,
    sinceIso: new Date(startedAt - lookbackDays * DAY_MS).toISOString(),
    limit: opts.limit ?? MEETING_CALENDAR_DEFAULTS.limit,
  })
  stats.meetings = meetings.length

  // Událost je v kalendáři toho, kdo schůzku naplánoval — jeho token.
  const byMember = new Map<string, PlannedMeeting[]>()
  for (const m of meetings) {
    if (!m.created_by || !m.ms_event_id) {
      stats.skipped++
      continue
    }
    byMember.set(m.created_by, [...(byMember.get(m.created_by) ?? []), m])
  }

  for (const [memberId, list] of byMember) {
    stats.members++
    if (stats.throttled || outOfTime()) {
      stats.skipped += list.length
      continue
    }
    const token = await deps.token(memberId)
    if (!token.ok) {
      stats.memberErrors++
      stats.accessError = token.error
      stats.skipped += list.length
      continue
    }
    // 1) Stav všech událostí člena z Outlooku.
    const observed: { meeting: PlannedMeeting; res: Extract<CalendarEventResult, { kind: 'event' | 'not_found' }> }[] = []
    // Doběhla kontrola člena celá? Jen pak smí chybějící událost znamenat
    // zrušení (pojistka níž potřebuje vidět všechny jeho schůzky).
    let complete = true
    for (let i = 0; i < list.length; i++) {
      const meeting = list[i]
      if (stats.throttled || outOfTime()) {
        stats.skipped += list.length - i
        complete = false
        break
      }
      const res = await deps.fetchEvent(token.accessToken, meeting.ms_event_id)
      if (res.kind === 'throttled') {
        stats.throttled = true
        stats.skipped += list.length - i
        complete = false
        break
      }
      if (res.kind === 'unauthorized' || res.kind === 'forbidden') {
        stats.memberErrors++
        stats.accessError = res.kind === 'forbidden' ? CALENDAR_FORBIDDEN_ERROR : CALENDAR_UNAUTHORIZED_ERROR
        stats.skipped += list.length - i
        complete = false
        break
      }
      if (res.kind === 'error') {
        stats.errors++
        logError('meetingCalendar.fetch', res.message, { activity: meeting.id, status: res.status })
        complete = false
        continue
      }
      stats.checked++
      observed.push({ meeting, res })
    }

    // 2) Pojistka proti hromadnému „zrušení" (jiný účet v Outlooku).
    const missing = observed.filter((o) => o.res.kind === 'not_found').length
    if (missing >= MASS_MISSING_THRESHOLD && missing === observed.length) {
      stats.memberErrors++
      stats.accessError = CALENDAR_MASS_MISSING_ERROR
      stats.skipped += missing
      continue
    }

    // 3) Změny promítnout. Zrušení podle chybějící události jen po celé
    // kontrole člena; čas hlídá i tahle fáze (maxDuration routy).
    for (let i = 0; i < observed.length; i++) {
      const { meeting, res } = observed[i]
      if (outOfTime()) {
        stats.skipped += observed.length - i
        break
      }
      if (res.kind === 'not_found' && !complete) {
        stats.skipped++
        continue
      }
      const change = detectMeetingChange(meeting, observationOf(res), deps.now())
      if (change.kind === 'none') {
        stats.unchanged++
        continue
      }
      try {
        await applyMeetingChange(deps.db, meeting, change, deps.now(), stats)
      } catch (e) {
        stats.errors++
        logError('meetingCalendar.apply', e instanceof Error ? e.message : 'chyba', { activity: meeting.id, change: change.kind })
      }
    }
  }
  return stats
}

/**
 * Promítne jednu změnu schůzky podle plánu (milník → obchod → úkoly →
 * schůzka). Když podmíněný zápis nesedí (někdo mezitím řádek změnil),
 * skončí bez potvrzení schůzky — příští běh změnu posoudí znovu.
 */
export async function applyMeetingChange(
  db: MeetingCalendarDb,
  meeting: PlannedMeeting,
  change: Exclude<MeetingChange, { kind: 'none' }>,
  now: Date,
  stats: MeetingCalendarStats = emptyMeetingCalendarStats(),
): Promise<'applied' | 'conflict'> {
  const accountId = meeting.account_id
  const [deals, milestone, accountOwnerId] = await Promise.all([
    accountId != null ? db.loadDealCandidates(accountId, followUpStepText(meeting.subject)) : Promise.resolve([]),
    meeting.milestone_id != null ? db.loadMilestone(meeting.milestone_id) : Promise.resolve(null),
    accountId != null ? db.loadAccountOwner(accountId) : Promise.resolve(null),
  ])
  const plan = planMeetingChange({ meeting, change, deals, milestone, accountOwnerId, today: pragueToday(now) })
  const taskSince = new Date(now.getTime() - TASK_DEDUPE_DAYS * DAY_MS).toISOString()

  const conflict = () => {
    stats.conflicts++
    return 'conflict' as const
  }
  for (const op of plan.ops) {
    switch (op.op) {
      case 'milestone_shift':
        if (!(await db.shiftMilestone(op))) return conflict()
        stats.milestonesShifted++
        break
      case 'deal_shift':
        if (!(await db.shiftDeal(op))) return conflict()
        stats.dealsShifted++
        break
      case 'deal_replan':
        if (!(await db.replanDeal(op))) return conflict()
        stats.dealsReplanned++
        break
      case 'task':
        if ((await db.ensureTask(op.task, taskSince)) === 'created') stats.tasksCreated++
        break
      case 'activity_move':
        if (!(await db.moveActivity(op))) return conflict()
        stats.moved++
        break
      case 'activity_cancel':
        if (!(await db.cancelActivity(op))) return conflict()
        stats.cancelled++
        break
    }
  }
  if (plan.milestone === 'task') stats.milestoneTasks++
  return 'applied'
}
