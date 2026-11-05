// Follow-up hlídač v Loop Core (kapitola 7 plánu přestavby: Loop Core
// „vstřebá dnešní follow-up hlídač, který je postavený, ale nikdy se
// nespustil").
//
// PROČ: dueFollowUps (domain/crm/followUp.ts) umí říct, u kterého obchodu
// uplynul termín dalšího kroku a nic se nestalo, ale neměl plánovač ani kam
// výsledek zapsat. Loop Core (migrace 0039) je místo, kde systém drží, co se
// má stát dál. Tenhle modul z výsledků dueFollowUps rozhoduje, co s případy
// udělat; denní běh obstarává worker/followUpWatch.ts (runJob
// 'follow-up-watch') přes cron app/api/cron/follow-ups.
//
// PRAVIDLA (čistá funkce planFollowUpWatch):
// - Případ vzniká jen pro ESKALOVANÝ follow-up (level 'manager', tedy
//   ESCALATE_AFTER_DAYS po termínu). Uzel z konfigurace firmy
//   (COMPANY.followUpNode), název „Follow-up: <obchod>", vazba na obchod
//   a firmu, vlastník = vlastník obchodu (bez něj vlastník uzlu z loop_node),
//   jeden krok „Ozvat se klientovi".
// - Jeden aktivní případ na obchod. Svůj případ hlídač pozná podle
//   created_by = FOLLOW_UP_WATCH_ACTOR. Člověk tuhle hodnotu zapsat nemůže:
//   trigger work_case_guard (0057) přihlášenému vynutí 'user:<uuid>'.
// - „Epizoda" = termín follow-upu (deal.next_step_due). Krok nese konec
//   pražského dne toho termínu v due_at. Když člověk v téže epizodě krok
//   nebo celý případ uzavřel, hlídač ho znovu neotevírá — rozhodnutí člověka
//   má přednost. Nový termín = nová epizoda.
// - Dokud follow-up visí (i neeskalovaný po posunu termínu), hlídač jen
//   srovná název, vlastníka, firmu a termín kroku s obchodem. Vlastníka drží
//   obchod: chce-li někdo jiného, mění vlastníka obchodu.
// - Vyřešený follow-up (aktivita po termínu, termín posunutý do budoucna nebo
//   smazaný, obchod uzavřený či smazaný) = krok „Ozvat se klientovi" se
//   uzavře jako hotový (todo → doing → done; přechody hlídá i trigger 0057).
//   Když pak případ nemá nic dalšího rozpracovaného (všechny kroky konečné,
//   aspoň jeden hotový, žádné otevřené rozhodnutí ani čekající schválení),
//   uzavře se i případ (→ in_progress → done). Jinak zůstává pro člověka.
// - Značky follow_up_nudged_on / follow_up_escalated_on (připomínka dnes už
//   odešla) hlídač ignoruje: odeslaná připomínka neznamená, že se klientovi
//   někdo ozval.
//
// Obchod je obchodní údaj (0058): do případu jde jen název obchodu, žádná
// částka ani fáze. Název obchodu u případu smí vidět každý člen týmu (stejné
// rozhodnutí jako getWorkCase v core/loopQueries.ts).

import { COMPANY } from '@/config'
import {
  caseCloseIssues,
  isCaseStatus,
  isStepStatus,
  isTerminalCase,
  isTerminalStep,
  nextCaseStatuses,
  nextStepStatuses,
  type CaseStatus,
  type StepStatus,
} from '@/core/workCase'
import { nextStepPosition, pragueDayEnd } from '@/core/workCaseFlow'
import { logError } from '@/lib/log'
import { dueFollowUps, type FollowUpDeal, type Nudge } from './followUp'

/** Jméno úlohy = klíč zámku v job_lock (0040). */
export const FOLLOW_UP_WATCH_JOB = 'follow-up-watch'
/** Aktér systémového zápisu ('system:<job>', viz 0039 a 0057). */
export const FOLLOW_UP_WATCH_ACTOR = `system:${FOLLOW_UP_WATCH_JOB}` as const
/** Řádek v connector_state — čerstvost a poslední chyba hlídače. */
export const FOLLOW_UP_WATCH_CONNECTOR = 'follow_up_watch'
export const FOLLOW_UP_NODE = COMPANY.followUpNode
export const FOLLOW_UP_STEP_TITLE = 'Ozvat se klientovi'
export const FOLLOW_UP_MISSING_MIGRATION =
  'Pracovní případy čekají na migraci 0039 — follow-up hlídač nic nezaložil.'

const CASE_TITLE_PREFIX = 'Follow-up: '
// CHECK work_case_title_check: 1–300 znaků.
const CASE_TITLE_MAX = 300

export function followUpCaseTitle(dealTitle: string | null | undefined, dealId: number): string {
  const t = (dealTitle ?? '').trim() || `obchod #${dealId}`
  return (CASE_TITLE_PREFIX + t).slice(0, CASE_TITLE_MAX)
}

// --- Tvary dat ----------------------------------------------------------------

export type WatchDeal = FollowUpDeal & { account_id: number | null }

export type WatchStep = {
  id: number
  title: string
  status: string
  due_at: string | null
  position: number
}

export type WatchCase = {
  id: number
  deal_id: number | null
  title: string
  status: string
  lead_owner_id: string | null
  deputy_id: string | null
  account_id: number | null
  steps: readonly WatchStep[]
  open_decisions: number
  pending_approvals: number
}

/** Nový případ. created_by výslovně: DEFAULT loop_actor() bez přihlášeného uživatele selže. */
export type NewCaseRow = {
  title: string
  node: typeof FOLLOW_UP_NODE
  status: 'open'
  lead_owner_id: string | null
  account_id: number | null
  deal_id: number
  created_by: typeof FOLLOW_UP_WATCH_ACTOR
}

export type NewStepRow = {
  title: string
  position: number
  status: 'todo'
  due_at: string
}

export type CasePatch = Partial<{ title: string; lead_owner_id: string; account_id: number }>

export type StepChange =
  | { op: 'insert'; row: NewStepRow }
  | { op: 'reschedule'; step_id: number; due_at: string }

export type StatusMove<S extends string> = { from: S; path: S[] }

export type NoopReason =
  /** Případ odpovídá obchodu, není co měnit. */
  | 'up_to_date'
  /** Člověk v téže epizodě krok nebo případ uzavřel. */
  | 'closed_in_episode'
  /** Follow-up je vyřešený, ale případ má další rozpracovanou práci. */
  | 'resolved_case_busy'
  /** Druhý aktivní případ téhož obchodu (nemá nastat) — hlídač na něj nesahá. */
  | 'duplicate'

export type WatchAction =
  | { kind: 'open'; deal_id: number; case: NewCaseRow; step: NewStepRow }
  | { kind: 'update'; deal_id: number; case_id: number; patch: CasePatch; step: StepChange | null }
  | {
      kind: 'close'
      /** null = obchod byl smazán (work_case.deal_id ON DELETE SET NULL, 0039). */
      deal_id: number | null
      case_id: number
      steps: (StatusMove<StepStatus> & { step_id: number })[]
      /** null = případ zůstává otevřený (má další práci). */
      case_move: StatusMove<CaseStatus> | null
    }
  | { kind: 'noop'; deal_id: number | null; case_id: number | null; reason: NoopReason }

// --- Pomocníci ------------------------------------------------------------------

// Nejkratší cesta po povolených přechodech (BFS). Přechody jsou ty z
// core/workCase.ts, které zrcadlí triggery 0057 — hlídač je nesmí obcházet.
function shortestPath<S extends string>(from: S, to: S, next: (s: S) => readonly S[]): S[] | null {
  if (from === to) return []
  const prev = new Map<S, S>()
  const seen = new Set<S>([from])
  const queue: S[] = [from]
  while (queue.length > 0) {
    const s = queue.shift() as S
    for (const n of next(s)) {
      if (seen.has(n)) continue
      seen.add(n)
      prev.set(n, s)
      if (n === to) {
        const path: S[] = [n]
        for (let p = s; p !== from; p = prev.get(p) as S) path.unshift(p)
        return path
      }
      queue.push(n)
    }
  }
  return null
}

/** Cesta kroku do done (todo → doing → done); null = z konečného stavu nejde. */
export function stepPathToDone(from: StepStatus): StepStatus[] | null {
  return shortestPath(from, 'done', nextStepStatuses)
}

/** Cesta případu do done (open → in_progress → done); null = z konečného stavu nejde. */
export function casePathToDone(from: CaseStatus): CaseStatus[] | null {
  return shortestPath(from, 'done', nextCaseStatuses)
}

const sameInstant = (a: string | null, b: string): boolean =>
  a !== null && !Number.isNaN(Date.parse(a)) && Date.parse(a) === Date.parse(b)

const isActiveStep = (s: WatchStep): boolean => isStepStatus(s.status) && !isTerminalStep(s.status)
const isActiveCase = (c: WatchCase): boolean => isCaseStatus(c.status) && !isTerminalCase(c.status)
const ourSteps = (c: WatchCase): WatchStep[] =>
  c.steps.filter((s) => s.title === FOLLOW_UP_STEP_TITLE).sort((a, b) => a.id - b.id)

/** Termín epizody: konec pražského dne termínu follow-upu jako ISO okamžik. */
export function episodeDueAt(due: string): string {
  return pragueDayEnd(due).toISOString()
}

/**
 * Visící follow-upy podle dueFollowUps, bez ohledu na značky odeslaných
 * připomínek (ty patří doručení, ne stavu follow-upu).
 */
export function pendingFollowUps(deals: readonly WatchDeal[], now: Date): Map<number, Nudge> {
  const unmarked = deals.map((d) => ({ ...d, follow_up_nudged_on: null, follow_up_escalated_on: null }))
  return new Map(dueFollowUps(unmarked, now).map((n) => [n.deal_id, n]))
}

/** Eskalované obchody bez aktivního případu hlídače — pro ně se dočítá historie. */
export function escalatedDealsWithoutCase(
  deals: readonly WatchDeal[],
  activeCases: readonly WatchCase[],
  now: Date,
): number[] {
  const withCase = new Set(activeCases.filter(isActiveCase).map((c) => c.deal_id))
  return [...pendingFollowUps(deals, now).values()]
    .filter((n) => n.level === 'manager' && !withCase.has(n.deal_id))
    .map((n) => n.deal_id)
    .sort((a, b) => a - b)
}

function byDeal(cases: readonly WatchCase[]): Map<number, WatchCase[]> {
  const out = new Map<number, WatchCase[]>()
  for (const c of cases) {
    if (c.deal_id === null) continue
    const list = out.get(c.deal_id) ?? []
    list.push(c)
    out.set(c.deal_id, list)
  }
  for (const list of out.values()) list.sort((a, b) => a.id - b.id)
  return out
}

// --- Rozhodnutí -----------------------------------------------------------------

export type WatchPlanInput = {
  deals: readonly WatchDeal[]
  /** Aktivní (open/in_progress/waiting) případy hlídače. */
  activeCases: readonly WatchCase[]
  /** Uzavřené případy hlídače u eskalovaných obchodů bez aktivního případu. */
  closedCases?: readonly WatchCase[]
  /** Vlastník uzlu followUpNode (loop_node) — záloha, když obchod nemá vlastníka. */
  nodeOwnerId: string | null
  now: Date
}

function planResolved(dealId: number | null, c: WatchCase): WatchAction {
  const steps: (StatusMove<StepStatus> & { step_id: number })[] = []
  for (const s of ourSteps(c)) {
    if (!isActiveStep(s)) continue
    const from = s.status as StepStatus
    const path = stepPathToDone(from)
    if (path) steps.push({ step_id: s.id, from, path })
  }
  const closing = new Set(steps.map((s) => s.step_id))
  const after = c.steps.map((s) => ({ status: closing.has(s.id) ? 'done' : s.status }))

  let caseMove: StatusMove<CaseStatus> | null = null
  if (
    isCaseStatus(c.status)
    && after.every((s) => isStepStatus(s.status))
    // Pravidlo kroků z caseCloseIssues (a triggeru 0057) — výchozí stav
    // 'in_progress', protože cestu případu do done řeší casePathToDone.
    && caseCloseIssues('in_progress', after as { status: StepStatus }[]).length === 0
    && c.open_decisions === 0
    && c.pending_approvals === 0
  ) {
    const path = casePathToDone(c.status)
    if (path) caseMove = { from: c.status, path }
  }

  if (steps.length === 0 && caseMove === null) {
    return { kind: 'noop', deal_id: dealId, case_id: c.id, reason: 'resolved_case_busy' }
  }
  return { kind: 'close', deal_id: dealId, case_id: c.id, steps, case_move: caseMove }
}

function planPending(
  deal: WatchDeal,
  nudge: Nudge,
  current: WatchCase | null,
  closed: readonly WatchCase[],
  nodeOwnerId: string | null,
): WatchAction {
  const dueAt = episodeDueAt(nudge.due)
  const title = followUpCaseTitle(deal.title, deal.id)
  const owner = deal.owner_id ?? nodeOwnerId

  if (!current) {
    const closedInEpisode = closed.some((c) => ourSteps(c).some((s) => sameInstant(s.due_at, dueAt)))
    if (closedInEpisode) return { kind: 'noop', deal_id: deal.id, case_id: null, reason: 'closed_in_episode' }
    return {
      kind: 'open',
      deal_id: deal.id,
      case: {
        title,
        node: FOLLOW_UP_NODE,
        status: 'open',
        lead_owner_id: owner,
        account_id: deal.account_id,
        deal_id: deal.id,
        created_by: FOLLOW_UP_WATCH_ACTOR,
      },
      step: { title: FOLLOW_UP_STEP_TITLE, position: 1, status: 'todo', due_at: dueAt },
    }
  }

  const patch: CasePatch = {}
  if (current.title !== title) patch.title = title
  // Nic nemažeme: obchod bez firmy / bez vlastníka nechá případu, co má.
  if (deal.account_id !== null && current.account_id !== deal.account_id) patch.account_id = deal.account_id
  // Vlastník nesmí být zároveň zástupcem (CHECK work_case_deputy_differs);
  // zástupce nastavil člověk, takže tady ustupuje hlídač.
  if (owner !== null && owner !== current.lead_owner_id && owner !== current.deputy_id) {
    patch.lead_owner_id = owner
  }

  let step: StepChange | null = null
  const ours = ourSteps(current)
  // Krok této epizody už existuje (v jakémkoli stavu) = nic nepřidávat;
  // uzavřel-li ho člověk, platí jeho rozhodnutí.
  if (!ours.some((s) => sameInstant(s.due_at, dueAt))) {
    const active = ours.find(isActiveStep)
    if (active) step = { op: 'reschedule', step_id: active.id, due_at: dueAt }
    else if (nudge.level === 'manager') {
      step = {
        op: 'insert',
        row: { title: FOLLOW_UP_STEP_TITLE, position: nextStepPosition(current.steps), status: 'todo', due_at: dueAt },
      }
    }
  }

  if (Object.keys(patch).length === 0 && step === null) {
    return { kind: 'noop', deal_id: deal.id, case_id: current.id, reason: 'up_to_date' }
  }
  return { kind: 'update', deal_id: deal.id, case_id: current.id, patch, step }
}

/**
 * Co udělat s případy hlídače. Čistá funkce: stejný vstup = stejný plán,
 * a plán aplikovaný na data dá při dalším běhu samé 'noop' (idempotence).
 */
export function planFollowUpWatch(input: WatchPlanInput): WatchAction[] {
  const pending = pendingFollowUps(input.deals, input.now)
  const dealById = new Map(input.deals.map((d) => [d.id, d]))
  const active = byDeal(input.activeCases.filter(isActiveCase))
  const closed = byDeal(input.closedCases ?? [])

  const dealIds = new Set<number>(active.keys())
  for (const n of pending.values()) if (n.level === 'manager') dealIds.add(n.deal_id)

  const actions: WatchAction[] = []
  // Smazaný obchod: FK work_case.deal_id je ON DELETE SET NULL (0039), takže
  // případ hlídače zůstane bez obchodu. Smazaný obchod = vyřešený follow-up,
  // proto každý takový aktivní případ (klíčem je id případu) uzavíráme.
  const orphans = input.activeCases
    .filter((c) => c.deal_id === null && isActiveCase(c))
    .sort((a, b) => a.id - b.id)
  for (const c of orphans) actions.push(planResolved(null, c))

  for (const dealId of [...dealIds].sort((a, b) => a - b)) {
    const [current = null, ...duplicates] = active.get(dealId) ?? []
    for (const d of duplicates) actions.push({ kind: 'noop', deal_id: dealId, case_id: d.id, reason: 'duplicate' })

    const nudge = pending.get(dealId)
    const deal = dealById.get(dealId)
    if (!nudge || !deal) {
      // Obchod mezi visícími není (vyřešeno, uzavřeno, smazáno). Sem se
      // dostane jen obchod s aktivním případem.
      if (current) actions.push(planResolved(dealId, current))
      continue
    }
    actions.push(planPending(deal, nudge, current, closed.get(dealId) ?? [], input.nodeOwnerId))
  }
  return actions
}

// --- Běh nad vstříknutou databází ---------------------------------------------

export interface FollowUpWatchDb {
  /** Otevřené obchody s termínem. Chyba = výjimka (nikdy „nic není po termínu"). */
  loadDeals(): Promise<WatchDeal[]>
  loadNodeOwner(node: string): Promise<string | null>
  /** Aktivní případy hlídače; null = tabulky Loop Core chybí (0039 neběžela). */
  loadActiveCases(actor: string): Promise<WatchCase[] | null>
  loadClosedCases(actor: string, dealIds: readonly number[]): Promise<WatchCase[]>
  insertCase(row: NewCaseRow): Promise<number>
  /** Úklid po nepovedeném založení kroku (open → cancelled). */
  cancelCase(caseId: number): Promise<void>
  updateCase(caseId: number, patch: CasePatch): Promise<void>
  insertStep(caseId: number, row: NewStepRow): Promise<void>
  rescheduleStep(stepId: number, dueAt: string): Promise<void>
  /** Přechod s pojistkou na výchozí stav; false = mezitím změnil někdo jiný. */
  setStepStatus(stepId: number, from: StepStatus, to: StepStatus): Promise<boolean>
  setCaseStatus(caseId: number, from: CaseStatus, to: CaseStatus): Promise<boolean>
}

export type FollowUpWatchStats = {
  state: 'ok' | 'missing_migration'
  deals_checked: number
  escalated: number
  opened: number
  updated: number
  closed_steps: number
  closed_cases: number
  unchanged: number
  failed: number
  /** Krátké chyby jen s id obchodu (žádné názvy — princip „ids, ne těla"). */
  errors: string[]
}

const MAX_REPORTED_ERRORS = 5

function emptyStats(state: FollowUpWatchStats['state']): FollowUpWatchStats {
  return {
    state, deals_checked: 0, escalated: 0, opened: 0, updated: 0,
    closed_steps: 0, closed_cases: 0, unchanged: 0, failed: 0, errors: [],
  }
}

async function walk<S extends string>(
  move: StatusMove<S>,
  set: (from: S, to: S) => Promise<boolean>,
  what: string,
): Promise<void> {
  let from = move.from
  for (const to of move.path) {
    if (!(await set(from, to))) throw new Error(`${what} mezitím změnil někdo jiný`)
    from = to
  }
}

async function apply(db: FollowUpWatchDb, a: WatchAction, stats: FollowUpWatchStats): Promise<void> {
  switch (a.kind) {
    case 'noop':
      stats.unchanged++
      return
    case 'open': {
      const caseId = await db.insertCase(a.case)
      try {
        await db.insertStep(caseId, a.step)
      } catch (e) {
        // Případ bez kroku nenecháváme viset; zrušený případ bez kroku
        // epizody příští běh založí znovu.
        await db.cancelCase(caseId).catch((err: unknown) => logError('followUpWatch.cancel', err, { caseId }))
        throw e
      }
      stats.opened++
      return
    }
    case 'update':
      if (Object.keys(a.patch).length > 0) await db.updateCase(a.case_id, a.patch)
      if (a.step?.op === 'insert') await db.insertStep(a.case_id, a.step.row)
      if (a.step?.op === 'reschedule') await db.rescheduleStep(a.step.step_id, a.step.due_at)
      stats.updated++
      return
    case 'close':
      for (const s of a.steps) {
        await walk(s, (from, to) => db.setStepStatus(s.step_id, from, to), `krok ${s.step_id}`)
        stats.closed_steps++
      }
      if (a.case_move) {
        await walk(a.case_move, (from, to) => db.setCaseStatus(a.case_id, from, to), `případ ${a.case_id}`)
        stats.closed_cases++
      }
      return
  }
}

/**
 * Jeden běh hlídače: načíst, rozhodnout, zapsat. Chyba jednoho obchodu
 * nezastaví ostatní (počítá se do `failed`); chyba načtení vyhodí výjimku,
 * aby se výpadek DB nikdy nevyložil jako „všechno vyřešeno".
 */
export async function runFollowUpWatch(db: FollowUpWatchDb, now: Date): Promise<FollowUpWatchStats> {
  const activeCases = await db.loadActiveCases(FOLLOW_UP_WATCH_ACTOR)
  if (activeCases === null) return emptyStats('missing_migration')

  const deals = await db.loadDeals()
  const nodeOwnerId = await db.loadNodeOwner(FOLLOW_UP_NODE)
  const missingHistory = escalatedDealsWithoutCase(deals, activeCases, now)
  const closedCases = missingHistory.length > 0 ? await db.loadClosedCases(FOLLOW_UP_WATCH_ACTOR, missingHistory) : []

  const stats = emptyStats('ok')
  stats.deals_checked = deals.length
  stats.escalated = [...pendingFollowUps(deals, now).values()].filter((n) => n.level === 'manager').length

  for (const action of planFollowUpWatch({ deals, activeCases, closedCases, nodeOwnerId, now })) {
    try {
      await apply(db, action, stats)
    } catch (e) {
      stats.failed++
      if (stats.errors.length < MAX_REPORTED_ERRORS) {
        const msg = e instanceof Error ? e.message : String(e)
        stats.errors.push(`${action.deal_id === null && "case_id" in action ? `případ ${action.case_id}` : `obchod ${action.deal_id}`}: ${msg.slice(0, 200)}`)
      }
    }
  }
  return stats
}
