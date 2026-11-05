// Běh outbound agenta (P7) — orchestrace nad vstříknutými závislostmi.
// Žádné přímé I/O: databázi dodá OutboundDb (Supabase adaptér v
// supabaseDb.ts, v testech paměťová náhrada), zdroje signálů
// OutboundSources (konektory za přepínači). Pořadí jednoho běhu:
//
//   1. sběr   — signály ze zapnutých zdrojů + z CRM → outbound_signal (idempotentně)
//   2. kvalifikace — nové signály: ARES + CRM kontext → qualifySignal → stav
//   3. lead   — rozhodnutí 'lead' → obchod v CRM (zdroj 'agent:outbound:<zdroj>')
//   4. oslovení — právní brána decideOutreach:
//        manual       → návrh pro člověka (nic se neodesílá)
//        review_email → koncept e-mailu ke schválení CSO
//        auto_email   → schváleno pravidlem, odejde v kroku 5
//   5. fronta — schválená oslovení → agent_outbox (kind 'outreach') v okně
//        odesílání a do denního limitu, jen z ODDĚLENÉ odesílací schránky.
//
// Do logů a statistik jdou jen počty a kódy, nikdy text ani adresy.
import type { OutboundAgentConfig } from '@/core/outbound/config'
import { crmSignals, templateKeyForSignal, type CrmAccountSnapshot } from '@/core/outbound/crmSignals'
import { outreachEnqueuePayload } from '@/core/outbound/outbox'
import {
  decideOutreach, isWithinWindow, OUTREACH_REASON_LABELS, type ConsentEvidence, type OutreachReason,
} from '@/core/outbound/outreachPolicy'
import { manualProposal, renderOutreach } from '@/core/outbound/outreachText'
import { qualifySignal, type QualifyContext } from '@/core/outbound/qualify'
import { parseSignalCandidate, SIGNAL_KIND_LABELS, type SignalCandidate, type SignalKind, type VerifiedFact } from '@/core/outbound/signal'
import { emailHash, unsubscribeLink, unsubscribeToken } from '@/core/outbound/unsubscribe'

export const OUTBOUND_JOB_NAME = 'outbound-agent'
export const OUTBOUND_JOB_TTL_SECONDS = 290
export const MAX_ATTEMPTS = 3

export interface StoredSignal {
  id: number
  source: SignalCandidate['source']
  kind: SignalKind
  externalRef: string
  title: string
  url: string | null
  ico: string | null
  companyName: string | null
  facts: VerifiedFact[]
  accountId: number | null
  attempts: number
}

export interface CrmContext {
  accountId: number | null
  relationship: QualifyContext['crm']['relationship']
  optedOut: boolean
  recentlyContacted: boolean
}

export interface OutreachTarget {
  contactId: number | null
  email: string | null
  /** Kontakt nesouhlasí (políčko, poznámka) nebo je adresa odhlášená. */
  optedOut: boolean
  consent: ConsentEvidence | null
  isExistingCustomer: boolean
  /** Název firmy z CRM (ověřený fakt pro šablonu). */
  accountName: string
}

export interface NewOutreach {
  signalId: number
  accountId: number
  contactId: number | null
  dealId: number | null
  channel: 'auto_email' | 'review_email' | 'manual'
  status: 'draft' | 'approved'
  basis: 'existing_customer' | 'consent' | 'none'
  reasonCodes: string[]
  templateKey: string | null
  subject: string | null
  body: string | null
  emailHash: string | null
}

export interface ApprovedOutreach {
  id: number
  channel: 'auto_email' | 'review_email'
  /** Schválil člověk (review_email), ne pravidlo. */
  humanApproved: boolean
  dealId: number | null
  subject: string
  body: string
  emailHash: string | null
  /** Aktuální e-mail kontaktu (z contact) — musí sedět s otiskem. */
  email: string | null
  suppressed: boolean
}

export type EnqueueResult =
  | { ok: true; outboxId: number | null; duplicate: boolean }
  | { ok: false; missingRpc: true }
  | { ok: false; missingRpc: false; code: string }

export interface OutboundDb {
  upsertSignal(c: SignalCandidate): Promise<{ signalId: number; duplicate: boolean }>
  pendingSignals(limit: number): Promise<StoredSignal[]>
  crmContext(s: { accountId: number | null; ico: string | null }, cooldownDays: number): Promise<CrmContext>
  saveQualification(id: number, x: { status: 'review' | 'dismissed' | 'blocked' | 'failed'; score: number | null; reasons: string[]; segment: string | null; errorCode?: string | null; ico?: string | null }): Promise<void>
  /** Lead přes RPC outbound_lead_create; null = signál nemá firmu (zůstane na review). */
  createLead(signalId: number, x: { score: number; reasons: string[]; segment: string; ico: string | null }): Promise<{ accountId: number; dealId: number } | null>
  outreachTarget(accountId: number): Promise<OutreachTarget | null>
  insertOutreach(x: NewOutreach): Promise<number>
  setOutreachText(id: number, x: { subject: string; body: string }): Promise<void>
  countSentToday(pragueDay: string): Promise<number>
  approvedOutreach(limit: number): Promise<ApprovedOutreach[]>
  markQueued(id: number, x: { sourceRef: string; outboxId: number | null; pragueDay: string }): Promise<void>
  markSkipped(id: number, reason: string): Promise<void>
  enqueue(payload: Record<string, unknown>): Promise<EnqueueResult>
  memberIdByEmail(email: string): Promise<string | null>
  crmAccounts(): Promise<CrmAccountSnapshot[]>
}

export type AresLookup = (ico: string | null, name: string | null) => Promise<QualifyContext['ares']>

export interface OutboundSources {
  /** Signály ze zapnutých externích zdrojů; chyba zdroje = kód, ne výjimka. */
  collect(): Promise<{ signals: unknown[]; errors: { source: string; code: string }[] }>
  ares: AresLookup | null
}

export interface OutboundRunOptions {
  config: OutboundAgentConfig
  now: Date
  /** Pražský den YYYY-MM-DD (dodá volající z lib/pragueDate). */
  today: string
  timeZone: string
  autosendEnabled: boolean
  unsubscribeSecret: string | null
}

export interface OutboundRunStats {
  collected: number
  new: number
  invalid: number
  sourceErrors: { source: string; code: string }[]
  qualified: number
  leads: number
  review: number
  dismissed: number
  blocked: number
  failed: number
  outreachManual: number
  outreachReview: number
  outreachAuto: number
  queued: number
  waiting: number
  skipped: number
  stopReason: string | null
}

const emptyStats = (): OutboundRunStats => ({
  collected: 0, new: 0, invalid: 0, sourceErrors: [], qualified: 0, leads: 0, review: 0, dismissed: 0, blocked: 0,
  failed: 0, outreachManual: 0, outreachReview: 0, outreachAuto: 0, queued: 0, waiting: 0, skipped: 0, stopReason: null,
})

const errCode = (e: unknown) => (e instanceof Error ? e.name || 'Error' : 'error').slice(0, 64)

export async function runOutboundAgent(db: OutboundDb, sources: OutboundSources, opts: OutboundRunOptions): Promise<OutboundRunStats> {
  const { config } = opts
  const stats = emptyStats()

  // 1) Sběr.
  const external = await sources.collect()
  stats.sourceErrors = external.errors
  const crm = crmSignals(await db.crmAccounts(), opts.today, config)
  const candidates = [...external.signals, ...crm]
  stats.collected = candidates.length
  let budget = config.maxSignalsPerRun
  for (const raw of candidates) {
    if (budget <= 0) break
    const c = parseSignalCandidate(raw)
    if (!c) { stats.invalid++; continue }
    const r = await db.upsertSignal(c)
    if (!r.duplicate) { stats.new++; budget-- }
  }

  // 2)–4) Kvalifikace, lead a příprava oslovení.
  for (const s of await db.pendingSignals(config.maxSignalsPerRun)) {
    try {
      await qualifyAndLead(db, sources.ares, s, opts, stats)
    } catch (e) {
      stats.failed++
      await db.saveQualification(s.id, { status: 'failed', score: null, reasons: [], segment: null, errorCode: errCode(e) })
    }
  }

  // 5) Fronta.
  await enqueueApproved(db, opts, stats)
  return stats
}

async function qualifyAndLead(db: OutboundDb, ares: AresLookup | null, s: StoredSignal, opts: OutboundRunOptions, stats: OutboundRunStats) {
  const { config } = opts
  let aresCtx: QualifyContext['ares'] = null
  if (ares && (s.ico || s.companyName) && s.source !== 'crm') {
    // Výpadek ARES není důvod signál zahodit — kvalifikuje se bez něj (spíš na review).
    try { aresCtx = await ares(s.ico, s.companyName) } catch { aresCtx = null }
  }
  const ico = aresCtx?.ico ?? s.ico
  const crm = await db.crmContext({ accountId: s.accountId, ico }, config.outreach.cooldownDays)
  const candidate: SignalCandidate = {
    source: s.source, kind: s.kind, externalRef: s.externalRef, title: s.title, url: s.url, signalDate: null,
    company: { ico, name: aresCtx?.legalName ?? s.companyName }, facts: s.facts, accountId: s.accountId,
  }
  const q = qualifySignal(candidate, { ares: aresCtx, crm }, config)
  stats.qualified++

  if (q.decision !== 'lead') {
    const status = q.decision === 'dismiss' ? 'dismissed' : q.decision
    stats[status === 'dismissed' ? 'dismissed' : status === 'blocked' ? 'blocked' : 'review']++
    await db.saveQualification(s.id, { status, score: q.score, reasons: q.reasons, segment: config.icp.segment, ico })
    return
  }

  const lead = await db.createLead(s.id, { score: q.score, reasons: q.reasons, segment: config.icp.segment, ico })
  if (!lead) {
    stats.review++
    await db.saveQualification(s.id, { status: 'review', score: q.score, reasons: [...q.reasons, 'company_unknown'], segment: config.icp.segment, ico })
    return
  }
  stats.leads++
  await prepareOutreach(db, { ...s, accountId: lead.accountId }, lead.dealId, opts, stats)
}

async function prepareOutreach(db: OutboundDb, s: StoredSignal & { accountId: number }, dealId: number, opts: OutboundRunOptions, stats: OutboundRunStats) {
  const { config } = opts
  const target = await db.outreachTarget(s.accountId)
  if (!target) return
  const templateKey = templateKeyForSignal(s, config)
  const template = templateKey ? config.outreach.templates[templateKey] ?? null : null
  // Obdobná služba (§ 7 odst. 3): jen signály z CRM se šablonou pro stávající klienty.
  const similarService = s.source === 'crm' && template?.audience === 'existing_customer'
  const decision = decideOutreach({
    isExistingCustomer: target.isExistingCustomer,
    similarService,
    consent: target.consent,
    email: target.email,
    optedOut: target.optedOut,
    vip: config.outreach.vipAccountIds.includes(s.accountId),
    sensitive: false,
    templateAvailable: !!template && !!opts.unsubscribeSecret,
    autosendEnabled: opts.autosendEnabled,
    // Okno a limit se hlídají až při zařazení do fronty (krok 5).
    withinWindow: true,
    sentToday: 0,
    dailyLimit: Number.MAX_SAFE_INTEGER,
  })
  if (decision.channel === 'none') return

  const facts: VerifiedFact[] = [{ key: 'firma', value: target.accountName, sourceUrl: null }, ...s.facts.filter((f) => f.key !== 'firma')]
  const base = { signalId: s.id, accountId: s.accountId, contactId: target.contactId, dealId, basis: decision.basis, reasonCodes: decision.reasons, templateKey }

  if (decision.channel === 'manual') {
    const reason = decision.reasons[0] as OutreachReason | undefined
    const p = manualProposal({
      kindLabel: SIGNAL_KIND_LABELS[s.kind], title: s.title, url: s.url, companyName: target.accountName, facts,
      reasonLabel: reason ? OUTREACH_REASON_LABELS[reason] : 'chybí právní titul',
    })
    await db.insertOutreach({ ...base, channel: 'manual', status: 'draft', basis: 'none', subject: p.subject, body: p.body, emailHash: null })
    stats.outreachManual++
    return
  }

  // E-mail (koncept ke schválení, nebo schválený pravidlem). Text s odkazem
  // na odhlášení vznikne až s id oslovení (token ho obsahuje).
  const hash = emailHash(target.email!)
  const channel = decision.channel === 'review_email' ? 'review_email' : 'auto_email'
  const id = await db.insertOutreach({
    ...base, channel, status: channel === 'auto_email' ? 'approved' : 'draft', subject: null, body: null, emailHash: hash,
  })
  const link = unsubscribeLink(config.outreach.unsubscribeUrl, unsubscribeToken({ emailHash: hash, outreachId: id }, opts.unsubscribeSecret!))
  const text = renderOutreach(template!, facts, { footer: config.outreach.footer, unsubscribeLink: link })
  if (!text.ok) {
    // Šablona chce fakt, který signál nemá — nic se nedomýšlí, oslovení se zruší.
    await db.markSkipped(id, 'missing_fact')
    stats.skipped++
    return
  }
  await db.setOutreachText(id, { subject: text.subject, body: text.text })
  stats[channel === 'auto_email' ? 'outreachAuto' : 'outreachReview']++
}

async function enqueueApproved(db: OutboundDb, opts: OutboundRunOptions, stats: OutboundRunStats) {
  const { config } = opts
  const approved = await db.approvedOutreach(config.outreach.dailyLimit * 2)
  if (!approved.length) return
  // Bez tajemství pro odkaz na odhlášení nesmí odejít žádné obchodní sdělení.
  const secret = opts.unsubscribeSecret
  if (!secret) { stats.waiting += approved.length; stats.stopReason = 'unsubscribe_secret_missing'; return }
  if (!isWithinWindow(opts.now, config.outreach.sendWindow, opts.timeZone)) {
    stats.waiting += approved.length
    stats.stopReason = 'outside_window'
    return
  }
  // Outbound odchází JEN z oddělené schránky; když chybí, neposílá se nic.
  const mailbox = await db.memberIdByEmail(config.outreach.senderMailboxEmail)
  if (!mailbox) { stats.waiting += approved.length; stats.stopReason = 'sender_mailbox_missing'; return }

  let sent = await db.countSentToday(opts.today)
  for (const o of approved) {
    if (o.suppressed) { await db.markSkipped(o.id, 'opted_out'); stats.skipped++; continue }
    if (!o.email || !o.emailHash || emailHash(o.email) !== o.emailHash || !o.dealId) {
      await db.markSkipped(o.id, 'contact_changed'); stats.skipped++; continue
    }
    // Pravidlem schválené čeká, dokud je samostatné odeslání vypnuté; schválené člověkem ne.
    if (!o.humanApproved && !opts.autosendEnabled) { stats.waiting++; continue }
    if (sent >= config.outreach.dailyLimit) { stats.waiting++; stats.stopReason = 'daily_limit'; continue }
    const hashLink = unsubscribeLink(config.outreach.unsubscribeUrl, unsubscribeToken({ emailHash: o.emailHash, outreachId: o.id }, secret))
    const payload = outreachEnqueuePayload({
      outreachId: o.id, dealId: o.dealId, mailboxMemberId: mailbox, to: o.email, subject: o.subject, text: o.body,
      listUnsubscribeUrl: hashLink,
    })
    const r = await db.enqueue(payload)
    if (!r.ok && r.missingRpc) { stats.waiting++; stats.stopReason = 'outbox_missing'; return }
    if (!r.ok) { stats.waiting++; stats.stopReason = r.code; continue }
    await db.markQueued(o.id, { sourceRef: payload.source_ref as string, outboxId: r.outboxId, pragueDay: opts.today })
    if (!r.duplicate) sent++
    stats.queued++
  }
}
