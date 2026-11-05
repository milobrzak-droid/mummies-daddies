// Úloha 'follow-up-send' (balík P4): připomínky neodpovězených nabídek přes
// odchozí frontu agent_outbox (P3). Rozhoduje domain/crm/followUpCadence.ts,
// zapisuje domain/crm/followUpCadenceService.ts; tady je Supabase adaptér
// (servisní klíč, audit s aktérem system:follow-up-send) a obal runJob.
// Spouští ji cron /api/cron/follow-ups za hlídačem, jen s
// FOLLOWUP_CADENCE_ENABLED === 'true'.

import type { SupabaseClient } from '@supabase/supabase-js'
import { OUTBOX_ENQUEUE_RPC, type OutboxEnqueueResult } from '@/core/agents/outboxPort'
import { FOLLOW_UP_WATCH_ACTOR } from '@/domain/crm/followUpWatch'
import {
  FOLLOW_UP_SEND_JOB,
  type CadenceAccount,
  type CadenceAttempt,
  type CadenceContact,
  type CadenceDeal,
  type CadenceFacts,
} from '@/domain/crm/followUpCadence'
import {
  runFollowUpCadence,
  type FollowUpCadenceDb,
  type FollowUpCadenceStats,
  type RunCadenceOptions,
} from '@/domain/crm/followUpCadenceService'
import { OPEN_DEAL_STAGE_FILTER } from '@/domain/crm/sales'
import { isMissingFunction } from './approvalExpiry'
import { isMissingRelation } from './followUpWatch'
import { runJob, type JobDbAdapter, type JobResult } from './jobRunner'

/** Zámek drží déle než nejdelší běh (route má maxDuration 60 s). */
export const FOLLOW_UP_SEND_TTL_SECONDS = 120

type PgError = { code?: string; message: string }

const isUniqueViolation = (e: PgError | null | undefined) => !!e && e.code === '23505'

const ACTIVE_CASE_STATUSES = ['open', 'in_progress', 'waiting']

const DEAL_SELECT = 'id, title, stage, pillar, phase, owner_id, account_id, primary_contact_id, next_step_due'

type DealRow = Omit<CadenceDeal, 'contact' | 'account'>

export function createFollowUpCadenceDb(admin: SupabaseClient): FollowUpCadenceDb {
  const fail = (what: string, e: PgError): never => {
    throw new Error(`${what}: ${e.message}`)
  }
  return {
    async loadDeals(phases) {
      const planned = await admin.from('follow_up_attempt').select('deal_id').eq('status', 'planned')
      if (isMissingRelation(planned.error)) return null
      if (planned.error) fail('follow_up_attempt', planned.error)
      const plannedIds = [...new Set(((planned.data ?? []) as { deal_id: number }[]).map((r) => r.deal_id))]

      const open = await admin.from('deal').select(DEAL_SELECT).in('stage', OPEN_DEAL_STAGE_FILTER).in('phase', [...phases])
      if (open.error) fail('deal', open.error)
      const rows = new Map<number, DealRow>(((open.data ?? []) as DealRow[]).map((d) => [d.id, d]))
      const extra = plannedIds.filter((id) => !rows.has(id))
      if (extra.length > 0) {
        const more = await admin.from('deal').select(DEAL_SELECT).in('id', extra)
        if (more.error) fail('deal', more.error)
        for (const d of (more.data ?? []) as DealRow[]) rows.set(d.id, d)
      }
      if (rows.size === 0) return []

      const contactIds = [...new Set([...rows.values()].map((d) => d.primary_contact_id).filter((x): x is number => x != null))]
      const accountIds = [...new Set([...rows.values()].map((d) => d.account_id).filter((x): x is number => x != null))]
      const contacts = new Map<number, CadenceContact>()
      const accounts = new Map<number, CadenceAccount>()
      if (contactIds.length > 0) {
        const c = await admin.from('contact').select('id, full_name, email, do_not_contact, notes').in('id', contactIds)
        if (c.error) fail('contact', c.error)
        for (const r of (c.data ?? []) as CadenceContact[]) contacts.set(r.id, r)
      }
      if (accountIds.length > 0) {
        const a = await admin.from('account').select('id, notes, snooze_until').in('id', accountIds)
        if (a.error) fail('account', a.error)
        for (const r of (a.data ?? []) as CadenceAccount[]) accounts.set(r.id, r)
      }
      return [...rows.values()].map((d) => ({
        ...d,
        contact: d.primary_contact_id != null ? contacts.get(d.primary_contact_id) ?? null : null,
        account: d.account_id != null ? accounts.get(d.account_id) ?? null : null,
      }))
    },
    async loadAttempts(dealIds) {
      const { data, error } = await admin
        .from('follow_up_attempt')
        .select('deal_id, attempt, status, planned_on, enqueued_at')
        .in('deal_id', [...dealIds])
      if (error) fail('follow_up_attempt', error)
      return (data ?? []) as CadenceAttempt[]
    },
    async loadFacts(dealIds) {
      const { data, error } = await admin.rpc('follow_up_facts', { p_deal_ids: [...dealIds] })
      if (error) fail('follow_up_facts', error)
      return (data ?? []) as CadenceFacts[]
    },
    async loadActiveCaseDealIds() {
      const { data, error } = await admin
        .from('work_case')
        .select('deal_id')
        .eq('created_by', FOLLOW_UP_WATCH_ACTOR)
        .in('status', ACTIVE_CASE_STATUSES)
      if (isMissingRelation(error)) return []
      if (error) fail('work_case', error)
      return ((data ?? []) as { deal_id: number | null }[]).map((r) => r.deal_id).filter((x): x is number => x != null)
    },
    async loadRecentEnqueuedAt(since) {
      const { data, error } = await admin
        .from('follow_up_attempt')
        .select('enqueued_at')
        .eq('status', 'enqueued')
        .gte('enqueued_at', since.toISOString())
      if (error) fail('follow_up_attempt', error)
      return ((data ?? []) as { enqueued_at: string | null }[]).map((r) => r.enqueued_at).filter((x): x is string => !!x)
    },
    async insertAttempt(row) {
      const { error } = await admin.from('follow_up_attempt').insert(row)
      if (isUniqueViolation(error)) return false
      if (error) fail('follow_up_attempt insert', error)
      return true
    },
    async markEnqueued(dealId, attempt, v) {
      const { error } = await admin
        .from('follow_up_attempt')
        .update({ status: 'enqueued', outbox_id: v.outbox_id, outbox_source_ref: v.source_ref, enqueued_at: v.enqueued_at })
        .eq('deal_id', dealId).eq('attempt', attempt).eq('status', 'planned')
      if (error) fail('follow_up_attempt enqueued', error)
    },
    async markStopped(dealId, attempt, reason) {
      const { error } = await admin
        .from('follow_up_attempt')
        .update({ status: 'stopped', stop_reason: reason })
        .eq('deal_id', dealId).eq('attempt', attempt).eq('status', 'planned')
      if (error) fail('follow_up_attempt stopped', error)
    },
    async enqueue(payload) {
      const { data, error } = await admin.rpc(OUTBOX_ENQUEUE_RPC, { p: payload })
      if (isMissingFunction(error)) return { ok: false, missing: true }
      if (error) fail(OUTBOX_ENQUEUE_RPC, error)
      const r = data as Partial<OutboxEnqueueResult> | null
      if (!r || typeof r.outbox_id !== 'number') throw new Error(`${OUTBOX_ENQUEUE_RPC}: neočekávaná odpověď`)
      return { ok: true, result: { outbox_id: r.outbox_id, duplicate: r.duplicate === true } }
    },
    async setNextStepDue(dealId, day, mode) {
      let q = admin.from('deal').update({ next_step_due: day }).eq('id', dealId)
      if (mode === 'forward') q = q.or(`next_step_due.is.null,next_step_due.lt.${day}`)
      const { error } = await q
      if (error) fail('deal next_step_due', error)
    },
    async markDealLost(dealId, lostReason, today) {
      // Stejná pole jako ruční uzavření (domain/crm/actions/sales.ts); CR002 (0052)
      // bez důvodu prohry zápis odmítne.
      const { error } = await admin
        .from('deal')
        .update({
          stage: 'prohráno', lost_reason: lostReason, forecast_category: 'closed', closed_at: today,
          probability_pct: 0, next_step: null, next_step_due: null,
        })
        .eq('id', dealId)
        .in('stage', OPEN_DEAL_STAGE_FILTER)
      if (error) fail('deal lost', error)
    },
  }
}

export type FollowUpSendDeps = {
  jobDb: JobDbAdapter
  cadenceDb: FollowUpCadenceDb
  recordSuccess: (connector: string, cursor: string | null) => Promise<void>
  recordError: (connector: string, message: string) => Promise<void>
  connector: string
  now: () => Date
  options: RunCadenceOptions
}

/** Jeden běh pod zámkem runJob('follow-up-send'); výsledek do job_run i connector_state. */
export async function runFollowUpSendJob(deps: FollowUpSendDeps): Promise<JobResult> {
  return runJob(deps.jobDb, FOLLOW_UP_SEND_JOB, FOLLOW_UP_SEND_TTL_SECONDS, async () => {
    let stats: FollowUpCadenceStats
    try {
      stats = await runFollowUpCadence(deps.cadenceDb, deps.now(), deps.options)
    } catch (e) {
      await deps.recordError(deps.connector, e instanceof Error ? e.message : String(e))
      throw e
    }
    if (stats.state === 'missing_migration') await deps.recordError(deps.connector, 'Follow-up cadence čeká na migraci 0105.')
    else if (stats.state === 'invalid_config') await deps.recordError(deps.connector, 'Nastavení follow-up cadence je neplatné.')
    else if (stats.failed > 0) await deps.recordError(deps.connector, `Nepodařilo se zpracovat ${stats.failed} obchodů.`)
    else await deps.recordSuccess(deps.connector, null)
    return stats as unknown as Record<string, unknown>
  })
}
