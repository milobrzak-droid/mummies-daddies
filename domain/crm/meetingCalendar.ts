// Naplánované schůzky podle Outlooku — čistá rozhodovací logika, bez I/O.
//
// Schůzka naplánovaná z Cockpitu (domain/crm/actions/planMeeting.ts) je
// událost v Outlooku organizátora a řádek sales_activity (outcome 'planned',
// ms_event_id = id události). Outlook je pravda o termínu: když se tam
// schůzka posune nebo zruší, Cockpit to při kontrole kalendáře
// (domain/crm/meetingCalendarSync.ts) pozná a srovná se sám — nikdo to
// nemusí přepisovat ručně. Tady je jen rozhodnutí, CO se má stát:
//
//   detectMeetingChange  — co Outlook říká oproti Cockpitu (beze změny /
//                          posunuto / zrušeno),
//   planMeetingChange    — seznam zápisů, které změnu promítnou.
//
// PRAVIDLA (planMeetingChange)
//   Posun:
//   * schůzka dostane nový začátek; termín dalšího kontaktu (follow_up_on)
//     se posune o stejný počet dnů;
//   * DALŠÍ KROK OBCHODU, který nastavilo plánování („Follow-up po schůzce
//     …" s termínem = follow_up_on schůzky), se posune taky — je odvozený ze
//     schůzky. Když má krok stejný text, ale jiný termín (člověk ho změnil)
//     a schůzka je teď až po něm, dostane vlastník obchodu úkol ke kontrole;
//   * MILNÍK DODÁVKY (sales_activity.milestone_id, 0085): termín se posune
//     JEN když je převzatý z téhle schůzky (due_from_activity_id) a pořád
//     sedí na původní den. Jinak se nepřepisuje — vlastník milníku dostane
//     úkol „zkontroluj termín milníku" (vysoká priorita, když je schůzka teď
//     až po termínu milníku). Posun v rámci téhož dne termíny dnů nemění.
//   Zrušení:
//   * schůzka se označí jako zrušená (outcome 'cancelled');
//   * odvozený další krok obchodu se přepíše na „Domluvit nový termín
//     schůzky …" s termínem dnes (jinak by obchod dál čekal na follow-up po
//     schůzce, která nebude);
//   * vlastník schůzky (kdo ji naplánoval) dostane úkol „domluv nový termín";
//     patří-li schůzka k milníku, vlastník milníku úkol ke kontrole termínu
//     (je-li to jiný člověk; jinak je to v popisu jednoho úkolu).
//
// OPAKOVÁNÍ: zápisy jdou v pořadí milník → obchod → úkoly → schůzka. Schůzka
// je poslední („potvrzení"); když běh spadne dřív, příští běh změnu uvidí
// znovu. Proto plán pozná už provedený krok (milník i obchod už mají nový
// termín) a úkoly se zakládají jen jednou (stejný název, řešitel a klient).
import { COMPANY } from '@/config'
import { addDaysToPragueDay, daysBetweenPragueDays, pragueDayOf } from '@/lib/pragueDate'

const timeFmt = new Intl.DateTimeFormat('cs-CZ', { timeZone: COMPANY.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

/** Pražský čas „09:30" z ISO okamžiku (stejný tvar jako clockTime na obrazovce Dnes). */
function clockTime(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : timeFmt.format(d)
}

/** Úloha = klíč zámku (job_lock, 0040) i aktér zápisů v auditu. */
export const CALENDAR_SYNC_JOB = 'calendar-sync'
/** Zámek drží déle než nejdelší běh (cron i tlačítko mají maxDuration 60 s). */
export const CALENDAR_SYNC_TTL_SECONDS = 90
/** Řádek connector_state; stejný jako plánování schůzek a zápis úkolů do kalendáře. */
export const CALENDAR_SYNC_CONNECTOR = 'graph_calendar'
/** Aktér v audit_event ('system:calendar-sync'). */
export const CALENDAR_SYNC_ACTOR = { type: 'system', id: CALENDAR_SYNC_JOB } as const

/** Rozdíl začátku, od kterého je schůzka „posunutá" (Outlook drží minuty). */
export const MOVE_THRESHOLD_MS = 60_000

/**
 * Denní kontrola v cronu /api/cron/follow-ups (route je zapnutá jen
 * s FOLLOWUP_WATCH_ENABLED=true) běží, dokud ji někdo výslovně nevypne
 * (CALENDAR_SYNC_ENABLED=false). Jen čte kalendář (Calendars.ReadWrite
 * Cockpit má) a mění jen schůzky naplánované z Cockpitu.
 */
export function calendarSyncEnabledFromEnv(env: Record<string, string | undefined>): boolean {
  return env.CALENDAR_SYNC_ENABLED !== 'false'
}

/** Milník v koncovém stavu už termín nehlídá. */
const FINAL_MILESTONE_STATUSES = new Set(['prijato', 'uzavreno'])

const SUBJECT_MAX = 80
const MILESTONE_TITLE_MAX = 60
const TASK_TITLE_MAX = 300

const clip = (s: string, n: number) => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1).trimEnd()}…` : t
}

// ---------------------------------------------------------------------------
// Texty sdílené s plánováním schůzky

/** Další krok obchodu, který nastaví naplánování schůzky (planMeeting). */
export function followUpStepText(subject: string): string {
  return `Follow-up po schůzce „${subject}"`
}

/** Další krok obchodu po zrušení schůzky, která ho určovala. */
export function rescheduleStepText(subject: string): string {
  return `Domluvit nový termín schůzky „${subject}"`
}

const WEEKDAY = ['ne', 'po', 'út', 'st', 'čt', 'pá', 'so']

/** „2. 10." z YYYY-MM-DD. */
export function shortDayLabel(day: string): string {
  return `${Number(day.slice(8, 10))}. ${Number(day.slice(5, 7))}.`
}

/** „čt 2. 10. 14:00" (pražský čas) z ISO okamžiku. */
export function meetingWhenLabel(iso: string): string {
  const day = pragueDayOf(iso)
  const dow = new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10))).getUTCDay()
  return `${WEEKDAY[dow]} ${shortDayLabel(day)} ${clockTime(iso)}`
}

// ---------------------------------------------------------------------------
// Co Outlook říká

export type PlannedMeeting = {
  id: number
  account_id: number | null
  subject: string
  /** Začátek podle Cockpitu (ISO). */
  occurred_at: string
  /** Termín dalšího kontaktu (YYYY-MM-DD), který nastavilo plánování. */
  follow_up_on: string | null
  ms_event_id: string
  /** Kdo schůzku naplánoval = v čím kalendáři událost je = vlastník schůzky. */
  created_by: string | null
  /** Milník dodávky, ke kterému schůzka patří (0085); bez migrace null. */
  milestone_id: number | null
}

export type EventObservation =
  | { kind: 'event'; start: string; isCancelled: boolean }
  /** Událost v kalendáři organizátora není (Graph 404). */
  | { kind: 'not_found' }

export type MeetingChange =
  | { kind: 'none' }
  | { kind: 'moved'; from: string; to: string }
  | { kind: 'cancelled'; reason: 'cancelled' | 'deleted' }

/**
 * Posunutá, zrušená, nebo beze změny? Smazaná událost (404) znamená zrušení
 * jen u schůzky, která ještě nezačala — minulou schůzku organizátor klidně
 * smaže až po ní, a to zrušení není. Výslovně zrušená (isCancelled) platí vždy.
 */
export function detectMeetingChange(meeting: PlannedMeeting, observed: EventObservation, now: Date): MeetingChange {
  const planned = Date.parse(meeting.occurred_at)
  if (observed.kind === 'not_found') {
    return Number.isFinite(planned) && planned > now.getTime() ? { kind: 'cancelled', reason: 'deleted' } : { kind: 'none' }
  }
  if (observed.isCancelled) return { kind: 'cancelled', reason: 'cancelled' }
  const actual = Date.parse(observed.start)
  if (!Number.isFinite(actual) || !Number.isFinite(planned)) return { kind: 'none' }
  if (Math.abs(actual - planned) < MOVE_THRESHOLD_MS) return { kind: 'none' }
  return { kind: 'moved', from: meeting.occurred_at, to: new Date(actual).toISOString() }
}

// ---------------------------------------------------------------------------
// Co se má stát

export type DealCandidate = {
  id: number
  owner_id: string | null
  next_step: string | null
  next_step_due: string | null
}

export type MilestoneContext = {
  id: number
  title: string
  status: string
  due_on: string | null
  due_from_activity_id: number | null
  owner_id: string | null
  deputy_id: string | null
  engagement_id: number
  /** Vlastník dodávky — když milník vlastníka nemá. */
  engagement_owner_id: string | null
}

export type TaskDraft = {
  title: string
  description: string
  priority: 'normal' | 'high'
  assignee_id: string | null
  due_on: string
  account_id: number | null
  deal_id: number | null
  engagement_id: number | null
}

export type ChangeOp =
  | { op: 'milestone_shift'; milestoneId: number; activityId: number; fromDay: string; toDay: string }
  | { op: 'deal_shift'; dealId: number; stepText: string; fromDue: string; toDue: string }
  | { op: 'deal_replan'; dealId: number; fromText: string; fromDue: string; text: string; due: string }
  | { op: 'task'; task: TaskDraft }
  | {
    op: 'activity_move'; activityId: number; from: string; to: string
    followUpFrom: string | null; followUpTo: string | null
  }
  | { op: 'activity_cancel'; activityId: number }

export type ChangePlan = {
  ops: ChangeOp[]
  milestone: 'shifted' | 'already_shifted' | 'task' | 'none'
  deals: { shifted: number; replanned: number; flagged: number }
}

export type PlanInput = {
  meeting: PlannedMeeting
  change: Exclude<MeetingChange, { kind: 'none' }>
  /** Otevřené obchody klienta s dalším krokem followUpStepText(meeting.subject). */
  deals: readonly DealCandidate[]
  /** Milník schůzky (jen když má schůzka milestone_id a milník existuje). */
  milestone: MilestoneContext | null
  accountOwnerId: string | null
  /** Pražský dnešek (YYYY-MM-DD) — termín úkolů. */
  today: string
}

function milestoneOwner(m: MilestoneContext, fallback: string | null): string | null {
  return m.owner_id ?? m.deputy_id ?? m.engagement_owner_id ?? fallback
}

const openMilestone = (m: MilestoneContext | null): m is MilestoneContext => !!m && !FINAL_MILESTONE_STATUSES.has(m.status)

/** Seznam zápisů pro jednu změnu schůzky (pořadí = pořadí provedení, schůzka poslední). */
export function planMeetingChange(input: PlanInput): ChangePlan {
  return input.change.kind === 'moved'
    ? planMove(input, input.change)
    : planCancel(input, input.change.reason)
}

function planMove(input: PlanInput, change: { from: string; to: string }): ChangePlan {
  const { meeting, today } = input
  const subject = clip(meeting.subject, SUBJECT_MAX)
  const owner = meeting.created_by ?? input.accountOwnerId
  const fromDay = pragueDayOf(change.from)
  const toDay = pragueDayOf(change.to)
  const dayDelta = daysBetweenPragueDays(fromDay, toDay)
  const followUpFrom = meeting.follow_up_on
  const followUpTo = followUpFrom ? addDaysToPragueDay(followUpFrom, dayDelta) : null
  const ops: ChangeOp[] = []
  const tasks: TaskDraft[] = []
  let milestoneState: ChangePlan['milestone'] = 'none'
  const deals = { shifted: 0, replanned: 0, flagged: 0 }

  // ---- milník dodávky
  const m = input.milestone
  if (openMilestone(m) && dayDelta !== 0) {
    const derived = m.due_from_activity_id === meeting.id
    if (derived && m.due_on === fromDay) {
      ops.push({ op: 'milestone_shift', milestoneId: m.id, activityId: meeting.id, fromDay, toDay })
      milestoneState = 'shifted'
    } else if (derived && m.due_on === toDay) {
      milestoneState = 'already_shifted'
    } else {
      const risk = m.due_on != null && toDay > m.due_on
      const lines = [
        `Schůzka byla naplánovaná na ${meetingWhenLabel(change.from)}, v Outlooku je teď ${meetingWhenLabel(change.to)}.`,
        m.due_on
          ? `Termín milníku (${shortDayLabel(m.due_on)}) Cockpit nezměnil — nebyl převzatý ze schůzky.`
          : 'Milník nemá termín.',
      ]
      if (risk) lines.push('Schůzka je teď až po termínu milníku.')
      tasks.push({
        // Úkoly vidí celý tým (task), schůzky jen obchod — proto bez předmětu schůzky.
        title: clip(`Schůzka k milníku „${clip(m.title, MILESTONE_TITLE_MAX)}“ se posunula na ${meetingWhenLabel(change.to)} – zkontroluj termín milníku`, TASK_TITLE_MAX),
        description: lines.join('\n'),
        priority: risk ? 'high' : 'normal',
        assignee_id: milestoneOwner(m, owner),
        due_on: today,
        account_id: meeting.account_id,
        deal_id: null,
        engagement_id: m.engagement_id,
      })
      milestoneState = 'task'
    }
  }

  // ---- další krok obchodu
  const stepText = followUpStepText(meeting.subject)
  for (const d of input.deals) {
    if (d.next_step !== stepText) continue
    if (followUpFrom && followUpTo && d.next_step_due === followUpFrom) {
      if (followUpTo !== followUpFrom) {
        ops.push({ op: 'deal_shift', dealId: d.id, stepText, fromDue: followUpFrom, toDue: followUpTo })
        deals.shifted++
      }
    } else if (followUpTo && d.next_step_due === followUpTo) {
      // Už posunuto (opakovaný běh po pádu).
    } else if (dayDelta !== 0 && d.next_step_due && toDay > d.next_step_due) {
      tasks.push({
        title: clip(`Schůzka „${subject}“ se posunula na ${meetingWhenLabel(change.to)} – zkontroluj další krok obchodu (termín ${shortDayLabel(d.next_step_due)})`, TASK_TITLE_MAX),
        description: [
          `Schůzka byla naplánovaná na ${meetingWhenLabel(change.from)}, v Outlooku je teď ${meetingWhenLabel(change.to)}.`,
          'Termín dalšího kroku obchodu někdo změnil ručně, proto ho Cockpit neposunul. Schůzka je teď až po něm.',
        ].join('\n'),
        priority: 'normal',
        assignee_id: d.owner_id ?? owner,
        due_on: today,
        account_id: meeting.account_id,
        deal_id: d.id,
        engagement_id: null,
      })
      deals.flagged++
    }
  }

  for (const task of tasks) ops.push({ op: 'task', task })
  ops.push({ op: 'activity_move', activityId: meeting.id, from: change.from, to: change.to, followUpFrom, followUpTo })
  return { ops, milestone: milestoneState, deals }
}

function planCancel(input: PlanInput, reason: 'cancelled' | 'deleted'): ChangePlan {
  const { meeting, today } = input
  const subject = clip(meeting.subject, SUBJECT_MAX)
  const owner = meeting.created_by ?? input.accountOwnerId
  const ops: ChangeOp[] = []
  const deals = { shifted: 0, replanned: 0, flagged: 0 }
  const stepText = followUpStepText(meeting.subject)

  const lines = [
    reason === 'deleted'
      ? 'Naplánovaná schůzka v Outlooku už není — organizátor ji zrušil nebo smazal.'
      : 'Schůzka je v Outlooku zrušená.',
    'V Cockpitu je označená jako zrušená.',
  ]
  let dealId: number | null = null
  for (const d of input.deals) {
    if (d.next_step !== stepText) continue
    dealId ??= d.id
    if (meeting.follow_up_on && d.next_step_due === meeting.follow_up_on) {
      ops.push({ op: 'deal_replan', dealId: d.id, fromText: stepText, fromDue: meeting.follow_up_on, text: rescheduleStepText(meeting.subject), due: today })
      deals.replanned++
    } else {
      deals.flagged++
    }
  }
  if (deals.replanned > 0) lines.push(`Další krok obchodu je teď: ${rescheduleStepText(subject)} (termín dnes).`)
  if (deals.flagged > 0) lines.push('Další krok obchodu počítal s touhle schůzkou — zkontroluj ho.')

  const m = input.milestone
  const tasks: TaskDraft[] = []
  let milestoneState: ChangePlan['milestone'] = 'none'
  if (openMilestone(m)) {
    milestoneState = 'task'
    const mOwner = milestoneOwner(m, owner)
    const dueText = m.due_on ? ` s termínem ${shortDayLabel(m.due_on)}` : ''
    if (mOwner && mOwner !== owner) {
      tasks.push({
        title: clip(`Schůzka k milníku „${clip(m.title, MILESTONE_TITLE_MAX)}“ byla zrušena – zkontroluj termín milníku`, TASK_TITLE_MAX),
        description: [
          `Schůzka naplánovaná na ${meetingWhenLabel(meeting.occurred_at)} byla v Outlooku zrušena.`,
          `Milník${dueText} Cockpit nezměnil.`,
        ].join('\n'),
        priority: 'high',
        assignee_id: mOwner,
        due_on: today,
        account_id: meeting.account_id,
        deal_id: null,
        engagement_id: m.engagement_id,
      })
    } else {
      lines.push(`Schůzka patřila k milníku „${clip(m.title, MILESTONE_TITLE_MAX)}“${dueText} — zkontroluj jeho termín.`)
    }
  }

  tasks.unshift({
    title: clip(`Schůzka „${subject}“ (${meetingWhenLabel(meeting.occurred_at)}) byla v Outlooku zrušena – domluv nový termín`, TASK_TITLE_MAX),
    description: lines.join('\n'),
    priority: 'high',
    assignee_id: owner,
    due_on: today,
    account_id: meeting.account_id,
    deal_id: dealId,
    engagement_id: openMilestone(m) && milestoneOwner(m, owner) === owner ? m.engagement_id : null,
  })

  for (const task of tasks) ops.push({ op: 'task', task })
  ops.push({ op: 'activity_cancel', activityId: meeting.id })
  return { ops, milestone: milestoneState, deals }
}

// ---------------------------------------------------------------------------
// Souhrn běhu pro člověka

/** Výsledek ruční kontroly (tlačítko na /schuzky, Nastavení). */
export type CalendarCheckResult = { ok: true; summary: string; changed: boolean } | { ok: false; error: string }

export type CalendarSyncSummaryInput = {
  checked: number
  moved: number
  cancelled: number
  tasksCreated: number
  milestonesShifted: number
  dealsShifted: number
  skipped: number
  errors: number
}

const plural = (n: number, one: string, few: string, many: string) =>
  n === 1 ? one : n >= 2 && n <= 4 ? few : many

/** Jedna věta o výsledku kontroly kalendáře (tlačítko, Nastavení). */
export function formatCalendarSyncSummary(s: CalendarSyncSummaryInput): string {
  if (s.checked === 0 && s.skipped === 0 && s.errors === 0) return 'Žádná naplánovaná schůzka ke kontrole.'
  const parts: string[] = []
  if (s.moved === 0 && s.cancelled === 0) {
    parts.push(`Zkontrolováno ${s.checked} ${plural(s.checked, 'schůzka', 'schůzky', 'schůzek')}, v Outlooku beze změny.`)
  } else {
    const bits: string[] = []
    if (s.moved > 0) bits.push(`${s.moved} ${plural(s.moved, 'posunutá', 'posunuté', 'posunutých')}`)
    if (s.cancelled > 0) bits.push(`${s.cancelled} ${plural(s.cancelled, 'zrušená', 'zrušené', 'zrušených')}`)
    parts.push(`Zkontrolováno ${s.checked} ${plural(s.checked, 'schůzka', 'schůzky', 'schůzek')}: ${bits.join(', ')}.`)
    const effects: string[] = []
    if (s.milestonesShifted > 0) effects.push(`posunuté termíny milníků: ${s.milestonesShifted}`)
    if (s.dealsShifted > 0) effects.push(`posunuté další kroky obchodů: ${s.dealsShifted}`)
    if (s.tasksCreated > 0) effects.push(`nové úkoly: ${s.tasksCreated}`)
    if (effects.length > 0) parts.push(`${effects.join(', ')}.`.replace(/^./, (c) => c.toUpperCase()))
  }
  if (s.skipped > 0 || s.errors > 0) parts.push('Některé schůzky se teď zkontrolovat nepodařilo, zkusí se to znovu při příští kontrole.')
  return parts.join(' ')
}
