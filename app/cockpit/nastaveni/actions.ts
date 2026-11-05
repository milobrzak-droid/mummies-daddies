'use server'
// Tlačítko v kartě Microsoft Outlook (Nastavení): úkoly s termínem do
// kalendáře (syncMyTasksToOutlook, jako dřív) a u obchodních rolí navíc
// kontrola naplánovaných schůzek podle Outlooku (posun, zrušení) — stejná,
// jaká běží denně v cronu. Schůzky jsou obchodní data, proto jen s
// canSeeSales; ostatním tlačítko dál jen zapisuje úkoly.
import { revalidatePath } from 'next/cache'
import { AUTH_ERROR_MESSAGE, tryRequireUser } from '@/lib/auth/requireUser'
import { canCurrentUserSeeSales } from '@/lib/queries/access'
import { getCurrentMember, memberSeesSales } from '@/lib/queries/currentMember'
import { createAdminClient } from '@/lib/supabase/admin'
import { logError } from '@/lib/log'
import { type JobResult } from '@/worker'
import { createDeadline } from '@/worker/deadline'
import {
  OUTLOOK_MAIL_JOB_NAME, OUTLOOK_MAIL_ROUTE_BUDGET_MS, runOutlookMailJob, runOutlookMailJobBody,
} from '@/worker/outlookMailSync'
import { createJobDb } from '@/domain/crm/mailSyncService'
import type { MailSyncStats } from '@/domain/crm/mailSync'
import {
  MANUAL_RUN_MESSAGES,
  canRunMailSyncNow,
  describeManualRun,
  manualRunWaitSeconds,
} from '@/domain/crm/mailSyncProgress'
import { syncMyTasksToOutlook } from '@/domain/crm/actions/calendar'
import type { ActionResult } from '@/lib/actionResult'
import { checkMyMeetingsInOutlook } from '../schuzky/calendarCheck'

export async function syncOutlookNow(): Promise<ActionResult & { note?: string }> {
  const user = await tryRequireUser({ aal2: true })
  if (!user) return { success: false, error: AUTH_ERROR_MESSAGE }
  const tasks = await syncMyTasksToOutlook()
  if (!(await canCurrentUserSeeSales())) return tasks
  // Úkoly selhaly typicky kvůli přihlášení k Outlooku — schůzky by narazily taky.
  if (!tasks.success) return tasks
  const meetings = await checkMyMeetingsInOutlook(user.id)
  if (!meetings.ok) {
    return { success: false, error: `Úkoly jsou v kalendáři, ale schůzky se zkontrolovat nepodařilo: ${meetings.error}` }
  }
  return { success: true, note: `Úkoly jsou v kalendáři. ${meetings.summary}` }
}

/**
 * „Dotáhnout další část" v Nastavení → Pošta: jeden běh synchronizace pošty
 * hned, bez čekání na denní cron (a bez cesty do Vercelu). Tělo i zámek jsou
 * stejné jako u crona (worker/outlookMailSync.ts, runJob 'outlook-mail-sync'),
 * takže se běhy nepřekryjí. Jen správce a obchodní role, AAL2, odstup mezi
 * běhy 60 s. Do odpovědi jdou jen počty a stavy, nikdy obsah pošty.
 * Časový rozpočet (55 s) drží maxDuration = 60 na stránce Nastavení.
 */
export async function runMailSyncNow(): Promise<ActionResult & { note?: string }> {
  // Deadline od začátku akce (stránka má maxDuration 60, viz worker/outlookMailSync.ts).
  const deadline = createDeadline(OUTLOOK_MAIL_ROUTE_BUDGET_MS)
  const user = await tryRequireUser({ aal2: true })
  if (!user) return { success: false, error: AUTH_ERROR_MESSAGE }
  const { member } = await getCurrentMember()
  if (!canRunMailSyncNow(member, memberSeesSales(member))) return { success: false, error: MANUAL_RUN_MESSAGES.forbidden }

  if (process.env.OUTLOOK_MAIL_SYNC_ENABLED !== 'true') return { success: false, error: MANUAL_RUN_MESSAGES.disabled }
  const memberId = process.env.OUTLOOK_MAIL_SYNC_MEMBER_ID
  if (!memberId) return { success: false, error: MANUAL_RUN_MESSAGES.memberMissing }

  const admin = createAdminClient()
  try {
    // Odstup od posledního skutečného běhu (přeskočené pokusy se nepočítají).
    const { data } = await admin
      .from('job_run')
      .select('started_at')
      .eq('job_name', OUTLOOK_MAIL_JOB_NAME)
      .neq('status', 'skipped')
      .order('started_at', { ascending: false })
      .limit(1)
    const last = ((data as { started_at: string }[] | null) ?? [])[0]?.started_at ?? null
    const wait = manualRunWaitSeconds(last, Date.now())
    if (wait > 0) return { success: false, error: MANUAL_RUN_MESSAGES.wait(wait) }

    const jobDb = createJobDb(admin, 'action.mailSyncNow')
    let stats: MailSyncStats | null = null
    const result: JobResult = await runOutlookMailJob(jobDb, () =>
      runOutlookMailJobBody({
        admin,
        jobDb,
        memberId,
        mode: 'manual',
        logScope: 'action.mailSyncNow',
        deadline,
        onSyncStats: (s) => {
          stats = s
        },
      }),
    )
    if (result.status === 'skipped') return { success: false, error: MANUAL_RUN_MESSAGES.locked }
    if (result.status === 'failed') {
      logError('action.mailSyncNow', new Error(result.error))
      return { success: false, error: `${MANUAL_RUN_MESSAGES.failed} (${result.error})` }
    }
    revalidatePath('/cockpit/nastaveni')
    return { success: true, note: stats ? describeManualRun(stats) : 'Běh proběhl.' }
  } catch (e) {
    logError('action.mailSyncNow', e)
    return { success: false, error: MANUAL_RUN_MESSAGES.startFailed }
  }
}
