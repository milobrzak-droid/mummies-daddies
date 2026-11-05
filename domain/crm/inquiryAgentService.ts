// Agent příchozích poptávek (P2) — zpracování fronty (I/O).
//
// Jeden běh (úloha 'inquiry-agent', worker/inquiryAgent.ts):
//   1) e-mail: inquiry_agent_claim → tělo zprávy z Gmailu JEN v paměti →
//      ověření odesílatele (SPF/DKIM/DMARC) → latestReplyText → decideInquiry
//      (model jen čte, cenu počítá mapa) → pojistky agenta → CRM zápis
//      inquiry_agent_found → eskalace (case_proposal) nebo odchozí fronta
//      agent_outbox_enqueue (P3) → inquiry_agent_finish;
//   2) web: web_inquiry_claim → stejné rozhodnutí BEZ modelu
//      (webInquiryToOfferInquiry → evaluateStandardOffer) → stejný CRM zápis
//      a stejná odchozí fronta (mode {to: e-mail}, source_ref 'web:<id>').
//
// Pojistky provozu:
//   - strop zpráv za běh (maxPerRun) a společný deadline úlohy;
//   - denní strop volání modelu (modelDailyLimit); po něm zpráva čeká na další den;
//   - výpadek modelu (přetížení, limit, kredit, timeout) = odklad s backoffem,
//     eskalace až po modelMaxAttempts pokusech;
//   - chybí agent_outbox_enqueue (P3 nenasazený) = stav 'decided' s konceptem
//     odpovědi, další běh to zkusí znovu (web: zpět na 'new').
//
// Osobní údaje: tělo, předmět, jméno ani adresa zákazníka se nikdy neloguje
// ani nejde do statistik běhu (job_run.stats) — jen počty a kódy.
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import { COMPANY } from '@/config'
import type { InquiryAgentConfig } from '@/core/agents/inquiryAgentConfig'
import { caseProposalSink } from '@/core/agents/caseProposal'
import { safeGreetingName } from '@/core/agents/inquiryReply'
import { decideInquiry, type InquiryDeps } from '@/core/agents/inquiryToOffer'
import { evaluateSenderAuth, headerAddresses, type HeaderLike } from '@/core/agents/mailAuth'
import { OUTBOX_ENQUEUE_RPC, outboxEnqueuePayload } from '@/core/agents/outboxPort'
import type { CaseProposalOutput, ProposalDraft } from '@/core/agents/template'
import type { EvidenceRef } from '@/core/informationState'
import { evaluateStandardOffer, renderInfoRequest, renderOfferEmail } from '@/core/standardOffer'
import type { StandardOfferConfig } from '@/core/tenant'
import { webInquiryToOfferInquiry } from '@/core/webInquiry'
import { logError } from '@/lib/log'
import { pragueToday, addDaysToPragueDay } from '@/lib/pragueDate'
import {
  INQUIRY_AGENT_ACTOR,
  applyAgentGates,
  applyFoundResult,
  contactName,
  escalateVerdict,
  escalationProposal,
  inquiryFoundPayload,
  isRpcMissing,
  isTransientModelError,
  leadCompany,
  leadLine,
  outboxItem,
  parseFoundResult,
  pragueDayStartIso,
  replyMailboxMember,
  replyMode,
  retryDelaySeconds,
  secondsUntilNextDay,
  verdictFromDecision,
  verdictFromOfferResult,
  type AgentVerdict,
  type FoundResult,
} from './inquiryAgent'
import { latestReplyText } from './mailContent'

// ---------------------------------------------------------------------------
// Porty (vstříknuté kvůli testům bez sítě a bez Supabase)

export type RunRow = {
  id: number
  internet_message_id: string
  graph_message_id: string
  thread_id: string | null
  mailbox: string
  mailbox_member_id: string | null
  received_at: string
  status: string
  attempts: number
  reply_draft: Record<string, unknown> | null
}

export type WebRow = {
  id: number
  received_at: string
  customer_name: string
  email: string
  company_name: string | null
  ico: string | null
  attempts: number
  inquiry: unknown
}

export type OutboxResult = { ok: true; outboxId: number; duplicate: boolean } | { ok: false; missing: boolean }

export interface InquiryAgentStore {
  claimRuns(limit: number): Promise<RunRow[]>
  finishRun(p: Record<string, unknown>): Promise<void>
  claimWeb(limit: number): Promise<WebRow[]>
  finishWeb(p: Record<string, unknown>): Promise<void>
  /** inquiry_agent_found; chyba = výjimka (bez textu dat). */
  found(p: Record<string, unknown>): Promise<FoundResult>
  enqueueOutbox(p: Record<string, unknown>): Promise<OutboxResult>
  /** Kolik zpráv dnes (od `sinceIso`) volalo model. */
  modelCallsSince(sinceIso: string): Promise<number>
  memberIdByEmail(email: string): Promise<string | null>
  /** VIP nebo „neoslovovat" (do_not_contact); chyba = true (opatrnost). */
  isVipEmail(email: string | null): Promise<boolean>
  propose(draft: ProposalDraft<Record<string, never>, CaseProposalOutput>): Promise<'created' | 'duplicate'>
}

export type FetchedMessage = { headers: HeaderLike[]; text: string }

export type MessageFetch =
  | { kind: 'ok'; message: FetchedMessage }
  | { kind: 'gone' }
  | { kind: 'retry'; seconds: number; code: string }

export interface MailPort {
  fetchMessage(mailbox: string, gmailMessageId: string): Promise<MessageFetch>
}

export type InquiryAgentDeps = {
  store: InquiryAgentStore
  mail: MailPort
  extract: InquiryDeps['extract']
  distanceKm: (venue: string) => Promise<number | null>
  now?: () => Date
  /** true = už je čas skončit (zbytek fronty zůstane na příště). */
  timeUp?: () => boolean
}

export type InquiryAgentStats = {
  claimed: number
  web: number
  send_offer: number
  ask_info: number
  escalate: number
  not_inquiry: number
  enqueued: number
  outboxPending: number
  retried: number
  failed: number
  skipped: number
  modelCalls: number
  released: number
}

const emptyStats = (): InquiryAgentStats => ({
  claimed: 0, web: 0, send_offer: 0, ask_info: 0, escalate: 0, not_inquiry: 0, enqueued: 0, outboxPending: 0,
  retried: 0, failed: 0, skipped: 0, modelCalls: 0, released: 0,
})

// ---------------------------------------------------------------------------
// Konfigurace

type AgentCfg = InquiryAgentConfig & Required<Pick<InquiryAgentConfig, 'dedupWindowDays' | 'modelDailyLimit' | 'modelMaxAttempts' | 'trustedAuthServId'>>

function agentConfig(): AgentCfg {
  const c = COMPANY.capabilities.inquiryAgent as InquiryAgentConfig | null | undefined
  if (!c) throw new Error('Firma nemá capabilities.inquiryAgent')
  return {
    ...c,
    dedupWindowDays: c.dedupWindowDays ?? 14,
    modelDailyLimit: c.modelDailyLimit ?? 100,
    modelMaxAttempts: c.modelMaxAttempts ?? 4,
    trustedAuthServId: c.trustedAuthServId ?? 'mx.google.com',
  }
}

const OFFER: StandardOfferConfig = COMPANY.capabilities.standardOffer

function revenueCategory(line: string): string {
  return (COMPANY.revenueLines ?? []).find((l) => l.key === line)?.category ?? 'one_time'
}

function eventTypeLabel(segment: string | null, eventType: string | null): string | null {
  if (!eventType) return null
  for (const s of OFFER.priceMap.segments) {
    if (segment && s.key !== segment) continue
    const e = s.eventTypes.find((x) => x.key === eventType)
    if (e) return e.label
  }
  return null
}

// ---------------------------------------------------------------------------
// Běh

/** Zpracuje frontu e-mailů a webových poptávek. Vrací jen počty. */
export async function runInquiryAgent(deps: InquiryAgentDeps): Promise<InquiryAgentStats> {
  const cfg = agentConfig()
  const now = deps.now ?? (() => new Date())
  const timeUp = deps.timeUp ?? (() => false)
  const stats = emptyStats()

  const ownerId = await deps.store.memberIdByEmail(cfg.leadOwnerEmail)
  if (!ownerId) throw new Error('Vlastník leadu (capabilities.inquiryAgent.leadOwnerEmail) není v týmu (team_member).')

  const today = pragueToday(now())
  const dayStart = pragueDayStartIso(today, COMPANY.timeZone)
  const nextDayStart = pragueDayStartIso(addDaysToPragueDay(today, 1), COMPANY.timeZone)
  let modelCallsToday = await deps.store.modelCallsSince(dayStart)

  const ctx = { cfg, ownerId, today, now, stats, deps }

  // --- e-mail
  const runs = await deps.store.claimRuns(cfg.maxPerRun)
  stats.claimed = runs.length
  for (const row of runs) {
    if (timeUp()) {
      // Nevyřízené převzetí vrátit do fronty (pending; 'decided' s konceptem zůstává).
      if (row.status === 'processing') await deps.store.finishRun({ run_id: row.id, status: 'pending', retry_after_seconds: 0 })
      stats.released++
      continue
    }
    try {
      if (row.status === 'decided' && row.reply_draft) {
        await retryOutbox(ctx, row)
        continue
      }
      const modelAllowed = modelCallsToday < cfg.modelDailyLimit
      const used = await processEmail(ctx, row, { modelAllowed, nextDaySeconds: secondsUntilNextDay(now(), nextDayStart) })
      if (used) {
        modelCallsToday++
        stats.modelCalls++
      }
    } catch (e) {
      logError('inquiryAgent.email', e, { runId: row.id })
      stats.failed++
      await safeFinishRun(deps.store, {
        run_id: row.id,
        status: row.attempts >= cfg.modelMaxAttempts ? 'failed' : 'pending',
        error_code: 'processing_error',
        retry_after_seconds: retryDelaySeconds(row.attempts),
      })
    }
  }

  // --- web
  if (!timeUp()) {
    const webRows = await deps.store.claimWeb(cfg.maxPerRun)
    stats.web = webRows.length
    for (const row of webRows) {
      if (timeUp()) {
        await deps.store.finishWeb({ web_inquiry_id: row.id, status: 'new' })
        stats.released++
        continue
      }
      try {
        await processWeb(ctx, row)
      } catch (e) {
        logError('inquiryAgent.web', e, { webInquiryId: row.id })
        stats.failed++
        await deps.store
          .finishWeb({ web_inquiry_id: row.id, status: row.attempts >= cfg.modelMaxAttempts ? 'failed' : 'new', error_code: 'processing_error' })
          .catch((err) => logError('inquiryAgent.webFinish', err, { webInquiryId: row.id }))
      }
    }
  }
  return stats
}

type Ctx = {
  cfg: AgentCfg
  ownerId: string
  today: string
  now: () => Date
  stats: InquiryAgentStats
  deps: InquiryAgentDeps
}

async function safeFinishRun(store: InquiryAgentStore, p: Record<string, unknown>): Promise<void> {
  try {
    await store.finishRun(p)
  } catch (e) {
    logError('inquiryAgent.finish', e, { runId: p.run_id })
  }
}

/** Shrnutí verdiktu pro inquiry_agent_finish / web_inquiry_finish (jen kódy a čísla). */
function verdictFields(v: AgentVerdict): Record<string, unknown> {
  return {
    decision_kind: v.kind,
    reason_codes: v.reasonCodes.slice(0, 30),
    quote_total: v.quote ? v.quote.total : null,
    price_map_version: v.quote?.mapVersion ?? OFFER.priceMap.version,
  }
}

async function retryOutbox(ctx: Ctx, row: RunRow): Promise<void> {
  const r = await ctx.deps.store.enqueueOutbox(row.reply_draft as Record<string, unknown>)
  if (r.ok) {
    await ctx.deps.store.finishRun({ run_id: row.id, status: 'enqueued', outbox_id: r.outboxId, reply_draft: null, error_code: null })
    ctx.stats.enqueued++
  } else {
    await ctx.deps.store.finishRun({ run_id: row.id, status: 'decided', error_code: r.missing ? 'outbox_missing' : 'outbox_error', retry_after_seconds: 3600 })
    ctx.stats.outboxPending++
  }
}

/** E-mail z fronty. Vrací true, když se volal model. */
async function processEmail(ctx: Ctx, row: RunRow, opts: { modelAllowed: boolean; nextDaySeconds: number }): Promise<boolean> {
  const { cfg, deps, stats } = ctx
  const store = deps.store

  const fetched = await deps.mail.fetchMessage(row.mailbox, row.graph_message_id)
  if (fetched.kind === 'gone') {
    await store.finishRun({ run_id: row.id, status: 'skipped', error_code: 'message_gone' })
    stats.skipped++
    return false
  }
  if (fetched.kind === 'retry') {
    const exhausted = row.attempts >= cfg.modelMaxAttempts * 3
    await store.finishRun({ run_id: row.id, status: exhausted ? 'failed' : 'pending', error_code: fetched.code, retry_after_seconds: fetched.seconds })
    if (exhausted) stats.failed++
    else stats.retried++
    return false
  }
  if (!opts.modelAllowed) {
    await store.finishRun({ run_id: row.id, status: 'pending', error_code: 'model_daily_limit', retry_after_seconds: opts.nextDaySeconds })
    stats.retried++
    return false
  }

  const msg = fetched.message
  const auth = evaluateSenderAuth(msg.headers, cfg.trustedAuthServId)
  const fromAddress = auth.replyAddress ?? msg.headers.filter((h) => h.name.toLowerCase() === 'from').flatMap((h) => headerAddresses(h.value))[0] ?? null
  const subject = msg.headers.find((h) => h.name.toLowerCase() === 'subject')?.value ?? ''

  let modelError: unknown = null
  const decision = await decideInquiry(
    { subject, text: latestReplyText(msg.text), fromAddress },
    { companyName: COMPANY.name, offer: OFFER, today: ctx.today },
    {
      extract: async (input) => {
        try {
          return await deps.extract(input)
        } catch (e) {
          modelError = e
          throw e
        }
      },
      distanceKm: deps.distanceKm,
      isVipContact: (addr) => store.isVipEmail(addr),
    },
  )

  let verdict = verdictFromDecision(decision)
  if (modelError !== null) {
    if (isTransientModelError(modelError) && row.attempts < cfg.modelMaxAttempts) {
      await store.finishRun({ run_id: row.id, status: 'pending', model_called: true, error_code: 'model_unavailable', retry_after_seconds: retryDelaySeconds(row.attempts) })
      stats.retried++
      return true
    }
    verdict = escalateVerdict(verdict, isTransientModelError(modelError) ? 'model_unavailable' : 'extraction_failed')
  }

  if (verdict.kind === 'not_inquiry') {
    await store.finishRun({ run_id: row.id, status: 'skipped', decision_kind: 'not_inquiry', reason_codes: [], model_called: true })
    stats.not_inquiry++
    return true
  }

  const extracted = decision.extracted
  verdict = applyAgentGates(verdict, {
    senderAuth: auth,
    venuePresent: Boolean(extracted?.venue),
    autoSendKinds: cfg.autoSendKinds,
  })
  const segment = decision.kind === 'escalate' || decision.kind === 'send_offer' || decision.kind === 'ask_info' ? (decision.segment?.segment ?? null) : null
  const facts = {
    segment,
    eventType: extracted?.eventType ?? null,
    eventTypeLabel: eventTypeLabel(segment, extracted?.eventType ?? null),
    eventDate: extracted?.eventDate ?? null,
    guests: extracted?.guests ?? null,
  }
  const evidence: EvidenceRef = {
    kind: 'email_message',
    sourceId: row.graph_message_id,
    webLink: `https://mail.google.com/mail/?authuser=${encodeURIComponent(row.mailbox)}#all/${encodeURIComponent(row.graph_message_id)}`,
  }

  // Bez platné adresy odesílatele nejde založit kontakt: jen eskalace bez CRM.
  if (!fromAddress) {
    verdict = escalateVerdict(verdict, 'sender_unverified')
    await store.propose(escalationProposal({
      sourceKey: `inquiry:${row.id}`, source: 'email', occurredAt: row.received_at, node: cfg.escalationNode, accountId: null,
      evidence, reasonCodes: verdict.reasonCodes, eventTypeLabel: facts.eventTypeLabel, hasDraft: verdict.quote !== null,
    }))
    await store.finishRun({ run_id: row.id, status: 'decided', segment, model_called: true, ...verdictFields(verdict) })
    stats.escalate++
    return true
  }

  const line = leadLine(cfg.leadMapping, segment, facts.eventType)
  const found = await store.found(inquiryFoundPayload({
    source: 'email',
    sourceKey: row.internet_message_id,
    runId: row.id,
    occurredAt: row.received_at,
    ownerId: ctx.ownerId,
    dedupDays: cfg.dedupWindowDays,
    email: fromAddress,
    personName: contactName(extracted?.customerName, fromAddress),
    company: leadCompany({ segment, email: fromAddress, companyName: extracted?.companyName ?? null }),
    verdict,
    facts,
    line: { ...line, revenueCategory: revenueCategory(line.revenueLine) },
    today: ctx.today,
  }))
  verdict = applyFoundResult(verdict, found)

  const base = { run_id: row.id, segment, model_called: true, scope_version_id: found.scope_version_id, ...verdictFields(verdict) }
  if (verdict.kind === 'escalate' || !found.deal_id) {
    if (verdict.kind !== 'escalate') verdict = escalateVerdict(verdict, 'ambiguous_account')
    await store.propose(escalationProposal({
      sourceKey: `inquiry:${row.id}`, source: 'email', occurredAt: row.received_at, node: cfg.escalationNode, accountId: found.account_id,
      evidence, reasonCodes: verdict.reasonCodes, eventTypeLabel: facts.eventTypeLabel, hasDraft: verdict.quote !== null,
    }))
    await store.finishRun({ ...base, ...verdictFields(verdict), status: 'decided' })
    stats.escalate++
    return true
  }

  stats[verdict.kind]++
  const sender = replyMailboxMember(cfg.replyFrom, row.mailbox_member_id, ctx.ownerId)
  const item = outboxItem({
    verdict,
    sourceRef: `inquiry:${row.id}`,
    dealId: found.deal_id,
    scopeVersionId: found.scope_version_id,
    mailboxMemberId: sender,
    mode: replyMode({ senderMemberId: sender, receivingMemberId: row.mailbox_member_id, gmailMessageId: row.graph_message_id, replyAddress: fromAddress }),
    footer: cfg.replyFooter,
  })
  const payload = outboxEnqueuePayload(item)
  const r = await store.enqueueOutbox(payload)
  if (r.ok) {
    await store.finishRun({ ...base, status: 'enqueued', outbox_id: r.outboxId, reply_draft: null })
    stats.enqueued++
  } else {
    await store.finishRun({ ...base, status: 'decided', reply_draft: payload, error_code: r.missing ? 'outbox_missing' : 'outbox_error', retry_after_seconds: 3600 })
    stats.outboxPending++
  }
  return true
}

// ---------------------------------------------------------------------------
// Web

const webFieldsSchema = z.object({
  segment: z.string().max(40).nullable().catch(null),
  event_type: z.string().max(40).nullable().catch(null),
  package_key: z.string().max(40).nullable().catch(null),
  event_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().catch(null),
  duration_hours: z.number().positive().max(24).nullable().catch(null),
  guests: z.number().int().positive().max(100_000).nullable().catch(null),
  venue: z.string().max(300).nullable().catch(null),
  extras: z.array(z.string().max(40)).max(30).catch([]),
  dietary: z.array(z.object({ key: z.string().max(40), guests: z.number().int().positive().max(100_000) })).max(20).catch([]),
  special_requests: z.string().max(2000).nullable().catch(null),
})

async function processWeb(ctx: Ctx, row: WebRow): Promise<void> {
  const { cfg, deps, stats } = ctx
  const store = deps.store
  const parsed = webFieldsSchema.safeParse(row.inquiry ?? {})
  if (!parsed.success) {
    await store.finishWeb({ web_inquiry_id: row.id, status: 'failed', error_code: 'invalid_inquiry' })
    stats.failed++
    return
  }
  const w = parsed.data
  const email = row.email.trim().toLowerCase()
  const [distanceKm, vipContact] = await Promise.all([
    w.venue ? deps.distanceKm(w.venue).catch(() => null) : Promise.resolve(null),
    store.isVipEmail(email).catch(() => true),
  ])
  const result = evaluateStandardOffer(
    OFFER,
    webInquiryToOfferInquiry(
      {
        segment: w.segment, eventType: w.event_type, packageKey: w.package_key, eventDate: w.event_date, guests: w.guests,
        durationHours: w.duration_hours, extras: w.extras, dietary: w.dietary, specialRequests: w.special_requests,
      },
      { distanceKm, vipContact },
    ),
    ctx.today,
  )
  const customerName = safeGreetingName(row.customer_name)
  let verdict = verdictFromOfferResult(result, {
    offer: (q) => renderOfferEmail(q, { companyName: COMPANY.name, signature: OFFER.signature, customerName }),
    info: (missing) => ({ subject: `Doplnění poptávky – ${COMPANY.name}`, body: renderInfoRequest(missing, { signature: OFFER.signature, customerName }) }),
  })
  verdict = applyAgentGates(verdict, { senderAuth: null, venuePresent: Boolean(w.venue), autoSendKinds: cfg.autoSendKinds })
  if (verdict.kind === 'not_inquiry') return // web nemá „ne-poptávku"; jen pro úplnost typů

  const segment = w.segment
  const facts = { segment, eventType: w.event_type, eventTypeLabel: eventTypeLabel(segment, w.event_type), eventDate: w.event_date, guests: w.guests }
  const line = leadLine(cfg.leadMapping, segment, w.event_type)
  const sourceRef = `web:${row.id}`
  const found = await store.found(inquiryFoundPayload({
    source: 'web',
    sourceKey: sourceRef,
    webInquiryId: row.id,
    occurredAt: row.received_at,
    ownerId: ctx.ownerId,
    dedupDays: cfg.dedupWindowDays,
    email,
    personName: contactName(row.customer_name, email),
    company: leadCompany({ segment, email, companyName: row.company_name, ico: row.ico }),
    verdict,
    facts,
    line: { ...line, revenueCategory: revenueCategory(line.revenueLine) },
    today: ctx.today,
  }))
  verdict = applyFoundResult(verdict, found)

  if (verdict.kind === 'escalate' || !found.deal_id) {
    if (verdict.kind !== 'escalate') verdict = escalateVerdict(verdict, 'ambiguous_account')
    await store.propose(escalationProposal({
      sourceKey: sourceRef, source: 'web', occurredAt: row.received_at, node: cfg.escalationNode, accountId: found.account_id,
      evidence: { kind: 'url', sourceId: `web_inquiry:${row.id}`, webLink: null },
      reasonCodes: verdict.reasonCodes, eventTypeLabel: facts.eventTypeLabel, hasDraft: verdict.quote !== null,
    }))
    await store.finishWeb({ web_inquiry_id: row.id, status: 'decided', ...verdictFields(verdict), error_code: null })
    stats.escalate++
    return
  }

  const payload = outboxEnqueuePayload(outboxItem({
    verdict,
    sourceRef,
    dealId: found.deal_id,
    scopeVersionId: found.scope_version_id,
    mailboxMemberId: ctx.ownerId,
    mode: { to: email },
    footer: cfg.replyFooter,
  }))
  const r = await store.enqueueOutbox(payload)
  stats[verdict.kind]++
  if (r.ok) {
    await store.finishWeb({ web_inquiry_id: row.id, status: 'decided', ...verdictFields(verdict), error_code: null })
    stats.enqueued++
  } else {
    // Bez odchozí fronty zůstane poptávka 'new' a další běh ji projde znovu
    // (CRM zápis je idempotentní podle source_key, fronta podle source_ref).
    await store.finishWeb({ web_inquiry_id: row.id, status: 'new', ...verdictFields(verdict), error_code: r.missing ? 'outbox_missing' : 'outbox_error' })
    stats.outboxPending++
  }
}

// ---------------------------------------------------------------------------
// Supabase adaptér (service role)

type Admin = Pick<SupabaseClient, 'from' | 'rpc'>
type DbErr = { code?: string | null; message?: string | null } | null

function rpcError(name: string, error: DbErr): Error {
  // Jen kód a název funkce — zpráva Postgresu může citovat vstup.
  return new Error(`${name}: ${error?.code ?? 'chyba'}`)
}

export function createInquiryAgentStore(admin: Admin): InquiryAgentStore {
  const sink = caseProposalSink<Record<string, never>, CaseProposalOutput>(admin, { createdBy: `system:${INQUIRY_AGENT_ACTOR}` })
  return {
    async claimRuns(limit) {
      const { data, error } = await admin.rpc('inquiry_agent_claim', { p_limit: limit })
      if (error) {
        if (isRpcMissing(error)) return []
        throw rpcError('inquiry_agent_claim', error)
      }
      return (data as RunRow[] | null) ?? []
    },
    async finishRun(p) {
      const { error } = await admin.rpc('inquiry_agent_finish', { p })
      if (error) throw rpcError('inquiry_agent_finish', error)
    },
    async claimWeb(limit) {
      const { data, error } = await admin.rpc('web_inquiry_claim', { p_limit: limit })
      if (error) {
        if (isRpcMissing(error)) return []
        throw rpcError('web_inquiry_claim', error)
      }
      return (data as WebRow[] | null) ?? []
    },
    async finishWeb(p) {
      const { error } = await admin.rpc('web_inquiry_finish', { p })
      if (error) throw rpcError('web_inquiry_finish', error)
    },
    async found(p) {
      const { data, error } = await admin.rpc('inquiry_agent_found', { p })
      if (error) throw rpcError('inquiry_agent_found', error)
      const r = parseFoundResult(data)
      if (!r) throw new Error('inquiry_agent_found: neočekávaná odpověď')
      return r
    },
    async enqueueOutbox(p) {
      const { data, error } = await admin.rpc(OUTBOX_ENQUEUE_RPC, { p })
      if (error) {
        if (!isRpcMissing(error)) logError('inquiryAgent.outbox', rpcError(OUTBOX_ENQUEUE_RPC, error))
        return { ok: false, missing: isRpcMissing(error) }
      }
      const d = (data ?? {}) as { outbox_id?: unknown; duplicate?: unknown }
      const id = typeof d.outbox_id === 'number' ? d.outbox_id : Number(d.outbox_id)
      if (!Number.isFinite(id) || id <= 0) return { ok: false, missing: false }
      return { ok: true, outboxId: id, duplicate: d.duplicate === true }
    },
    async modelCallsSince(sinceIso) {
      const { count, error } = await admin
        .from('inquiry_agent_run')
        .select('id', { count: 'exact', head: true })
        .gte('model_called_at', sinceIso)
      if (error) {
        logError('inquiryAgent.modelCalls', rpcError('inquiry_agent_run', error))
        return Number.MAX_SAFE_INTEGER // nejistota = nevolat model
      }
      return count ?? 0
    },
    async memberIdByEmail(email) {
      const { data, error } = await admin
        .from('team_member')
        .select('id')
        .ilike('email', email.replace(/[\\%_]/g, (c) => `\\${c}`))
        .is('deactivated_at', null)
        .limit(1)
        .maybeSingle()
      if (error) {
        logError('inquiryAgent.member', rpcError('team_member', error))
        return null
      }
      return (data as { id: string } | null)?.id ?? null
    },
    async isVipEmail(email) {
      if (!email) return true
      const { data, error } = await admin
        .from('contact')
        .select('id, is_vip, do_not_contact')
        .ilike('email', email.replace(/[\\%_]/g, (c) => `\\${c}`))
        .limit(20)
      if (error) return true
      return ((data as { is_vip?: boolean; do_not_contact?: boolean }[] | null) ?? []).some((c) => c.is_vip === true || c.do_not_contact === true)
    },
    propose: (draft) => sink.propose(draft),
  }
}
