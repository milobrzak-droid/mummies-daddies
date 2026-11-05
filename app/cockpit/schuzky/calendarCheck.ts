// Ruční kontrola naplánovaných schůzek v Outlooku pro přihlášeného člena —
// sdílené jádro tlačítek „Zkontrolovat změny v Outlooku" (Schůzky) a
// „Synchronizovat úkoly a schůzky" (Nastavení). Stejná kontrola běží denně
// v cronu /api/cron/follow-ups; tady jen schůzky přihlášeného a s jeho
// tokenem (calendar_token_get_decrypted, vyžaduje AAL2). Stejný zámek
// runJob('calendar-sync') jako cron, takže se tlačítko a cron nepřekryjí.
//
// Volá se AŽ po kontrole přihlášení (AAL2) a obchodní role — schůzky jsou
// obchodní data (sales_activity, 0058). Sám nic neověřuje.
import { revalidatePath } from 'next/cache'
import { createAdminClient } from '@/lib/supabase/admin'
import { logError } from '@/lib/log'
import { graphTokenForCurrentUser } from '@/connectors/graph'
import { recordConnectorError } from '@/core/connectorState'
import { runJob, type JobResult } from '@/worker'
import { createJobDb } from '@/domain/crm/mailSyncService'
import {
  CALENDAR_SYNC_CONNECTOR,
  CALENDAR_SYNC_JOB,
  CALENDAR_SYNC_TTL_SECONDS,
  formatCalendarSyncSummary,
  type CalendarCheckResult,
} from '@/domain/crm/meetingCalendar'
import { runMeetingCalendarSyncLive } from '@/domain/crm/meetingCalendarService'
import type { MeetingCalendarStats } from '@/domain/crm/meetingCalendarSync'

/** Rozpočet ruční kontroly — server akce má stejný limit jako stránka. */
const MANUAL_BUDGET_MS = 40_000

export async function checkMyMeetingsInOutlook(userId: string): Promise<CalendarCheckResult> {
  const token = await graphTokenForCurrentUser()
  if (!token.ok) {
    await recordConnectorError(CALENDAR_SYNC_CONNECTOR, token.error)
    return { ok: false, error: token.error }
  }

  let result: JobResult
  try {
    result = await runJob(createJobDb(createAdminClient(), 'action.calendarCheck'), CALENDAR_SYNC_JOB, CALENDAR_SYNC_TTL_SECONDS, async () =>
      (await runMeetingCalendarSyncLive(
        { kind: 'manual', memberId: userId, accessToken: token.accessToken },
        { budgetMs: MANUAL_BUDGET_MS },
      )) as unknown as Record<string, unknown>)
  } catch (e) {
    logError('action.calendarCheck', e)
    return { ok: false, error: 'Kontrolu kalendáře se nepodařilo spustit.' }
  }
  if (result.status === 'skipped') {
    return { ok: false, error: 'Kontrola kalendáře právě běží (denní úloha nebo jiné tlačítko). Zkus to za minutu.' }
  }
  if (result.status === 'failed') {
    return { ok: false, error: 'Kontrola kalendáře skončila chybou — podrobnosti jsou v záznamu úloh (job_run).' }
  }
  const stats = result.stats as unknown as MeetingCalendarStats
  if (stats.memberErrors > 0 && stats.accessError) return { ok: false, error: stats.accessError }

  const changed = stats.moved + stats.cancelled > 0
  if (changed) {
    revalidatePath('/cockpit/schuzky')
    revalidatePath('/cockpit')
    revalidatePath('/cockpit/tasks')
  }
  return { ok: true, summary: formatCalendarSyncSummary(stats), changed }
}
