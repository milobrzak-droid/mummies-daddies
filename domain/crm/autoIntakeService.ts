// Automatické založení poptávky z příchozího e-mailu — I/O kolem pravidel
// (domain/crm/autoIntake.ts). Atomické založení dělá RPC auto_intake_found
// (migrace 0081): tady se jen načte kontext, kandidáti se rozdělí na
// „založit / navrhnout / nic" a výsledek se spočítá do statistik.
//
// Volá se po syncu pošty z app/api/cron/outlook-mail (denní cron) a
// z webhooku pošty (domain/crm/mailSyncService.ts) — vždy s kandidáty, které
// sync sesbíral (`collectIntake`), a za přepínačem CAPABILITY_AUTO_INTAKE_ENABLED.
//
// Tok jedné zprávy:
//   pravidla (decideIntake) →
//     skip     nic
//     auto     evidence (ukazatel na zprávu) → RPC auto_intake_found → created |
//              attached | duplicate | rejected | ambiguous | name_conflict | limit
//     known    totéž (RPC u existujícího klienta založí jen aktivitu)
//     propose  návrh case_proposal (capability mail_new_inquiry), jeden na doménu
//   Když RPC řekne ambiguous / name_conflict / limit, zpráva NEZTRATÍ: jde jako
//   návrh, ať o ní rozhodne člověk.
//
// IDEMPOTENCE: RPC drží UNIQUE na Message-ID zprávy a advisory zámek, návrh
// UNIQUE (capability, source_key) s klíčem na doménu. Opakovaný sync téže
// zprávy tedy nezaloží nic dvakrát, ani při souběhu cronu s webhookem.
//
// SOUKROMÍ: adresa a jméno odesílatele (IntakeCandidate) žijí jen v paměti
// běhu a odejdou jedinou cestou — do RPC jako kontakt při VYSOKÉ jistotě.
// Do logu jde jen kód chyby, do statistik jen počty a id nových klientů
// (statistiky končí v job_run.stats a v odpovědi cronu). Chyby databáze se
// zapisují jen kódem: Postgres v detailu cituje celý řádek.

import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { COMPANY } from '@/config'
import type { CompanyConfig } from '@/core/tenant'
import type { AuditContext } from '@/core/auditCoverage'
import { createAuditedAdminClient } from '@/core/auditDb'
import { createAdminClient } from '@/lib/supabase/admin'
import { recordEvidence } from '@/core/evidence'
import { eventKey, type NormalizedEvent } from '@/core/connectors/contract'
import { caseProposalSink, isProposalsMigrationMissing } from '@/core/agents/caseProposal'
import { CapabilityAbort, type CaseProposalOutput, type ProposalDraft } from '@/core/agents/template'
import { logError } from '@/lib/log'
import { domainOf } from '@/domain/crm/meetingMatch'
import {
  ARES_ENRICH_SYSTEM_ACTOR,
  liveAresSource,
  runAresEnrichment,
  supabaseAresEnrichDb,
  type AresEnrichStats,
} from '@/domain/crm/aresEnrich'
import {
  AUTO_INTAKE_ACTOR,
  AUTO_INTAKE_CAPABILITY,
  AUTO_INTAKE_MAX_CANDIDATES_PER_RUN,
  AUTO_INTAKE_MAX_PROPOSALS_PER_RUN,
  AUTO_INTAKE_MIGRATION_PENDING_MESSAGE,
  AUTO_INTAKE_PROPOSAL_EVENT_TYPE,
  AUTO_INTAKE_PROPOSAL_SOURCE,
  INTAKE_FREEMAIL,
  autoIntakeConfigIssues,
  buildFoundPayload,
  buildProposalText,
  companyNameFor,
  decideIntake,
  domainFromProposalKey,
  hostFromWeb,
  resolveDailyLimit,
  type IntakeCandidate,
  type IntakeCaution,
  type IntakeContext,
  type IntakeDecision,
} from '@/domain/crm/autoIntake'

type Db = Pick<SupabaseClient, 'from' | 'rpc'>

export type AutoIntakeDeps = {
  tenant: CompanyConfig
  candidates: readonly IntakeCandidate[]
  /** team_member.id vlastníka schránky (OUTLOOK_MAIL_SYNC_MEMBER_ID) — vlastník klienta, obchodu i úkolu. */
  ownerId: string
  now: Date
  env?: Record<string, string | undefined>
  /** Servisní klient bez hlaviček: čtení kontextu, evidence, návrhy. */
  db: Db
  /** Servisní klient s hlavičkami aktéra/původu pro audit řádků, které zakládá RPC. */
  auditedDb: (ctx: AuditContext) => Db
  /**
   * Společný deadline běhu (cron pošty): true = další zprávu už nezačínat.
   * Nezpracované zprávy se jen spočítají do `deferred` (žádná se nezaloží napůl).
   */
  shouldStop?: () => boolean
}

export type AutoIntakeStats = {
  capability: 'auto_intake'
  /** Kandidáti po deduplikaci a ořezu. */
  candidates: number
  created: number
  /** Doména už v CRM byla → jen aktivita u existujícího klienta. */
  attached: number
  /** Návrhy nižší jistoty založené v tomhle běhu. */
  proposed: number
  duplicates: number
  skipped: Record<string, number>
  /** Denní limit byl v tomhle běhu vyčerpán (zbytek šel jako návrhy). */
  limitReached: boolean
  dailyLimit: number
  errors: number
  firstError?: string
  /** Běh skončil předčasně (chybí migrace, špatná konfigurace). */
  aborted?: string
  disabled?: true
  /** Id nově založených klientů (pro ARES); žádná jména ani adresy. */
  createdAccountIds: number[]
  /** Kolik kandidátů se kvůli deadlinu běhu nezpracovalo. */
  deferred?: number
}

function emptyStats(dailyLimit: number): AutoIntakeStats {
  return {
    capability: 'auto_intake', candidates: 0, created: 0, attached: 0, proposed: 0, duplicates: 0, skipped: {},
    limitReached: false, dailyLimit, errors: 0, createdAccountIds: [],
  }
}

// ---------------------------------------------------------------------------
// Kontext z databáze

const PAGE = 1000
const MAX_PAGES = 20

async function fetchAll<T>(
  page: (from: number, to: number) => PromiseLike<{ data: unknown; error: unknown }>,
): Promise<T[]> {
  const out: T[] = []
  for (let i = 0; i < MAX_PAGES; i++) {
    const { data, error } = await page(i * PAGE, i * PAGE + PAGE - 1)
    if (error) throw error
    const rows = (data ?? []) as T[]
    out.push(...rows)
    if (rows.length < PAGE) break
  }
  return out
}

/** Do logu jen kód chyby — Postgres v detailu často cituje celý řádek. */
function logDbError(scope: string, error: unknown, context: Record<string, unknown> = {}): void {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
  logError(scope, 'chyba databáze', { code: typeof code === 'string' ? code : 'unknown', ...context })
}

const errorCode = (e: unknown): string => {
  const code = typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined
  return typeof code === 'string' ? code : e instanceof Error ? e.name : 'chyba'
}

type MutableContext = Omit<IntakeContext, 'knownDomains' | 'proposedDomains' | 'rejectedDomains' | 'knownAddresses'> & {
  knownDomains: Map<string, number[]>
  knownAddresses: Map<string, number>
  proposedDomains: Set<string>
  rejectedDomains: Set<string>
}

const addKnown = (map: Map<string, number[]>, domain: string | null, accountId: number): void => {
  if (!domain || INTAKE_FREEMAIL.has(domain)) return
  const list = map.get(domain) ?? []
  if (!list.includes(accountId)) list.push(accountId)
  map.set(domain, list)
}

/**
 * Co o doménách víme: klienti (kontakty, aliasy, web), partneři, zamítnuté
 * domény („Není poptávka", zamítnutý návrh) a domény s návrhem. Chybějící
 * tabulka auto_intake (0081) = AutoIntakeMigrationMissing; chybějící
 * case_proposal (0067) = žádné návrhy a zamítnuté návrhy.
 */
export async function loadIntakeContext(
  db: Pick<SupabaseClient, 'from'>,
  args: { tenant: CompanyConfig; ownerId: string; now: Date; env: Record<string, string | undefined> },
): Promise<MutableContext> {
  const cfg = args.tenant.capabilities.autoIntake
  if (!cfg) throw new Error('autoIntake není nakonfigurované')

  const [contacts, aliases, accounts, ledger, proposals, member] = await Promise.all([
    fetchAll<{ account_id: number | null; partner_id: number | null; email: string | null }>((from, to) =>
      db.from('contact').select('account_id, partner_id, email').not('email', 'is', null).order('id').range(from, to)),
    fetchAll<{ account_id: number; alias_domain: string | null }>((from, to) =>
      db.from('company_alias').select('account_id, alias_domain').not('alias_domain', 'is', null).order('id').range(from, to)),
    fetchAll<{ id: number; web: string | null }>((from, to) =>
      db.from('account').select('id, web').not('web', 'is', null).order('id').range(from, to)),
    db.from('auto_intake').select('domain').eq('status', 'undone'),
    db.from('case_proposal').select('source_key, status').eq('capability', AUTO_INTAKE_CAPABILITY),
    db.from('team_member').select('email').eq('id', args.ownerId).maybeSingle(),
  ])

  if (ledger.error) {
    if (isProposalsMigrationMissing(ledger.error)) throw new AutoIntakeMigrationMissing()
    throw ledger.error
  }

  const knownDomains = new Map<string, number[]>()
  const knownAddresses = new Map<string, number>()
  const partnerDomains = new Set<string>()
  for (const c of contacts) {
    const email = c.email?.trim().toLowerCase() ?? ''
    const d = domainOf(email)
    if (!email.includes('@') || !d) continue
    if (c.account_id != null) {
      knownAddresses.set(email, c.account_id)
      addKnown(knownDomains, d, c.account_id)
    } else if (c.partner_id != null && !INTAKE_FREEMAIL.has(d)) {
      partnerDomains.add(d)
    }
  }
  for (const a of aliases) addKnown(knownDomains, a.alias_domain?.trim().toLowerCase().replace(/^@/, '') ?? null, a.account_id)
  for (const a of accounts) addKnown(knownDomains, hostFromWeb(a.web), a.id)

  const rejectedDomains = new Set<string>()
  for (const r of (ledger.data ?? []) as { domain: string }[]) rejectedDomains.add(r.domain)
  const proposedDomains = new Set<string>()
  if (proposals.error) {
    // Bez case_proposal nejde ani navrhovat; zamítnuté návrhy ale neexistují.
    if (!isProposalsMigrationMissing(proposals.error)) throw proposals.error
  } else {
    for (const p of (proposals.data ?? []) as { source_key: string; status: string }[]) {
      const d = domainFromProposalKey(p.source_key)
      if (!d) continue
      proposedDomains.add(d)
      if (p.status === 'rejected') rejectedDomains.add(d)
    }
  }

  if (member.error) throw member.error
  const mailbox = (member.data as { email?: string | null } | null)?.email?.trim().toLowerCase() ?? null

  return {
    ourDomains: new Set([args.tenant.emailDomain.toLowerCase(), ...cfg.internalDomains.map((d) => d.toLowerCase())]),
    mailboxAddress: mailbox && mailbox.includes('@') ? mailbox : null,
    partnerDomains,
    rejectedDomains,
    proposedDomains,
    knownDomains,
    knownAddresses,
    automatedDomains: new Set(cfg.automatedDomains.map((d) => d.toLowerCase())),
    rules: cfg,
    now: args.now,
  }
}

/** Vlastní chyba s bezpečným textem (jen kód z databáze, nikdy data) — smí do statistik běhu. */
class AutoIntakeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AutoIntakeError'
  }
}

export class AutoIntakeMigrationMissing extends Error {
  constructor() {
    super(AUTO_INTAKE_MIGRATION_PENDING_MESSAGE)
    this.name = 'AutoIntakeMigrationMissing'
  }
}

// ---------------------------------------------------------------------------
// Výsledek RPC auto_intake_found

const foundResultSchema = z.object({
  status: z.enum(['created', 'duplicate', 'rejected', 'attached', 'ambiguous', 'name_conflict', 'limit']),
  id: z.number().nullish(),
  account_id: z.number().nullish(),
  account_ids: z.array(z.number()).nullish(),
})
export type FoundResult = z.infer<typeof foundResultSchema>

// ---------------------------------------------------------------------------
// Běh

export async function runAutoIntake(deps: AutoIntakeDeps): Promise<AutoIntakeStats> {
  const env = deps.env ?? {}
  const cfg = deps.tenant.capabilities.autoIntake
  if (!cfg) return { ...emptyStats(0), disabled: true }
  const dailyLimit = resolveDailyLimit(cfg, env)
  const stats = emptyStats(dailyLimit)

  const issues = autoIntakeConfigIssues(cfg, deps.tenant.nodes)
  if (issues.length > 0) {
    stats.aborted = `konfigurace: ${issues.join('; ')}`
    return stats
  }

  // Chronologicky, jedna zpráva jednou; strop chrání před první synchronizací
  // celé historie (stáří odfiltrují pravidla, ale zbytečně je nenačítat).
  const seen = new Set<string>()
  const list = [...deps.candidates]
    .filter((c) => (seen.has(c.messageId) ? false : (seen.add(c.messageId), true)))
    .sort((a, b) => Date.parse(a.occurredAt) - Date.parse(b.occurredAt))
    .slice(-AUTO_INTAKE_MAX_CANDIDATES_PER_RUN)
  stats.candidates = list.length
  if (list.length === 0) return stats

  let ctx: MutableContext
  try {
    ctx = await loadIntakeContext(deps.db, { tenant: deps.tenant, ownerId: deps.ownerId, now: deps.now, env })
  } catch (e) {
    if (e instanceof AutoIntakeMigrationMissing) {
      stats.aborted = e.message
    } else {
      logDbError('autoIntake.context', e)
      stats.errors++
      stats.firstError = `kontext: ${errorCode(e)}`
    }
    return stats
  }

  const skip = (reason: string) => {
    stats.skipped[reason] = (stats.skipped[reason] ?? 0) + 1
  }

  const accountNames = async (ids: readonly number[]): Promise<string[]> => {
    if (ids.length === 0) return []
    const { data, error } = await deps.db.from('account').select('id, name').in('id', ids.slice(0, 4))
    if (error) return []
    return ((data ?? []) as { name: string | null }[]).map((r) => r.name?.trim()).filter((n): n is string => !!n)
  }

  async function propose(c: IntakeCandidate, domain: string, cautions: readonly IntakeCaution[], related: readonly number[]): Promise<void> {
    if (ctx.proposedDomains.has(domain)) return skip('has_proposal')
    if (stats.proposed >= AUTO_INTAKE_MAX_PROPOSALS_PER_RUN) return skip('proposal_limit')
    const text = buildProposalText(domain, cautions, cfg!, cautions.includes('two_clients') ? await accountNames(related) : [])
    const event: NormalizedEvent<null> = {
      source: AUTO_INTAKE_PROPOSAL_SOURCE,
      type: AUTO_INTAKE_PROPOSAL_EVENT_TYPE,
      external_id: domain,
      occurred_at: c.occurredAt,
      subject: related.length === 1 ? { kind: 'account', id: related[0] } : null,
      participants: [{ role: 'from', accountId: null, contactId: null, domain }],
      evidence: { kind: 'email_message', sourceId: c.messageId, webLink: c.webLink },
      title: null,
      payload: null,
    }
    const draft: ProposalDraft<null, CaseProposalOutput> = {
      capability: AUTO_INTAKE_CAPABILITY,
      sourceKey: eventKey(event),
      event,
      output: text,
      reasons: cautions.map((x) => x),
      method: 'rule',
      infoState: 'ai_suggestion',
      target: { node: cfg!.node, accountId: related.length === 1 ? related[0] : null, steps: cfg!.proposalSteps },
    }
    const result = await caseProposalSink<null, CaseProposalOutput>(deps.db, {
      createdBy: `system:${AUTO_INTAKE_CAPABILITY}`,
    }).propose(draft)
    ctx.proposedDomains.add(domain)
    if (result === 'created') stats.proposed++
    else stats.duplicates++
  }

  async function found(c: IntakeCandidate, decision: Extract<IntakeDecision, { kind: 'auto' | 'known' }>): Promise<void> {
    const evidence = await recordEvidence(
      deps.db,
      { kind: 'email_message', sourceId: c.messageId, webLink: c.webLink },
      `system:${AUTO_INTAKE_ACTOR}`,
    )
    const payload = buildFoundPayload({
      candidate: c,
      decision,
      companyName: decision.kind === 'auto' ? decision.companyName : companyNameFor(c, decision.domain),
      cfg: cfg!,
      ownerId: deps.ownerId,
      evidenceId: evidence.ok ? evidence.id : null,
      dailyLimit,
      now: deps.now,
    })
    const client = deps.auditedDb({
      actor: { type: 'system', id: AUTO_INTAKE_ACTOR },
      evidenceId: evidence.ok ? evidence.id : null,
      infoState: 'source_fact',
    })
    const { data, error } = await client.rpc('auto_intake_found', { p: payload })
    if (error) {
      if (isProposalsMigrationMissing(error)) throw new CapabilityAbort(AUTO_INTAKE_MIGRATION_PENDING_MESSAGE)
      logDbError('autoIntake.found', error)
      throw new AutoIntakeError(`auto_intake_found: ${errorCode(error)}`)
    }
    const parsed = foundResultSchema.safeParse(data)
    if (!parsed.success) throw new AutoIntakeError('auto_intake_found: neočekávaná odpověď')
    const res = parsed.data
    switch (res.status) {
      case 'created':
        stats.created++
        if (typeof res.account_id === 'number') {
          stats.createdAccountIds.push(res.account_id)
          // Další zpráva téže domény v tomhle běhu už klienta zná (jen aktivita).
          addKnown(ctx.knownDomains, decision.domain, res.account_id)
          ctx.knownAddresses.set(c.fromAddress, res.account_id)
        }
        return
      case 'attached':
        stats.attached++
        return
      case 'duplicate':
        stats.duplicates++
        return
      case 'rejected':
        ctx.rejectedDomains.add(decision.domain)
        return skip('rejected')
      case 'ambiguous':
        return propose(c, decision.domain, ['two_clients'], res.account_ids ?? [])
      case 'name_conflict':
        return propose(c, decision.domain, ['name_conflict'], [])
      case 'limit':
        stats.limitReached = true
        return propose(c, decision.domain, ['limit'], [])
    }
  }

  for (const [i, c] of list.entries()) {
    if (deps.shouldStop?.()) {
      stats.deferred = list.length - i
      break
    }
    try {
      const decision = decideIntake(c, ctx)
      if (decision.kind === 'skip') skip(decision.reason)
      else if (decision.kind === 'propose') await propose(c, decision.domain, decision.cautions, decision.relatedAccountIds)
      else await found(c, decision)
    } catch (e) {
      if (e instanceof CapabilityAbort) {
        stats.aborted = e.message.slice(0, 300)
        break
      }
      stats.errors++
      const what = e instanceof AutoIntakeError ? e.message : errorCode(e)
      stats.firstError ??= what
      logError('autoIntake', 'zpracování zprávy selhalo', { code: what })
    }
  }
  return stats
}

/** Skutečné klienty: servisní klíč, hlavičky aktéra pro audit, aktivní konfigurace firmy. */
export async function runAutoIntakeLive(args: {
  candidates: readonly IntakeCandidate[]
  ownerId: string
  now?: Date
  tenant?: CompanyConfig
  env?: Record<string, string | undefined>
  shouldStop?: () => boolean
}): Promise<AutoIntakeStats> {
  return runAutoIntake({
    shouldStop: args.shouldStop,
    tenant: args.tenant ?? COMPANY,
    candidates: args.candidates,
    ownerId: args.ownerId,
    now: args.now ?? new Date(),
    env: args.env ?? process.env,
    db: createAdminClient(),
    auditedDb: (ctx) => createAuditedAdminClient(ctx),
  })
}

// ---------------------------------------------------------------------------
// ARES: doplnění IČO u nových klientů (existující automatika, zúžená na ně)

/**
 * Doplnění IČO a sídla z ARESu jen u právě založených klientů. Stejná
 * pravidla jako denní dávka (přesná shoda jména, nikdy cizí IČO); klient,
 * u kterého to teď nevyjde, zůstává ve frontě, kterou denní cron
 * ARES_ENRICH_ENABLED projede sám. Volající drží zámek úlohy ares-enrich.
 */
export async function runAresForNewAccounts(
  accountIds: readonly number[],
  opts: { budgetMs?: number; requestTimeoutMs?: number; client?: Pick<SupabaseClient, 'from'> } = {},
): Promise<AresEnrichStats | null> {
  if (accountIds.length === 0) return null
  const client = opts.client ?? createAdminClient()
  return runAresEnrichment(
    supabaseAresEnrichDb(client, ARES_ENRICH_SYSTEM_ACTOR, { onlyAccountIds: accountIds }),
    liveAresSource,
    {
      limit: accountIds.length,
      budgetMs: opts.budgetMs ?? 15_000,
      ...(opts.requestTimeoutMs !== undefined ? { requestTimeoutMs: opts.requestTimeoutMs } : {}),
    },
  )
}
