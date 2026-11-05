// GET /api/cron/follow-ups — denní hlídač Loop Core (kapitola 7 plánu
// přestavby: Loop Core vstřebá follow-up hlídač, který se nikdy nespustil).
//
// Bez FOLLOWUP_WATCH_ENABLED === 'true' route vrací 404 a nedělá nic.
// Zapnutí: migrace 0039 (Loop Core), 0040 (job_run) a 0057 aplikované; env
// FOLLOWUP_WATCH_ENABLED=true, CRON_SECRET, klíč Supabase se service rolí.
// Plán ve vercel.json: denně 06:00 UTC.
//
// Dvě nezávislé úlohy, každá pod vlastním zámkem (runJob), takže selhání
// jedné nezastaví druhou:
// 1) follow-up hlídač — eskalovaný follow-up obchodu (3+ dny po termínu bez
//    aktivity) otevře nebo srovná případ „Follow-up: <obchod>" v uzlu
//    COMPANY.followUpNode s krokem „Ozvat se klientovi"; vyřešený follow-up
//    krok uzavře. Logika v domain/crm/followUpWatch.ts, DB ve
//    worker/followUpWatch.ts.
// 2) vypršení žádostí o schválení (migrace 0084) — prošlé čekající žádosti
//    přejdou do „vypršelo" a spustí definovaný další stav (vlastník dostane
//    úkol); neúspěšná provedení se zkusí znovu. Samostatný cron nepřidáváme
//    (Vercel Hobby má omezený počet cronů). Bez 0084 úloha jen zapíše, že
//    čeká na migraci. Zápisy nesou aktéra system:approval-expiry (hlavička
//    servisního klíče, audit 0064).
//
// Autorizace: `Authorization: Bearer ${CRON_SECRET}`, porovnání v
// konstantním čase (stejně jako /api/cron/outlook-mail).
//
// Kontrola naplánovaných schůzek v Outlooku (domain/crm/meetingCalendarSync.ts)
// běží tady, PŘED hlídačem: posunutá nebo zrušená schůzka posune či přepíše
// odvozený další krok obchodu dřív, než ho hlídač vyhodnotí podle starého
// termínu. Vlastní cron nemá (Vercel Hobby = jedna úloha denně na cestu,
// nový cron by nic nepřinesl). Vlastní zámek 'calendar-sync' sdílí
// s ručním tlačítkem. Běží, jen když je route zapnutá (FOLLOWUP_WATCH_ENABLED
// = 'true'), a navíc ji vypne CALENDAR_SYNC_ENABLED=false; chyba kontroly
// kalendáře hlídač nezastaví.
//
// Denní kontrola dokumentů dodávek v SharePointu (domain/delivery/
// documentSync.ts, revize kap. 2E, migrace 0094) běží tady taky, hned po
// kalendáři: schválený/odeslaný/přijatý dokument se porovná s verzí
// připíchnutou při schválení (jen metadata, obsah se nečte) a když se změnil,
// zmizel nebo k němu chybí přístup, vznikne nález, úkol vlastníkovi a položka
// „Co se změnilo". VÝCHOZÍ VYPNUTO: běží jen se SHAREPOINT_DOC_SYNC_ENABLED=
// 'true' (a s GRAPH_FILES_SCOPE_ENABLED a udělenou Files.Read.All). Vlastní
// zámek 'sharepoint-doc-sync'; její chyba hlídač nezastaví.
//
// Denní kontrola plánovaných úloh (domain/crm/jobHealth.ts, migrace 0100) běží
// tady na konci: běh, který visí jako 'running' s vypršelým zámkem, uzavře
// jako failed (close_stale_job_runs) a stav úloh zapíše do odpovědi i logu.
// Stejný stav ukazuje Nastavení (dlaždice Stav úloh) a přehled e-mailem.
// Samostatný cron nepřidáváme (Vercel Hobby). Chyba kontroly nic nezastaví.

import { createHash, timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { logError } from '@/lib/log'
import { recordConnectorError, recordConnectorSuccess } from '@/core/connectorState'
import { createAuditedAdminClient } from '@/core/auditDb'
import { FOLLOW_UP_WATCH_CONNECTOR } from '@/domain/crm/followUpWatch'
import {
  APPROVAL_EXPIRY_JOB,
  createFollowUpWatchDb,
  runApprovalExpiryJob,
  runFollowUpWatchJob,
  runJob,
  type JobDbAdapter,
  type JobResult,
} from '@/worker'
import { CALENDAR_SYNC_JOB, CALENDAR_SYNC_TTL_SECONDS, calendarSyncEnabledFromEnv } from '@/domain/crm/meetingCalendar'
import { runMeetingCalendarSyncLive } from '@/domain/crm/meetingCalendarService'
import { DOC_SYNC_JOB, DOC_SYNC_TTL_SECONDS, docSyncEnabledFromEnv } from '@/domain/delivery/documentSyncConfig'
import { runDocumentSyncLive } from '@/domain/delivery/documentSyncService'
import { runJobHealthCheck } from '@/domain/crm/jobHealth'

export const maxDuration = 60

/** Kontrola kalendáře dostane nejvýš tolik; zbytek minuty patří hlídači. */
const CALENDAR_BUDGET_MS = 25_000
/** Kontrola dokumentů (jen když je zapnutá) dostane nejvýš tolik. */
const DOCUMENTS_BUDGET_MS = 15_000

function authorized(header: string | null, secret: string | undefined): boolean {
  if (!secret || !header) return false
  // Hash srovná délky, takže timingSafeEqual nevyzradí ani délku tajemství.
  const a = createHash('sha256').update(header).digest()
  const b = createHash('sha256').update(`Bearer ${secret}`).digest()
  return timingSafeEqual(a, b)
}

export async function GET(request: Request) {
  if (process.env.FOLLOWUP_WATCH_ENABLED !== 'true') {
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
      if (e) logError('cron.followUps.finish', e, { runId })
    },
  }

  // runJob výjimku nepustí ven (zapíše 'failed'); try/catch je pojistka pro
  // chybu samotného zámku, ať hlídač follow-upů proběhne vždy.
  let calendar: JobResult | { status: 'disabled' } | { status: 'error'; error: string } = { status: 'disabled' }
  if (calendarSyncEnabledFromEnv(process.env)) {
    try {
      calendar = await runJob(jobDb, CALENDAR_SYNC_JOB, CALENDAR_SYNC_TTL_SECONDS, async () =>
        (await runMeetingCalendarSyncLive({ kind: 'cron' }, { budgetMs: CALENDAR_BUDGET_MS })) as unknown as Record<string, unknown>)
    } catch (e) {
      logError('cron.followUps.calendar', e)
      calendar = { status: 'error', error: e instanceof Error ? e.message : String(e) }
    }
  }

  // Kontrola dokumentů dodávek (SharePoint): výchozí vypnuto; chyba hlídač nezastaví.
  let documents: JobResult | { status: 'disabled' } | { status: 'error'; error: string } = { status: 'disabled' }
  if (docSyncEnabledFromEnv(process.env)) {
    try {
      documents = await runJob(jobDb, DOC_SYNC_JOB, DOC_SYNC_TTL_SECONDS, async () =>
        (await runDocumentSyncLive({ budgetMs: DOCUMENTS_BUDGET_MS })) as unknown as Record<string, unknown>)
    } catch (e) {
      logError('cron.followUps.documents', e)
      documents = { status: 'error', error: e instanceof Error ? e.message : String(e) }
    }
  }

  const followUps = await runFollowUpWatchJob({
    jobDb,
    watchDb: createFollowUpWatchDb(admin),
    recordSuccess: recordConnectorSuccess,
    recordError: recordConnectorError,
    connector: FOLLOW_UP_WATCH_CONNECTOR,
    now: () => new Date(),
  })

  // Audit zápisů vypršení nese aktéra úlohy (x-cockpit-audit-actor).
  const expiryClient = createAuditedAdminClient({ actor: { type: 'system', id: APPROVAL_EXPIRY_JOB } })
  const approvalExpiry = await runApprovalExpiryJob({
    jobDb,
    expiryDb: {
      async expireDueApprovals(limit) {
        const { data, error } = await expiryClient.rpc('expire_due_approvals', { p_limit: limit })
        return { data, error: error ? { code: error.code, message: error.message } : null }
      },
    },
  })
  if (approvalExpiry.status === 'failed') logError('cron.approvalExpiry', new Error(approvalExpiry.error))

  // Až po ostatních úlohách: ať vidí i jejich dnešní běhy. Nevyhazuje.
  const check = await runJobHealthCheck(admin)
  const jobHealth = {
    closedStale: check.closed,
    problems: check.health ? check.health.problems.map((p) => ({ job: p.job, kind: p.kind, at: p.at })) : null,
  }

  const failed = followUps.status === 'failed' || approvalExpiry.status === 'failed'
  return NextResponse.json({ ...followUps, calendar, documents, approvalExpiry, jobHealth }, { status: failed ? 500 : 200 })
}
