'use server'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { AUTH_ERROR_MESSAGE, tryRequireUser } from '@/lib/auth/requireUser'
import { logError } from '@/lib/log'
import { runJob, type JobDbAdapter, type JobResult } from '@/worker'
import {
  ARES_ENRICH_JOB_NAME,
  ARES_ENRICH_JOB_TTL_SECONDS,
  ARES_MIGRATION_MISSING_MESSAGE,
  formatAresEnrichSummary,
  liveAresSource,
  runAresEnrichment,
  supabaseAresEnrichDb,
  type AresEnrichStats,
} from '@/domain/crm/aresEnrich'
import { readActiveMember } from '@/lib/auth/activeMember'

// „Doplnit automaticky (dávka 40)" na /clients/doplnit-ico — ruční spuštění
// stejné dávky, jakou dělá denní cron (/api/cron/ares-enrich). Jen pro
// admina: běh zapisuje přes service roli do cizích klientů a do auditu
// (aktér = tenhle admin). Stejný zámek runJob('ares-enrich') jako cron,
// takže admin a cron (ani dva admini) se nepřekryjí. Časový rozpočet
// dávky (50 s) drží maxDuration = 60 na stránce /clients/doplnit-ico.

export type AresEnrichActionResult =
  | { ok: true; summary: string; stats: AresEnrichStats }
  | { ok: false; error: string }

// Stejná brána jako lib/actions/team.ts: AAL2 + is_admin čtený z DB řádku
// (nikdy z JWT/user_metadata).
async function requireAdmin() {
  const user = await tryRequireUser({ aal2: true })
  if (!user) return { ok: false as const, error: AUTH_ERROR_MESSAGE }
  const supabase = await createClient()
  const { row: data } = await readActiveMember<{ is_admin?: boolean | null }>(supabase, user.id, 'is_admin')
  if (!data?.is_admin) return { ok: false as const, error: 'Nemáš oprávnění.' }
  return { ok: true as const, userId: user.id }
}

// PostgREST PGRST202 / Postgres 42883 = funkce (zámek z 0040) neexistuje.
const MISSING_FN = new Set(['PGRST202', '42883'])

export async function runAresEnrichBatch(): Promise<AresEnrichActionResult> {
  const gate = await requireAdmin()
  if (!gate.ok) return { ok: false, error: gate.error }

  const admin = createAdminClient()
  const jobDb: JobDbAdapter = {
    async tryAcquireJobLock(jobName, ttlSeconds) {
      const { data, error } = await admin.rpc('try_acquire_job_lock', { job_name: jobName, ttl_seconds: ttlSeconds })
      if (error) {
        if (MISSING_FN.has(String(error.code))) throw new Error('Chybí migrace 0040 (zámek úloh) — dávku nejde bezpečně spustit.')
        throw new Error(`try_acquire_job_lock: ${error.message}`)
      }
      return (data as number | null) ?? null
    },
    async finishJobRun(runId, status, stats, error) {
      const { error: e } = await admin.rpc('finish_job_run', { run_id: runId, status, stats, error })
      if (e) logError('action.aresEnrich.finish', e, { runId })
    },
  }

  let result: JobResult
  try {
    result = await runJob(jobDb, ARES_ENRICH_JOB_NAME, ARES_ENRICH_JOB_TTL_SECONDS, async () =>
      runAresEnrichment(supabaseAresEnrichDb(admin, { type: 'user', id: gate.userId }), liveAresSource),
    )
  } catch (e) {
    logError('action.aresEnrich', e)
    const message = e instanceof Error && e.message.startsWith('Chybí migrace') ? e.message : 'Dávku se nepodařilo spustit.'
    return { ok: false, error: message }
  }

  if (result.status === 'skipped') {
    return { ok: false, error: 'Doplňování už právě běží (cron nebo jiný správce). Zkus to za minutu.' }
  }
  if (result.status === 'failed') {
    if (result.error === ARES_MIGRATION_MISSING_MESSAGE) return { ok: false, error: ARES_MIGRATION_MISSING_MESSAGE }
    return { ok: false, error: 'Dávka skončila chybou — podrobnosti jsou v záznamu úloh (job_run).' }
  }

  // Záměrně BEZ revalidatePath: ta by stránku (20 dalších dotazů na ARES)
  // překreslila ve stejném požadavku jako dávka a oba rozpočty by se
  // sečetly přes 60 s. Seznam obnoví klient (router.refresh v
  // AresEnrichButton) samostatným požadavkem. Stránky klientů jsou
  // dynamické (force-dynamic), serverová cache tu není co zneplatnit.
  const stats = result.stats as AresEnrichStats
  return { ok: true, summary: formatAresEnrichSummary(stats), stats }
}
