// GET /api/cron/outbound-agent — běh outbound agenta (balík P7): signály →
// kvalifikace → lead do CRM → návrh oslovení → (jen stávajícím zákazníkům
// a kontaktům se souhlasem) fronta agent_outbox. Popis: docs/OUTBOUND.md.
//
// VYPNUTO, dokud OUTBOUND_AGENT_ENABLED !== 'true' (routa vrací 404 a nic
// nedělá). Samostatné odeslání navíc za OUTBOUND_AUTOSEND_ENABLED; bez něj
// agent jen připravuje koncepty ke schválení. Zdroje mají vlastní přepínače
// (VVZ_ENABLED, OUTBOUND_FEEDS_ENABLED, OUTBOUND_JOBS_ENABLED, OUTBOUND_ARES_ENABLED).
//
// Autorizace: `Authorization: Bearer ${CRON_SECRET}`, porovnání v konstantním čase.
import { createHash, timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { COMPANY } from '@/config'
import { createAdminClient } from '@/lib/supabase/admin'
import { logError } from '@/lib/log'
import { pragueToday } from '@/lib/pragueDate'
import { runJob, type JobDbAdapter } from '@/worker'
import { OUTBOUND_JOB_NAME, OUTBOUND_JOB_TTL_SECONDS, runOutboundAgent } from '@/domain/outbound/run'
import { liveOutboundSources, outboundAgentEnabledFromEnv, outboundAutosendEnabledFromEnv } from '@/domain/outbound/sources'
import { supabaseOutboundDb } from '@/domain/outbound/supabaseDb'

export const maxDuration = 300
export const dynamic = 'force-dynamic'

function authorized(header: string | null, secret: string | undefined): boolean {
  if (!secret || !header) return false
  const a = createHash('sha256').update(header).digest()
  const b = createHash('sha256').update(`Bearer ${secret}`).digest()
  return timingSafeEqual(a, b)
}

export async function GET(request: Request) {
  const config = COMPANY.capabilities.outboundAgent
  if (!outboundAgentEnabledFromEnv(process.env) || !config) {
    return new NextResponse(null, { status: 404 })
  }
  if (!authorized(request.headers.get('authorization'), process.env.CRON_SECRET)) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
  }

  const admin = createAdminClient()
  const jobDb: JobDbAdapter = {
    async tryAcquireJobLock(jobName, ttlSeconds) {
      const { data, error } = await admin.rpc('try_acquire_job_lock', { job_name: jobName, ttl_seconds: ttlSeconds })
      if (error) throw new Error(`try_acquire_job_lock: ${error.message}`)
      return (data as number | null) ?? null
    },
    async finishJobRun(runId, status, stats, error) {
      const { error: e } = await admin.rpc('finish_job_run', { run_id: runId, status, stats, error })
      if (e) logError('cron.outboundAgent.finish', e, { runId })
    },
  }

  const now = new Date()
  const today = pragueToday(now)
  try {
    const result = await runJob(jobDb, OUTBOUND_JOB_NAME, OUTBOUND_JOB_TTL_SECONDS, async () =>
      (await runOutboundAgent(
        supabaseOutboundDb(admin, { today, now, pillar: config.icp.pillar }),
        liveOutboundSources(process.env, config),
        {
          config, now, today, timeZone: COMPANY.timeZone,
          autosendEnabled: outboundAutosendEnabledFromEnv(process.env),
          unsubscribeSecret: process.env.OUTBOUND_UNSUBSCRIBE_SECRET ?? null,
        },
      )) as unknown as Record<string, unknown>)
    return NextResponse.json(result, { status: result.status === 'failed' ? 500 : 200 })
  } catch (e) {
    logError('cron.outboundAgent', e)
    return NextResponse.json({ error: 'job_lock' }, { status: 503 })
  }
}
