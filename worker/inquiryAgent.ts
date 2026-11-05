// Úloha 'inquiry-agent' (P2): přečte schránky Gmailu do fronty a frontu
// zpracuje (e-mail i webové poptávky). Obal runJob = zámek proti překryvu
// a záznam v job_run (jen počty a kódy, nikdy text ani adresy).
//
// Rozpočet: route má maxDuration 300 s. Jeden deadline (INQUIRY_AGENT_BUDGET_MS)
// sdílí čtení schránek (nejvýš MAILBOX_SYNC_MAX_MS) a zpracování fronty;
// zpracování končí s rezervou PROCESS_RESERVE_MS (jedno volání modelu trvá
// až 45 s), zbytek fronty počká na další běh. Pojistka runJob zapíše
// job_run do INQUIRY_AGENT_HARD_TIMEOUT_MS.
import type { SupabaseClient } from '@supabase/supabase-js'
import { extractInquiryWithModel } from '@/connectors/anthropic'
import { createDistanceResolver } from '@/connectors/geo'
import { COMPANY } from '@/config'
import type { InquiryAgentConfig } from '@/core/agents/inquiryAgentConfig'
import { createInquiryAgentStore, runInquiryAgent, type InquiryAgentStats } from '@/domain/crm/inquiryAgentService'
import { createGmailMailPort, createGmailPort, createMailboxStore, syncInquiryMailboxes, type MailboxSyncStats } from '@/domain/crm/inquiryMailboxService'
import { createDeadline, type Deadline } from './deadline'
import { runJob, type JobDbAdapter, type JobResult } from './jobRunner'

export const INQUIRY_AGENT_JOB_NAME = 'inquiry-agent'
export const INQUIRY_AGENT_MAX_DURATION_S = 300
export const INQUIRY_AGENT_BUDGET_MS = 285_000
export const INQUIRY_AGENT_HARD_TIMEOUT_MS = 292_000
export const INQUIRY_AGENT_TTL_SECONDS = 330
export const MAILBOX_SYNC_MAX_MS = 60_000
export const PROCESS_RESERVE_MS = 55_000

export type InquiryAgentJobStats = { mailbox: MailboxSyncStats | { error: string }; agent: InquiryAgentStats; purged: number | null }

/** Retence fronty (dny); CRM zápisy zůstávají. */
export const INQUIRY_AGENT_RETENTION_DAYS = 90

type Admin = Pick<SupabaseClient, 'from' | 'rpc'>

/** Tělo úlohy (bez zámku) — sdílí ho cron i případné ruční spuštění. */
export async function runInquiryAgentJobBody(admin: Admin, deadline: Deadline = createDeadline(INQUIRY_AGENT_BUDGET_MS)): Promise<InquiryAgentJobStats> {
  const syncEnd = Date.now() + Math.min(MAILBOX_SYNC_MAX_MS, Math.max(deadline.remaining() - PROCESS_RESERVE_MS, 0))
  let mailbox: InquiryAgentJobStats['mailbox']
  try {
    mailbox = await syncInquiryMailboxes({
      gmail: createGmailPort(),
      store: createMailboxStore(admin),
      timeUp: () => Date.now() >= syncEnd || deadline.passed(PROCESS_RESERVE_MS),
    })
  } catch (e) {
    // Výpadek čtení schránek nesmí zastavit zpracování už zařazené fronty (ani webu).
    mailbox = { error: e instanceof Error ? e.message.slice(0, 200) : 'chyba' }
  }

  const cfg = COMPANY.capabilities.inquiryAgent as InquiryAgentConfig
  const agent = await runInquiryAgent({
    store: createInquiryAgentStore(admin),
    mail: createGmailMailPort(),
    extract: extractInquiryWithModel,
    distanceKm: createDistanceResolver(cfg.originAddress),
    timeUp: () => deadline.passed(PROCESS_RESERVE_MS),
  })

  // Retence fronty běží při každém běhu; chyba retence běh neshodí.
  const { data, error } = await admin.rpc('inquiry_agent_purge', { p_days: INQUIRY_AGENT_RETENTION_DAYS })
  const purged = error ? null : typeof data === 'number' ? data : null
  return { mailbox, agent, purged }
}

export function runInquiryAgentJob(jobDb: JobDbAdapter, body: () => Promise<InquiryAgentJobStats>): Promise<JobResult> {
  return runJob(jobDb, INQUIRY_AGENT_JOB_NAME, INQUIRY_AGENT_TTL_SECONDS, body as () => Promise<Record<string, unknown>>, {
    timeoutMs: INQUIRY_AGENT_HARD_TIMEOUT_MS,
  })
}
