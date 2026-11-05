// Kontrola naplánovaných schůzek v Outlooku — adaptér nad Supabase a živé
// spuštění (cron /api/cron/follow-ups a ruční tlačítka). Logika běhu je
// v domain/crm/meetingCalendarSync.ts, rozhodování v meetingCalendar.ts.
//
// Zápisy jdou přes servisní klíč s aktérem 'system:calendar-sync' a stavem
// údaje 'source_fact' (termín schůzky je fakt z Outlooku), takže je DB audit
// trigger (0064) připíše synchronizaci kalendáře — a právě z nich skládá
// „Co se změnilo" položky „Posunuté a zrušené schůzky". Čtení jde přes
// obyčejného servisního klienta.
//
// Bez migrace 0085 (sales_activity.milestone_id, engagement_milestone.
// due_from_activity_id) běh funguje dál, jen bez milníků: sloupec, který
// chybí, se přestane číst a milník se nehlídá.
import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/admin'
import { logWarn } from '@/lib/log'
import { createAuditedAdminClient } from '@/core/auditDb'
import { recordConnectorError, recordConnectorSuccess } from '@/core/connectorState'
import { fetchCalendarEvent } from '@/connectors/graph'
import { OPEN_DEAL_STAGE_FILTER } from '@/domain/crm/sales'
import { resolveAccessToken } from '@/domain/crm/mailSync'
import { createMailTokenDeps } from '@/domain/crm/mailSyncService'
import {
  CALENDAR_SYNC_ACTOR,
  CALENDAR_SYNC_CONNECTOR,
  type DealCandidate,
  type MilestoneContext,
  type PlannedMeeting,
} from '@/domain/crm/meetingCalendar'
import {
  runMeetingCalendarSync,
  type CalendarTokenResult,
  type MeetingCalendarDb,
  type MeetingCalendarStats,
} from '@/domain/crm/meetingCalendarSync'

type Db = Pick<SupabaseClient, 'from'>
type PgError = { code?: string | null; message?: string | null } | null | undefined

const LOG_SCOPE = 'meetingCalendar'

/** Sloupec neexistuje (migrace ještě neběžela) — Postgres i PostgREST varianta. */
function isMissingColumn(e: PgError): boolean {
  return !!e && (e.code === '42703' || e.code === 'PGRST204')
}

/** Do výjimky jen kód chyby — hláška z DB může citovat řádek. */
function dbError(scope: string, e: PgError): Error {
  return new Error(`${scope}: ${e?.code ?? 'chyba databáze'}`)
}

const MEETING_COLUMNS = 'id, account_id, subject, occurred_at, follow_up_on, ms_event_id, created_by'
const MILESTONE_COLUMNS = 'id, title, status, due_on, due_from_activity_id, owner_id, deputy_id, engagement_id'

type MeetingRow = Omit<PlannedMeeting, 'milestone_id'> & { milestone_id?: number | null }

/**
 * `read` čte (servisní klient), `write` zapisuje (servisní klient s aktérem
 * synchronizace kalendáře pro audit).
 */
export function createMeetingCalendarDb(read: Db, write: Db): MeetingCalendarDb {
  // Bez 0085 se milníky nečtou (sloupec chybí); zjistí se při prvním dotazu.
  let milestonesAvailable = true

  const changed = (data: unknown) => Array.isArray(data) && data.length > 0

  return {
    async loadPlannedMeetings({ memberId, sinceIso, limit }) {
      const query = (columns: string) => {
        let q = read.from('sales_activity').select(columns)
          .eq('kind', 'meeting')
          .eq('outcome', 'planned')
          .eq('source', 'cockpit')
          .not('ms_event_id', 'is', null)
          .not('created_by', 'is', null)
          .gte('occurred_at', sinceIso)
        if (memberId) q = q.eq('created_by', memberId)
        return q.order('occurred_at', { ascending: true }).limit(limit)
      }
      let res = await query(`${MEETING_COLUMNS}, milestone_id`)
      if (res.error && isMissingColumn(res.error)) {
        milestonesAvailable = false
        res = await query(MEETING_COLUMNS)
      }
      if (res.error) throw dbError('sales_activity', res.error)
      return ((res.data ?? []) as unknown as MeetingRow[]).map((r) => ({
        id: r.id,
        account_id: r.account_id,
        subject: r.subject,
        occurred_at: r.occurred_at,
        follow_up_on: r.follow_up_on,
        ms_event_id: r.ms_event_id,
        created_by: r.created_by,
        milestone_id: milestonesAvailable ? (r.milestone_id ?? null) : null,
      }))
    },

    async loadDealCandidates(accountId, stepText) {
      const { data, error } = await read.from('deal')
        .select('id, owner_id, next_step, next_step_due')
        .eq('account_id', accountId)
        .eq('next_step', stepText)
        .in('stage', OPEN_DEAL_STAGE_FILTER)
      if (error) throw dbError('deal', error)
      return (data ?? []) as DealCandidate[]
    },

    async loadMilestone(milestoneId) {
      if (!milestonesAvailable) return null
      const { data, error } = await read.from('engagement_milestone').select(MILESTONE_COLUMNS).eq('id', milestoneId).maybeSingle()
      if (error) {
        if (isMissingColumn(error)) {
          milestonesAvailable = false
          return null
        }
        throw dbError('engagement_milestone', error)
      }
      if (!data) return null
      const m = data as unknown as Omit<MilestoneContext, 'engagement_owner_id'>
      // Vlastník dodávky jen jako záložní řešitel úkolu; chyba ho nezablokuje.
      const eng = await read.from('engagement').select('owner_id').eq('id', m.engagement_id).maybeSingle()
      const engagementOwner = eng.error ? null : ((eng.data as { owner_id?: string | null } | null)?.owner_id ?? null)
      return { ...m, engagement_owner_id: engagementOwner }
    },

    async loadAccountOwner(accountId) {
      const { data, error } = await read.from('account').select('owner_id').eq('id', accountId).maybeSingle()
      if (error) return null
      return (data as { owner_id?: string | null } | null)?.owner_id ?? null
    },

    async shiftMilestone(op) {
      const { data, error } = await write.from('engagement_milestone')
        .update({ due_on: op.toDay })
        .eq('id', op.milestoneId)
        .eq('due_on', op.fromDay)
        .eq('due_from_activity_id', op.activityId)
        .select('id')
      if (error) throw dbError('engagement_milestone.update', error)
      return changed(data)
    },

    async shiftDeal(op) {
      const { data, error } = await write.from('deal')
        .update({ next_step_due: op.toDue, follow_up_nudged_on: null, follow_up_escalated_on: null })
        .eq('id', op.dealId)
        .eq('next_step', op.stepText)
        .eq('next_step_due', op.fromDue)
        .select('id')
      if (error) throw dbError('deal.update', error)
      return changed(data)
    },

    async replanDeal(op) {
      const { data, error } = await write.from('deal')
        .update({ next_step: op.text, next_step_due: op.due, follow_up_nudged_on: null, follow_up_escalated_on: null })
        .eq('id', op.dealId)
        .eq('next_step', op.fromText)
        .eq('next_step_due', op.fromDue)
        .select('id')
      if (error) throw dbError('deal.update', error)
      return changed(data)
    },

    async ensureTask(task, sinceIso) {
      let q = read.from('task').select('id').eq('title', task.title).gte('created_at', sinceIso)
      q = task.assignee_id ? q.eq('assignee_id', task.assignee_id) : q.is('assignee_id', null)
      q = task.account_id != null ? q.eq('account_id', task.account_id) : q.is('account_id', null)
      const existing = await q.limit(1)
      if (existing.error) throw dbError('task', existing.error)
      if (changed(existing.data)) return 'exists'
      // created_by NULL: úkol založil systém (created_by je uuid člena týmu).
      const { error } = await write.from('task').insert({ ...task, status: 'todo', created_by: null })
      if (error) throw dbError('task.insert', error)
      return 'created'
    },

    async moveActivity(op) {
      const patch: Record<string, unknown> = { occurred_at: op.to }
      if (op.followUpTo !== op.followUpFrom) patch.follow_up_on = op.followUpTo
      const { data, error } = await write.from('sales_activity')
        .update(patch)
        .eq('id', op.activityId)
        .eq('outcome', 'planned')
        .eq('occurred_at', op.from)
        .select('id')
      if (error) throw dbError('sales_activity.update', error)
      return changed(data)
    },

    async cancelActivity(op) {
      const { data, error } = await write.from('sales_activity')
        .update({ outcome: 'cancelled' })
        .eq('id', op.activityId)
        .eq('outcome', 'planned')
        .select('id')
      if (error) throw dbError('sales_activity.update', error)
      return changed(data)
    },
  }
}

/** Kdo běh spustil: cron (všechny schůzky, tokeny přes servisní funkce) nebo člověk (jen jeho, jeho token). */
export type CalendarSyncTrigger =
  | { kind: 'cron' }
  | { kind: 'manual'; memberId: string; accessToken: string }

/** Chyba tokenu jako věta pro stav konektoru (bez jmen a adres). */
export function calendarTokenError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e)
  return `Kalendář organizátora schůzky se nepodařilo zkontrolovat: ${msg}`.slice(0, 300)
}

/**
 * Stav konektoru graph_calendar (sdílený řádek) po běhu: chyba, jen když
 * přístup selhal u VŠECH kontrolovaných organizátorů — chyba jednoho člena
 * (třeba odpojil Outlook) nesmí hlásit rozbitý kalendář celému týmu; je
 * v job_run.stats (memberErrors, accessError) a v logu. Jinak úspěch, když
 * Outlook aspoň jednou odpověděl. Bez naplánovaných schůzek se stav nemění.
 */
export async function recordCalendarConnectorState(stats: MeetingCalendarStats): Promise<void> {
  if (stats.memberErrors > 0 && stats.accessError && stats.memberErrors >= stats.members) {
    await recordConnectorError(CALENDAR_SYNC_CONNECTOR, stats.accessError)
  } else {
    if (stats.memberErrors > 0) {
      logWarn('meetingCalendar', 'kalendář části organizátorů se nepodařilo zkontrolovat', { memberErrors: stats.memberErrors, members: stats.members })
    }
    if (stats.checked > 0) await recordConnectorSuccess(CALENDAR_SYNC_CONNECTOR, new Date().toISOString())
  }
}

/** Živý běh nad Supabase a Microsoft Graph. */
export async function runMeetingCalendarSyncLive(
  trigger: CalendarSyncTrigger,
  opts: { budgetMs?: number } = {},
): Promise<MeetingCalendarStats> {
  const admin = createAdminClient()
  const db = createMeetingCalendarDb(admin, createAuditedAdminClient({ actor: CALENDAR_SYNC_ACTOR, infoState: 'source_fact' }))
  const token = async (memberId: string): Promise<CalendarTokenResult> => {
    if (trigger.kind === 'manual') {
      return memberId === trigger.memberId
        ? { ok: true, accessToken: trigger.accessToken }
        : { ok: false, error: 'Cizí kalendář ručně kontrolovat nejde.' }
    }
    try {
      return { ok: true, accessToken: await resolveAccessToken(createMailTokenDeps(admin, memberId, LOG_SCOPE)) }
    } catch (e) {
      return { ok: false, error: calendarTokenError(e) }
    }
  }
  const stats = await runMeetingCalendarSync(
    { db, token, fetchEvent: (accessToken, eventId) => fetchCalendarEvent(accessToken, eventId), now: () => new Date() },
    { memberId: trigger.kind === 'manual' ? trigger.memberId : null, budgetMs: opts.budgetMs },
  )
  await recordCalendarConnectorState(stats)
  return stats
}
