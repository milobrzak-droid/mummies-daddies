// Nasazení schopnosti „příchozí e-mail → doložený návrh pracovního případu"
// (core/agents/mailToCase.ts) nad CRM daty: kontext pro vstup (jméno firmy,
// naše poslední odchozí zpráva, dřívější pošta, jestli se firma už řeší)
// a spuštění šablony. Firmu (tenant) dostává jako parametr, takže testy
// pouštějí tentýž kód s konfigurací firmy i druhé, testovací firmy
//
// Běží v cron jobu Outlook syncu (app/api/cron/outlook-mail/route.ts) PO
// zápisu událostí obou složek — pravidlo „odpověď na naši zprávu" tak vidí
// i odchozí poštu z téhož běhu. Za příznakem CAPABILITY_MAIL_TO_CASE_ENABLED.
//
// Kontext čte service-role klient (cron nemá uživatele). Čte jen metadata:
// mail_event (kdy a kterým směrem), account.name, stav případů a návrhů.
import type { SupabaseClient } from '@supabase/supabase-js'
import type { NormalizedEvent } from '@/core/connectors/contract'
import { CapabilityAbort, runCapability, type CapabilityRunStats, type Classifier, type ProposalSink } from '@/core/agents/template'
import {
  MAIL_TO_CASE,
  mailToCaseRuntime,
  type MailToCaseInput,
  type MailToCaseOutput,
} from '@/core/agents/mailToCase'
import { isProposalsMigrationMissing, PROPOSALS_MIGRATION_PENDING_MESSAGE } from '@/core/agents/caseProposal'
import { ACTIVE_CASE_STATUSES, MIGRATION_PENDING_MESSAGE } from '@/core/workCaseFlow'
import type { CompanyConfig } from '@/core/tenant'

/** Kontext z DB pro jednu příchozí zprávu. */
export interface MailToCaseContext {
  accountName(accountId: number): Promise<string | null>
  /** Naše poslední odchozí zpráva firmě PŘED daným okamžikem (ISO), nebo null. */
  lastOutboundBefore(accountId: number, beforeIso: string): Promise<string | null>
  /** Existuje s firmou pošta (oba směry) starší než daný okamžik? */
  hasMailBefore(accountId: number, beforeIso: string): Promise<boolean>
  /** Má firma v uzlu aktivní případ nebo čekající návrh? */
  alreadyTracked(accountId: number, node: string): Promise<boolean>
  /** Zamítl člověk návrh pro firmu a uzel až po daném okamžiku (ISO)? */
  rejectedAfter(accountId: number, node: string, afterIso: string): Promise<boolean>
}

/** Událost + kontext → vstup schopnosti; null = událost se netýká známé firmy. */
export async function buildMailToCaseInput(
  event: NormalizedEvent,
  ctx: MailToCaseContext,
  node: string,
  now: Date,
): Promise<MailToCaseInput | null> {
  if (event.subject?.kind !== 'account') return null
  const accountId = event.subject.id
  const accountName = await ctx.accountName(accountId)
  if (!accountName) return null
  const [lastOutboundAt, hasEarlierMail, alreadyTracked, rejectedLater] = await Promise.all([
    ctx.lastOutboundBefore(accountId, event.occurred_at),
    ctx.hasMailBefore(accountId, event.occurred_at),
    ctx.alreadyTracked(accountId, node),
    ctx.rejectedAfter(accountId, node, event.occurred_at),
  ])
  return {
    occurredAt: event.occurred_at,
    now: now.toISOString(),
    title: event.title,
    accountId,
    accountName,
    hasEvidence: event.evidence !== null,
    lastOutboundAt,
    hasEarlierMail,
    alreadyTracked,
    rejectedLater,
  }
}

export type MailToCaseRunResult = CapabilityRunStats | { capability: string; disabled: true }

export async function runMailToCase(opts: {
  tenant: CompanyConfig
  events: readonly NormalizedEvent[]
  context: MailToCaseContext
  sink: ProposalSink<unknown, MailToCaseOutput>
  /** Volitelný LLM klasifikátor; bez něj rozhodují pravidla. */
  classify?: Classifier
  now: Date
  /** Společný deadline běhu crona: true = další událost nezačínat (zbytek do `deferred`). */
  shouldStop?: () => boolean
}): Promise<MailToCaseRunResult> {
  const cfg = mailToCaseRuntime(opts.tenant)
  if (!cfg) return { capability: MAIL_TO_CASE.id, disabled: true }
  return runCapability(MAIL_TO_CASE, cfg, opts.events, {
    loadInput: (event) => buildMailToCaseInput(event, opts.context, cfg.settings.node, opts.now),
    sink: opts.sink,
    classify: opts.classify,
    shouldStop: opts.shouldStop,
  })
}

// ---------------------------------------------------------------------------
// Kontext nad Supabase (service role)

type Db = Pick<SupabaseClient, 'from'>

function fail(table: string, error: { code?: string | null } | null): never {
  throw new Error(`${table}: ${error?.code ?? 'chyba čtení'}`)
}

export function supabaseMailToCaseContext(db: Db): MailToCaseContext {
  return {
    async accountName(accountId) {
      const { data, error } = await db.from('account').select('name').eq('id', accountId).maybeSingle()
      if (error) fail('account', error)
      const name = (data as { name?: string | null } | null)?.name
      return typeof name === 'string' && name.trim() !== '' ? name : null
    },
    async lastOutboundBefore(accountId, beforeIso) {
      const { data, error } = await db
        .from('mail_event')
        .select('occurred_at')
        .eq('account_id', accountId)
        .eq('direction', 'outbound')
        .lt('occurred_at', beforeIso)
        .order('occurred_at', { ascending: false })
        .limit(1)
      if (error) fail('mail_event', error)
      const at = (data as { occurred_at: string }[] | null)?.[0]?.occurred_at
      return at ? new Date(at).toISOString() : null
    },
    async hasMailBefore(accountId, beforeIso) {
      const { data, error } = await db
        .from('mail_event')
        .select('id')
        .eq('account_id', accountId)
        .lt('occurred_at', beforeIso)
        .limit(1)
      if (error) fail('mail_event', error)
      return ((data as unknown[] | null) ?? []).length > 0
    },
    async alreadyTracked(accountId, node) {
      const [cases, proposals] = await Promise.all([
        db
          .from('work_case')
          .select('id')
          .eq('account_id', accountId)
          .eq('node', node)
          .in('status', [...ACTIVE_CASE_STATUSES])
          .limit(1),
        db
          .from('case_proposal')
          .select('id')
          .eq('account_id', accountId)
          .eq('node', node)
          .eq('status', 'pending')
          .limit(1),
      ])
      if (isProposalsMigrationMissing(cases.error)) throw new CapabilityAbort(MIGRATION_PENDING_MESSAGE)
      if (isProposalsMigrationMissing(proposals.error)) throw new CapabilityAbort(PROPOSALS_MIGRATION_PENDING_MESSAGE)
      if (cases.error) fail('work_case', cases.error)
      if (proposals.error) fail('case_proposal', proposals.error)
      return ((cases.data as unknown[] | null) ?? []).length > 0 || ((proposals.data as unknown[] | null) ?? []).length > 0
    },
    async rejectedAfter(accountId, node, afterIso) {
      const { data, error } = await db
        .from('case_proposal')
        .select('id')
        .eq('account_id', accountId)
        .eq('node', node)
        .eq('status', 'rejected')
        .gt('decided_at', afterIso)
        .limit(1)
      if (isProposalsMigrationMissing(error)) throw new CapabilityAbort(PROPOSALS_MIGRATION_PENDING_MESSAGE)
      if (error) fail('case_proposal', error)
      return ((data as unknown[] | null) ?? []).length > 0
    },
  }
}
