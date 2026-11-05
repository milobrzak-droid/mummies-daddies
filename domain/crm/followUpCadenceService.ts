// Běh follow-up cadence nad vstříknutou databází (balík P4). Rozhoduje čistá
// funkce planFollowUpSends (domain/crm/followUpCadence.ts); tady se plán
// zapíše. Supabase adaptér a obal runJob jsou ve worker/followUpSend.ts.
//
// ZÁPIS PŘIPOMÍNKY (send):
//   1) řádek follow_up_attempt 'planned' (UNIQUE deal+pořadí: souběžný běh
//      druhý řádek nezaloží),
//   2) RPC agent_outbox_enqueue (P3) s kind 'follow_up', source_ref
//      'followup:<deal>:<n>', mode {to: e-mail kontaktu}, schránka =
//      vlastník obchodu. Idempotentní podle source_ref, takže opakování po
//      výpadku nic nezdvojí,
//   3) řádek → 'enqueued' (outbox_id, source_ref, čas) a deal.next_step_due
//      → termín dalšího kroku (dokud cadence běží, hlídač mlčí).
//   Chybí-li RPC (P3 ještě není nasazený), řádek zůstane 'planned' a obchod
//   se nemění; další běh to zkusí znovu.
// sales_activity se tu NEZAPISUJE (viz hlavička followUpCadence.ts).
//
// VYČERPÁNÍ (exhausted) podle onExhausted:
//   'case' → deal.next_step_due = dnes − 3: hlídač při dalším běhu založí
//            případ „Follow-up: <obchod>" v uzlu COMPANY.followUpNode,
//   'lost' → obchod prohraný s důvodem (lostReasonKey → popisek), stejná
//            pole jako ruční uzavření (closed_at, forecast_category, …),
//   'none' → jen značka; termín obchodu zůstává a hlídač je dál záchranná síť.
//
// Do statistik ani chyb nikdy nejde e-mail, jméno ani text — jen id a kódy.

import { validateFollowUpCadence, type FollowUpCadenceConfig } from '@/core/followUpCadence'
import { outboxEnqueuePayload, type OutboxEnqueueResult } from '@/core/agents/outboxPort'
import { pragueDayOf, pragueToday } from '@/lib/pragueDate'
import {
  lostReasonText,
  planFollowUpSends,
  type CadenceAttempt,
  type CadenceDeal,
  type CadenceFacts,
  type StopReason,
} from './followUpCadence'

export type EnqueueOutcome =
  | { ok: true; result: OutboxEnqueueResult }
  /** RPC agent_outbox_enqueue ještě neexistuje (PGRST202 / 42883). */
  | { ok: false; missing: true }

export type InsertAttemptRow = {
  deal_id: number
  attempt: number
  planned_on: string
  status: 'planned' | 'stopped' | 'exhausted'
  stop_reason: string | null
  template: string | null
}

export interface FollowUpCadenceDb {
  /**
   * Obchody v cadence (otevřené, fáze z appliesToPhases) + obchody, u kterých
   * visí naplánovaný pokus. null = chybí follow_up_attempt (0105 neběžela).
   */
  loadDeals(phases: readonly string[]): Promise<CadenceDeal[] | null>
  loadAttempts(dealIds: readonly number[]): Promise<CadenceAttempt[]>
  loadFacts(dealIds: readonly number[]): Promise<CadenceFacts[]>
  /** Obchody s aktivním případem follow-up hlídače. */
  loadActiveCaseDealIds(): Promise<number[]>
  /** Časy zařazení za posledních ~36 h (počítá se pražský den v aplikaci). */
  loadRecentEnqueuedAt(since: Date): Promise<string[]>
  /** false = řádek už existuje (souběžný běh, UNIQUE). */
  insertAttempt(row: InsertAttemptRow): Promise<boolean>
  markEnqueued(dealId: number, attempt: number, v: { outbox_id: number; source_ref: string; enqueued_at: string }): Promise<void>
  markStopped(dealId: number, attempt: number, reason: StopReason): Promise<void>
  enqueue(payload: Record<string, unknown>): Promise<EnqueueOutcome>
  /**
   * Termín dalšího kroku obchodu. 'forward' jen posune dopředu (ručně
   * nastavený pozdější termín nechá), 'set' přepíše (eskalace po vyčerpání).
   */
  setNextStepDue(dealId: number, day: string, mode: 'forward' | 'set'): Promise<void>
  markDealLost(dealId: number, lostReason: string, today: string): Promise<void>
}

export type FollowUpCadenceStats = {
  state: 'ok' | 'missing_migration' | 'invalid_config' | 'disabled'
  deals_checked: number
  enqueued: number
  /** Rozhodnuto odeslat, ale fronta P3 ještě není (zůstává 'planned'). */
  pending_outbox: number
  duplicates: number
  stopped: number
  exhausted: number
  skipped: Record<string, number>
  failed: number
  /** Krátké chyby jen s id obchodu. */
  errors: string[]
}

const MAX_REPORTED_ERRORS = 5
/** Kolik obchodů se zpracuje za jeden běh (rozpočet funkce). */
export const FOLLOW_UP_SEND_MAX_ACTIONS = 100

function emptyStats(state: FollowUpCadenceStats['state']): FollowUpCadenceStats {
  return {
    state, deals_checked: 0, enqueued: 0, pending_outbox: 0, duplicates: 0,
    stopped: 0, exhausted: 0, skipped: {}, failed: 0, errors: [],
  }
}

export type RunCadenceOptions = {
  cfg: FollowUpCadenceConfig | null | undefined
  wonPhases?: Readonly<Record<string, readonly string[]>>
  lostReasonKeys?: readonly string[]
  /** Měkký deadline: true = skončit, zbytek dožene další běh. */
  passed?: () => boolean
}

export async function runFollowUpCadence(
  db: FollowUpCadenceDb,
  now: Date,
  opts: RunCadenceOptions,
): Promise<FollowUpCadenceStats> {
  const cfg = opts.cfg
  if (!cfg) return emptyStats('disabled')
  const issues = validateFollowUpCadence(cfg, { lostReasonKeys: opts.lostReasonKeys })
  if (issues.length > 0) return { ...emptyStats('invalid_config'), errors: issues.slice(0, MAX_REPORTED_ERRORS) }

  const deals = await db.loadDeals(cfg.appliesToPhases)
  if (deals === null) return emptyStats('missing_migration')
  const ids = deals.map((d) => d.id)
  const [attempts, facts, caseDealIds, recent] = ids.length === 0
    ? [[], [], [], []] as [CadenceAttempt[], CadenceFacts[], number[], string[]]
    : await Promise.all([
        db.loadAttempts(ids),
        db.loadFacts(ids),
        db.loadActiveCaseDealIds(),
        db.loadRecentEnqueuedAt(new Date(now.getTime() - 36 * 3600_000)),
      ])
  const today = pragueToday(now)
  const enqueuedToday = recent.filter((t) => pragueDayOf(t) === today).length

  const stats = emptyStats('ok')
  stats.deals_checked = deals.length
  const plan = planFollowUpSends({
    deals, attempts, facts, activeCaseDealIds: new Set(caseDealIds), enqueuedToday, now, cfg, wonPhases: opts.wonPhases,
  })

  let processed = 0
  for (const a of plan) {
    if (a.kind === 'skip') {
      stats.skipped[a.reason] = (stats.skipped[a.reason] ?? 0) + 1
      continue
    }
    if (processed >= FOLLOW_UP_SEND_MAX_ACTIONS || opts.passed?.()) {
      stats.skipped.budget = (stats.skipped.budget ?? 0) + 1
      continue
    }
    processed++
    try {
      switch (a.kind) {
        case 'stop':
          if (a.existing) await db.markStopped(a.deal_id, a.attempt, a.reason)
          else await db.insertAttempt({
            deal_id: a.deal_id, attempt: a.attempt, planned_on: today, status: 'stopped', stop_reason: a.reason, template: null,
          })
          stats.stopped++
          break
        case 'exhausted': {
          const fresh = await db.insertAttempt({
            deal_id: a.deal_id, attempt: a.attempt, planned_on: today, status: 'exhausted', stop_reason: 'max_attempts', template: null,
          })
          if (!fresh) { stats.duplicates++; break }
          if (a.on_exhausted === 'case') await db.setNextStepDue(a.deal_id, a.escalate_due, 'set')
          if (a.on_exhausted === 'lost') await db.markDealLost(a.deal_id, lostReasonText(cfg.lostReasonKey), today)
          stats.exhausted++
          break
        }
        case 'send': {
          if (!a.existing) {
            const fresh = await db.insertAttempt({
              deal_id: a.deal_id, attempt: a.attempt, planned_on: today, status: 'planned', stop_reason: null, template: a.template,
            })
            if (!fresh) { stats.duplicates++; break }
          }
          const outcome = await db.enqueue(outboxEnqueuePayload({
            kind: 'follow_up',
            sourceRef: a.source_ref,
            dealId: a.deal_id,
            mailboxMemberId: a.mailbox_member_id,
            mode: { to: a.to },
            subject: a.subject,
            text: a.text,
          }))
          if (!outcome.ok) { stats.pending_outbox++; break }
          await db.markEnqueued(a.deal_id, a.attempt, {
            outbox_id: outcome.result.outbox_id, source_ref: a.source_ref, enqueued_at: now.toISOString(),
          })
          await db.setNextStepDue(a.deal_id, a.next_due, 'forward')
          if (outcome.result.duplicate) stats.duplicates++
          stats.enqueued++
          break
        }
      }
    } catch (e) {
      stats.failed++
      if (stats.errors.length < MAX_REPORTED_ERRORS) {
        const msg = e instanceof Error ? e.message : String(e)
        stats.errors.push(`obchod ${a.deal_id}: ${msg.slice(0, 200)}`)
      }
    }
  }
  return stats
}
