// GET /api/cron/agent-outbox — odchozí fronta agenta (balík P3): jediná
// cesta, kudy systém posílá e-mail zákazníkovi (nabídka, doptání údajů,
// připomínka nabídky). Logika v domain/crm/agentOutbox.ts, zapojení na
// Supabase a Gmail v domain/crm/agentOutboxService.ts, SQL v 0104.
//
// VÝCHOZÍ VYPNUTO: bez AGENT_OUTBOX_ENABLED === 'true' route vrací 404
// a nedělá nic. I se zapnutou frontou odchází BEZ člověka jen zpráva, pro
// kterou platí AGENT_AUTOSEND_ENABLED === 'true', pravidlo L4 v DB,
// schválená (neilustrační) mapa a ostatní brány; jinak vznikne žádost ke
// schválení nebo úkol. Zprávu schválenou člověkem fronta odešle i bez
// AGENT_AUTOSEND_ENABLED.
//
// Zapnutí: migrace 0104, env AGENT_OUTBOX_ENABLED=true, CRON_SECRET,
// GMAIL_OAUTH_CLIENT_ID / GMAIL_OAUTH_CLIENT_SECRET, klíč Supabase se
// service rolí a token odesílací schránky v GMAIL_REFRESH_TOKENS (společný @/connectors/gmail).
//
// Autorizace: `Authorization: Bearer ${CRON_SECRET}`, porovnání v
// konstantním čase (stejně jako ostatní crony). Zámek proti překryvu
// runJob (0040); souběžné běhy navíc jistí claim v DB.
import { createHash, timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { logError } from '@/lib/log'
import { runJob, type JobDbAdapter } from '@/worker'
import { AGENT_OUTBOX_JOB, outboxEnabledFromEnv, runAgentOutboxLive } from '@/domain/crm/agentOutboxService'

export const maxDuration = 300

/** Měkký limit pro začátek další zprávy; tvrdá pojistka runJob je těsně pod maxDuration. */
const BUDGET_MS = 240_000
const TIMEOUT_MS = 285_000
const LOCK_TTL_SECONDS = 330

function authorized(header: string | null, secret: string | undefined): boolean {
  if (!secret || !header) return false
  // Hash srovná délky, takže timingSafeEqual nevyzradí ani délku tajemství.
  const a = createHash('sha256').update(header).digest()
  const b = createHash('sha256').update(`Bearer ${secret}`).digest()
  return timingSafeEqual(a, b)
}

export async function GET(request: Request) {
  if (!outboxEnabledFromEnv(process.env)) {
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
      if (e) logError('cron.agentOutbox.finish', e, { runId })
    },
  }

  const result = await runJob(
    jobDb,
    AGENT_OUTBOX_JOB,
    LOCK_TTL_SECONDS,
    async () => (await runAgentOutboxLive({ budgetMs: BUDGET_MS })) as unknown as Record<string, unknown>,
    { timeoutMs: TIMEOUT_MS },
  )
  if (result.status === 'failed') logError('cron.agentOutbox', new Error(result.error))
  return NextResponse.json(result, { status: result.status === 'failed' ? 500 : 200 })
}
