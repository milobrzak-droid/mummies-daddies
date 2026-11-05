// Denní běh follow-up hlídače (kapitola 7: Loop Core vstřebá follow-up
// hlídač). Rozhodování je čistá funkce v domain/crm/followUpWatch.ts; tady
// je jen adaptér nad Supabase klientem se service rolí a obal runJob.
//
// Service role obchází RLS a nemá auth.uid(), proto:
// - work_case.created_by posíláme výslovně (FOLLOW_UP_WATCH_ACTOR,
//   'system:follow-up-watch') — DEFAULT loop_actor() by bez přihlášeného
//   uživatele selhal a trigger z 0057 service_role z vynucení 'user:<uuid>'
//   vyjímá;
// - přechody stavů kroků a případů hlídá trigger 0057 i pro service_role,
//   proto jdeme po povolených krocích (todo → doing → done).

import type { SupabaseClient } from '@supabase/supabase-js'
import type { CaseStatus, StepStatus } from '@/core/workCase'
import { OPEN_DEAL_STAGE_FILTER } from '@/domain/crm/sales'
import {
  FOLLOW_UP_WATCH_JOB,
  runFollowUpWatch,
  type FollowUpWatchDb,
  type FollowUpWatchStats,
  type WatchCase,
  type WatchDeal,
} from '@/domain/crm/followUpWatch'
import { runJob, type JobDbAdapter, type JobResult } from './jobRunner'

/** Zámek drží déle než nejdelší běh (route má maxDuration 60 s). */
export const FOLLOW_UP_WATCH_TTL_SECONDS = 120

type PgError = { code?: string; message: string }

/** Chybějící tabulka (migrace neběžela) — PostgreSQL i PostgREST varianta. */
export function isMissingRelation(e: PgError | null | undefined): boolean {
  return !!e && (e.code === '42P01' || e.code === 'PGRST205')
}

const CASE_SELECT =
  'id, deal_id, title, status, lead_owner_id, deputy_id, account_id,'
  + ' case_step(id, title, status, due_at, position),'
  + ' decision(id, chosen),'
  + ' approval_request(id, status)'

type CaseRow = {
  id: number
  deal_id: number | null
  title: string
  status: string
  lead_owner_id: string | null
  deputy_id: string | null
  account_id: number | null
  case_step: WatchCase['steps'][number][] | null
  decision: { id: number; chosen: string | null }[] | null
  approval_request: { id: number; status: string }[] | null
}

export function toWatchCase(r: CaseRow): WatchCase {
  return {
    id: r.id,
    deal_id: r.deal_id,
    title: r.title,
    status: r.status,
    lead_owner_id: r.lead_owner_id,
    deputy_id: r.deputy_id,
    account_id: r.account_id,
    steps: r.case_step ?? [],
    open_decisions: (r.decision ?? []).filter((d) => d.chosen === null).length,
    pending_approvals: (r.approval_request ?? []).filter((a) => a.status === 'pending').length,
  }
}

const ACTIVE_CASE_STATUSES = ['open', 'in_progress', 'waiting']
const CLOSED_CASE_STATUSES = ['done', 'cancelled']

export function createFollowUpWatchDb(admin: SupabaseClient): FollowUpWatchDb {
  return {
    async loadDeals() {
      const { data, error } = await admin
        .from('deal')
        .select('id, title, owner_id, account_id, next_step, next_step_due, last_activity_at, account:account(name)')
        .not('next_step_due', 'is', null)
        .in('stage', OPEN_DEAL_STAGE_FILTER)
      if (error) throw new Error(`deal: ${error.message}`)
      type Row = Omit<WatchDeal, 'account_name' | 'follow_up_nudged_on' | 'follow_up_escalated_on'> & {
        account: { name?: string } | null
      }
      return ((data ?? []) as unknown as Row[]).map((d) => ({
        id: d.id,
        title: d.title,
        account_id: d.account_id,
        account_name: d.account?.name ?? null,
        owner_id: d.owner_id,
        next_step: d.next_step,
        next_step_due: d.next_step_due,
        last_activity_at: d.last_activity_at,
        // Značky připomínek hlídač ignoruje (viz domain/crm/followUpWatch.ts).
        follow_up_nudged_on: null,
        follow_up_escalated_on: null,
      }))
    },
    async loadNodeOwner(node) {
      const { data, error } = await admin.from('loop_node').select('owner_id').eq('node', node).maybeSingle()
      if (error) throw new Error(`loop_node: ${error.message}`)
      return (data?.owner_id as string | null | undefined) ?? null
    },
    async loadActiveCases(actor) {
      const { data, error } = await admin
        .from('work_case')
        .select(CASE_SELECT)
        .eq('created_by', actor)
        .in('status', ACTIVE_CASE_STATUSES)
      if (isMissingRelation(error)) return null
      if (error) throw new Error(`work_case: ${error.message}`)
      return ((data ?? []) as unknown as CaseRow[]).map(toWatchCase)
    },
    async loadClosedCases(actor, dealIds) {
      const { data, error } = await admin
        .from('work_case')
        .select(CASE_SELECT)
        .eq('created_by', actor)
        .in('status', CLOSED_CASE_STATUSES)
        .in('deal_id', [...dealIds])
      if (error) throw new Error(`work_case: ${error.message}`)
      return ((data ?? []) as unknown as CaseRow[]).map(toWatchCase)
    },
    async insertCase(row) {
      // created_by je v row výslovně — viz hlavička souboru.
      const { data, error } = await admin.from('work_case').insert(row).select('id').single()
      if (error) throw new Error(`work_case insert: ${error.message}`)
      return (data as { id: number }).id
    },
    async cancelCase(caseId) {
      const { error } = await admin.from('work_case').update({ status: 'cancelled' }).eq('id', caseId).eq('status', 'open')
      if (error) throw new Error(`work_case cancel: ${error.message}`)
    },
    async updateCase(caseId, patch) {
      const { error } = await admin.from('work_case').update(patch).eq('id', caseId)
      if (error) throw new Error(`work_case update: ${error.message}`)
    },
    async insertStep(caseId, row) {
      const { error } = await admin.from('case_step').insert({ ...row, case_id: caseId })
      if (error) throw new Error(`case_step insert: ${error.message}`)
    },
    async rescheduleStep(stepId, dueAt) {
      const { error } = await admin.from('case_step').update({ due_at: dueAt }).eq('id', stepId)
      if (error) throw new Error(`case_step reschedule: ${error.message}`)
    },
    async setStepStatus(stepId, from: StepStatus, to: StepStatus) {
      const { data, error } = await admin
        .from('case_step').update({ status: to }).eq('id', stepId).eq('status', from).select('id')
      if (error) throw new Error(`case_step status: ${error.message}`)
      return (data ?? []).length > 0
    },
    async setCaseStatus(caseId, from: CaseStatus, to: CaseStatus) {
      const { data, error } = await admin
        .from('work_case').update({ status: to }).eq('id', caseId).eq('status', from).select('id')
      if (error) throw new Error(`work_case status: ${error.message}`)
      return (data ?? []).length > 0
    },
  }
}

export type FollowUpWatchDeps = {
  jobDb: JobDbAdapter
  watchDb: FollowUpWatchDb
  recordSuccess: (connector: string, cursor: string | null) => Promise<void>
  recordError: (connector: string, message: string) => Promise<void>
  connector: string
  now: () => Date
}

/**
 * Jeden denní běh pod zámkem runJob('follow-up-watch'). Výsledek zapíše do
 * job_run (runJob) i do connector_state, ať je čerstvost vidět v Nastavení.
 */
export async function runFollowUpWatchJob(deps: FollowUpWatchDeps): Promise<JobResult> {
  return runJob(deps.jobDb, FOLLOW_UP_WATCH_JOB, FOLLOW_UP_WATCH_TTL_SECONDS, async () => {
    let stats: FollowUpWatchStats
    try {
      stats = await runFollowUpWatch(deps.watchDb, deps.now())
    } catch (e) {
      await deps.recordError(deps.connector, e instanceof Error ? e.message : String(e))
      throw e
    }
    if (stats.state === 'missing_migration' || stats.failed > 0) {
      await deps.recordError(
        deps.connector,
        stats.state === 'missing_migration'
          ? 'Pracovní případy čekají na migraci 0039.'
          : `Nepodařilo se zpracovat ${stats.failed} obchodů.`,
      )
    } else {
      await deps.recordSuccess(deps.connector, null)
    }
    return stats as unknown as Record<string, unknown>
  })
}
