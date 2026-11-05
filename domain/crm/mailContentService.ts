// Obsahový vstup pošty — zápis do databáze a Graph (P2.1 revize, kapitola 2D).
// Čistá rozhodovací logika (klíčová slova, úryvek, párování, návrh) je
// v domain/crm/mailContent.ts; tady je jen I/O kolem ní.
//
// Tok jednoho běhu (denní cron /api/cron/outlook-mail, za MAIL_CONTENT_INTAKE_ENABLED):
//   1. najde v Outlooku složku „Cockpit" (název z prostředí; nezakládá ji, ledaže
//      MAIL_CONTENT_FOLDER_CREATE=true a token má právo),
//   2. přečte z ní nové zprávy (delta dotaz jen nad touto složkou, kurzor
//      v connector_state 'outlook:cockpit'),
//   3. pro každou zprávu: řádek fronty (mail_content_intake, vždy první, ať se
//      nic neztratí) → rozpoznání pravidly → spárování na klienta, dodávku
//      a milník → NÁVRH pracovního případu (case_proposal), nebo zpráva zůstane
//      ve frontě „Pošta k zařazení" k ručnímu přiřazení,
//   4. tělo zprávy zahodí: uloží se jen předmět, úryvek (≤ 300 znaků), názvy
//      příloh, příznaky a odkaz na zprávu; obsah smaže retence (purge v 0091).
//
// Nabídka v příloze (MAIL_OFFER_ATTACHMENT_ENABLED, domain/crm/mailOfferService.ts):
// zpráva, jejíž PDF příloha vypadá jako nabídka, dostane v kroku 3 řádek fronty
// s NÁVRHEM ZAKÁZKY (klient, cena z PDF) místo návrhu pracovního případu; klienta
// a obchod založí až potvrzení člověka (domain/crm/actions/offers.ts). PDF se
// neukládá.
//
// SOUKROMÍ: tělo zprávy žije jen v paměti jednoho zpracování. Neloguje se,
// neukládá, nejde do statistik běhu (jen počty a kódy) ani do chyb (Postgres
// v detailu CHECK chyby cituje řádek, proto se z chyby bere jen kód).
//
// Nic se neprovede samo: výsledkem je vždy jen návrh, který přijme nebo
// zamítne člověk (core/actions/caseProposals.ts). Milník, termín ani úkol
// tady nikdo nemění.
import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/admin'
import { createAuditedAdminClient } from '@/core/auditDb'
import type { AuditActor } from '@/core/audit'
import { recordEvidence } from '@/core/evidence'
import { recordConnectorError, recordConnectorSuccess } from '@/core/connectorState'
import { caseProposalSink, isProposalsMigrationMissing } from '@/core/agents/caseProposal'
import { CapabilityAbort, type CaseProposalOutput, type ProposalDraft } from '@/core/agents/template'
import type { NormalizedEvent } from '@/core/connectors/contract'
import type { EvidenceRef } from '@/core/informationState'
import { COMPANY } from '@/config'
import { logError, logWarn } from '@/lib/log'
import {
  contentDeltaStartUrl,
  createMailFolder,
  fetchAttachmentNames,
  fetchContentDeltaPage,
  findMailFolder,
  isGraphLink,
  type AttachmentNames,
  type ContentDeltaResult,
  type FolderLookup,
} from '@/connectors/graph'
import type { WriteResult } from '@/domain/crm/apiWrite'
import {
  MISSING_SCOPE_ERROR,
  REQUEST_RESERVE_MS,
  decideThrottle,
} from '@/domain/crm/mailSync'
import { loadMailTargets, type AccountTargets } from '@/domain/crm/mailTargets'
import { loadMatchData } from '@/domain/crm/meetingIntakeService'
import {
  MAIL_CONTENT_CONNECTOR,
  MAIL_CONTENT_SOURCE,
  MAIL_SIGNALS,
  MAIL_WAIT_REASON_TEXT,
  buildMailContentProposal,
  chooseMilestone,
  chooseTarget,
  cleanAttachmentNames,
  cleanSubject,
  counterpartDomain,
  dedupeKeyForMessage,
  latestReplyText,
  mailContentAiEnabledFromEnv,
  mailContentFolderCreateFromEnv,
  mailContentFolderName,
  recognizeContent,
  resolveAccount,
  toContentMessage,
  type AccountMatchData,
  type ContentMessage,
  type ContentSkip,
  type MailMatchMethod,
  type MailSignal,
  type MailWaitReason,
  type MilestoneOption,
  type TargetOption,
} from '@/domain/crm/mailContent'
import { mailLooksInjected, summarizeMailContent, type MailAiResult } from '@/domain/crm/mailContentAi'
import { mailOfferEnabledFromEnv, offerKeywordsFromEnv } from '@/domain/crm/mailOffer'
import { CONNECTOR_SOURCE } from '@/domain/crm/connectorProposals'
import {
  MailOfferDefer,
  attemptOfferDraft,
  createLiveOfferDeps,
  createMailOfferContext,
  emptyOfferStats,
  offerColumnsAvailable,
  type MailOfferContext,
  type MailOfferStats,
} from '@/domain/crm/mailOfferService'

type Db = Pick<SupabaseClient, 'from' | 'rpc'>

export const MAIL_CONTENT_MIGRATION_PENDING = 'Pošta k zařazení čeká na migraci 0091.'
export const MAIL_CONTENT_NOT_CONFIGURED = 'Firma nemá nastavený obsahový vstup pošty (capabilities.mailContent).'
export const MAIL_ROW_NOT_FOUND_ERROR = 'Zpráva nenalezena.'
export const MAIL_ROW_HANDLED_ERROR = 'Zpráva už je vyřízená. Obnov stránku.'
export const MAIL_ACCOUNT_NOT_FOUND_ERROR = 'Klient nenalezen.'
export const MAIL_TARGET_MISMATCH_ERROR = 'Dodávka nebo obchod nepatří k vybranému klientovi.'
export const MAIL_OFFER_ROW_ERROR = 'Ke zprávě je návrh zakázky z nabídky. Potvrď ho tady ve frontě, nebo zprávu zahoď.'

/** Aktér automatu v auditu i v case_proposal.created_by. */
export const MAIL_CONTENT_ACTOR_ID = 'mail_content'
const SYSTEM_ACTOR = `system:${MAIL_CONTENT_ACTOR_ID}`

/** Chyba, po které nemá smysl zpracovávat další zprávy (chybí migrace, konfigurace). */
export class MailContentAbort extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MailContentAbort'
  }
}

type Actor = { type: 'system' | 'user'; id: string | null }
const actorText = (a: Actor): string => (a.id ? `${a.type}:${a.id}` : a.type)
const auditActor = (a: Actor): AuditActor => ({ type: a.type, id: a.id })

type DbErr = { code?: string | null; message?: string | null } | null | undefined

// Do logu jen kód chyby: Postgres v detailu cituje celý řádek (předmět, úryvek).
function logDbError(scope: string, error: unknown, context: Record<string, unknown> = {}): void {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
  logError(scope, 'chyba databáze', { code: typeof code === 'string' ? code : 'unknown', ...context })
}

function isMissingTable(error: DbErr): boolean {
  if (!error) return false
  return error.code === '42P01' || error.code === 'PGRST205' || /relation .* does not exist|could not find the table/i.test(error.message ?? '')
}

const isUniqueViolation = (error: DbErr): boolean => error?.code === '23505'

const shortError = (e: unknown): string => {
  const m = e instanceof Error ? e.message : String(e)
  return m.length > 200 ? m.slice(0, 200) : m
}

// ---------------------------------------------------------------------------
// Návrh ze zprávy (společné pro automat a ruční přiřazení)

export type IntakeRowForProposal = {
  id: number
  dedupeKey: string
  evidence: EvidenceRef
  receivedAt: string
  signals: readonly MailSignal[]
  proposedDate: string | null
  attachmentNames: readonly string[]
  aiUsed: boolean
  aiSummary: string | null
}

export type ProposalResult =
  | { status: 'created' | 'existing'; proposalId: number }
  /** Klient už má čekající návrh téhož druhu (nejvýš jeden na klienta a uzel). */
  | { status: 'pending_exists' }

async function proposeFromMessage(
  db: Db,
  a: {
    row: IntakeRowForProposal
    account: { id: number; name: string }
    target: TargetOption | null
    targetUnclear: boolean
    milestone: MilestoneOption | null
  },
): Promise<ProposalResult> {
  const cfg = COMPANY.capabilities.mailContent
  if (!cfg) throw new MailContentAbort(MAIL_CONTENT_NOT_CONFIGURED)
  const built = buildMailContentProposal({
    signals: a.row.signals,
    accountName: a.account.name,
    target: a.target,
    targetUnclear: a.targetUnclear,
    milestone: a.milestone,
    proposedDate: a.row.proposedDate,
    receivedAt: a.row.receivedAt,
    attachmentNames: a.row.attachmentNames,
    aiSummary: a.row.aiSummary,
  })
  const node = a.target?.kind === 'engagement' ? cfg.node : cfg.dealNode
  const hash = a.row.dedupeKey.replace(/^sha256:/, '')
  const sourceKey = `${MAIL_CONTENT_CONNECTOR}|message.selected|${hash}`
  const event: NormalizedEvent<null> = {
    source: MAIL_CONTENT_CONNECTOR,
    type: 'message.selected',
    external_id: hash,
    occurred_at: a.row.receivedAt,
    subject: { kind: 'account', id: a.account.id },
    participants: [],
    evidence: a.row.evidence,
    title: null,
    payload: null,
  }
  const draft: ProposalDraft<null, CaseProposalOutput> = {
    capability: built.capability,
    sourceKey,
    event,
    output: { title: built.title, rationale: built.rationale },
    reasons: [],
    method: a.row.aiUsed ? 'llm' : 'rule',
    infoState: 'ai_suggestion',
    target: { node, accountId: a.account.id, steps: built.steps },
  }

  let result: 'created' | 'duplicate'
  try {
    result = await caseProposalSink<null, CaseProposalOutput>(db, { createdBy: SYSTEM_ACTOR }).propose(draft)
  } catch (e) {
    if (e instanceof CapabilityAbort) throw new MailContentAbort(e.message)
    throw e
  }
  const { data, error } = await db
    .from('case_proposal').select('id').eq('capability', built.capability).eq('source_key', sourceKey).maybeSingle()
  if (error) {
    if (isProposalsMigrationMissing(error)) throw new MailContentAbort('Návrhy případů čekají na migraci 0067.')
    logDbError('mailContent.proposalLookup', error, { row: a.row.id })
    throw new Error('case_proposal: chyba čtení')
  }
  const proposalId = (data as { id: number } | null)?.id
  if (proposalId) return { status: result === 'created' ? 'created' : 'existing', proposalId }
  return { status: 'pending_exists' }
}

type Targeting = { target: TargetOption | null; unclear: boolean; milestone: MilestoneOption | null }

function markProposedPatch(args: {
  accountId: number
  method: MailMatchMethod
  targeting: Targeting
  proposalId: number
  actor: Actor
  now: Date
}) {
  const { target } = args.targeting
  return {
    status: 'proposed',
    wait_reason: null,
    account_id: args.accountId,
    engagement_id: target?.kind === 'engagement' ? target.id : null,
    deal_id: target ? (target.kind === 'deal' ? target.id : target.dealId) : null,
    milestone_id: args.targeting.milestone?.id ?? null,
    match_method: args.method,
    proposal_id: args.proposalId,
    decided_by: actorText(args.actor),
    decided_at: args.now.toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Zpracování jedné zprávy

export type MessageOutcome =
  | { outcome: 'duplicate' }
  | { outcome: 'proposed' }
  | { outcome: 'queued'; reason: MailWaitReason }

export type MailContentContext = {
  admin: Db
  ownerId: string | null
  now: () => Date
  attachments(graphId: string): Promise<AttachmentNames>
  /** Jen s MAIL_CONTENT_AI_ENABLED; null = bez modelu. */
  ai: ((input: { subject: string; text: string }) => Promise<MailAiResult | null>) | null
  /** Načtení dat pro párování na klienta; cache jednoho běhu. */
  matchData(): Promise<AccountMatchData>
  stats: MailContentRunStats
  /** Jen s MAIL_OFFER_ATTACHMENT_ENABLED; chybí = přílohy se čtou jen jako názvy. */
  offer?: MailOfferContext | null
}

export type MailContentRunStats = {
  folder: 'found' | 'created' | 'missing' | 'forbidden' | 'throttled' | 'error' | 'not_checked'
  outcome: 'caught_up' | 'more_pending' | 'throttled' | 'expired' | 'error' | 'missing_scope' | 'no_folder' | 'migration_pending' | 'not_configured'
  pages: number
  messages: number
  skipped: Partial<Record<ContentSkip | 'duplicate', number>>
  proposed: number
  queued: number
  queuedReasons: Partial<Record<MailWaitReason, number>>
  ai: { calls: number; failed: number; flagged: number; skipped: number }
  /** Nabídky z příloh; chybí, když je funkce vypnutá. */
  offer?: MailOfferStats
  /** Funkce je zapnutá, ale nejede (chybí migrace 0099). */
  offerDisabled?: 'migration_pending'
  /** Jen názvy příznaků, nikdy text. */
  injectionSuspects: number
  errors: number
  firstError?: string
  aborted?: string
}

export function emptyRunStats(): MailContentRunStats {
  return {
    folder: 'not_checked',
    outcome: 'error',
    pages: 0,
    messages: 0,
    skipped: {},
    proposed: 0,
    queued: 0,
    queuedReasons: {},
    ai: { calls: 0, failed: 0, flagged: 0, skipped: 0 },
    injectionSuspects: 0,
    errors: 0,
  }
}

/**
 * Jedna zpráva ze složky „Cockpit" → řádek fronty → (jistá shoda) návrh.
 * Idempotentní podle hashe Message-ID. Vrací výsledek bez obsahu zprávy.
 */
export async function processContentMessage(ctx: MailContentContext, msg: ContentMessage): Promise<MessageOutcome> {
  const { admin } = ctx
  const dedupeKey = dedupeKeyForMessage(msg.internetMessageId)

  const existing = await admin.from('mail_content_intake').select('id').eq('dedupe_key', dedupeKey).maybeSingle()
  if (existing.error) {
    if (isMissingTable(existing.error)) throw new MailContentAbort(MAIL_CONTENT_MIGRATION_PENDING)
    logDbError('mailContent.lookup', existing.error)
    throw new Error('mail_content_intake: chyba čtení')
  }
  if (existing.data) return { outcome: 'duplicate' }

  // --- nabídka v příloze (před zápisem čehokoli: odložená zpráva nesmí nechat stopu)
  let offer: Extract<Awaited<ReturnType<typeof attemptOfferDraft>>, { kind: 'draft' }> | null = null
  if (ctx.offer) {
    const stats = (ctx.stats.offer ??= emptyOfferStats())
    try {
      const attempt = await attemptOfferDraft(ctx.offer, {
        graphId: msg.graphId,
        internetMessageId: msg.internetMessageId,
        subject: msg.subject,
        hasAttachments: msg.hasAttachments,
      })
      if (attempt.kind === 'draft') {
        offer = attempt
        stats.read++
        stats.drafts++
      } else {
        stats.skipped[attempt.reason] = (stats.skipped[attempt.reason] ?? 0) + 1
        if (attempt.reason === 'model_failed' || attempt.reason === 'model_unavailable' || attempt.reason === 'flagged' || attempt.reason === 'invalid') stats.read++
      }
    } catch (e) {
      if (e instanceof MailOfferDefer) stats.deferred++
      throw e
    }
  }

  const evidenceRef: EvidenceRef = { kind: 'email_message', sourceId: msg.internetMessageId, webLink: msg.webLink }
  const evidence = await recordEvidence(admin, evidenceRef, SYSTEM_ACTOR)
  if (!evidence.ok) throw new Error('evidence: zápis selhal')

  // --- rozbor (tělo jen tady, v paměti)
  const latest = latestReplyText(msg.body)
  let recognition = recognizeContent({ subject: msg.subject, text: latest, hasAttachments: msg.hasAttachments, receivedAt: new Date(msg.receivedAt) })
  const flags = mailLooksInjected(msg.subject, latest)
  if (flags.length > 0) {
    ctx.stats.injectionSuspects++
    logWarn('mailContent', 'zpráva nese známky pokynů pro AI', { flags })
  }

  let attachmentNames: string[] = []
  if (msg.hasAttachments && msg.graphId) {
    const names = await ctx.attachments(msg.graphId)
    if (names.ok) attachmentNames = cleanAttachmentNames(names.names)
  }

  let aiSummary: string | null = null
  let aiUsed = offer !== null
  if (ctx.ai && !offer) {
    if (flags.length > 0) {
      ctx.stats.ai.skipped++
    } else {
      ctx.stats.ai.calls++
      const r = await ctx.ai({ subject: msg.subject, text: latest })
      if (!r) ctx.stats.ai.failed++
      else if (r.flags.length > 0) ctx.stats.ai.flagged++
      else {
        aiSummary = r.summary
        aiUsed = r.summary !== null || r.kind !== null
        if (recognition.signals.length === 0 && r.kind) {
          recognition = { ...recognition, signals: [r.kind], primary: r.kind }
        }
        if (recognition.signals.includes('schedule') && !recognition.proposedDate && r.date) {
          recognition = { ...recognition, proposedDate: r.date }
        }
      }
    }
  }

  // --- klient
  // Návrh zakázky z nabídky nese klienta z PDF (ověří a potvrdí člověk), odesílatel
  // (často Viktor sám, přeposlaná nabídka) klienta neurčuje.
  const match: ReturnType<typeof resolveAccount> = offer ? { status: 'none' } : resolveAccount(msg, await ctx.matchData())
  const waitReason: MailWaitReason = offer
    ? 'offer_draft'
    : match.status === 'none' ? 'no_match' : match.status === 'ambiguous' ? 'ambiguous' : 'assign_failed'

  // --- řádek fronty VŽDY první: zpráva se nesmí ztratit, ať se stane cokoli dál
  const audited = createAuditedAdminClient({ actor: auditActor({ type: 'system', id: MAIL_CONTENT_ACTOR_ID }), evidenceId: evidence.id, infoState: 'source_fact' })
  const inserted = await audited
    .from('mail_content_intake')
    .insert({
      source: MAIL_CONTENT_SOURCE,
      status: 'queued',
      wait_reason: waitReason,
      dedupe_key: dedupeKey,
      evidence_id: evidence.id,
      received_at: msg.receivedAt,
      sender_domain: counterpartDomain(msg),
      subject: cleanSubject(msg.subject),
      excerpt: recognition.excerpt,
      attachment_names: attachmentNames,
      signals: recognition.signals,
      proposed_date: recognition.proposedDate,
      ai_used: aiUsed,
      account_id: match.status === 'matched' ? match.accountId : null,
      match_method: match.status === 'matched' ? match.method : null,
      created_by: ctx.ownerId,
      ...(offer
        ? { offer_proposal_id: offer.proposalId, offer_draft: offer.draft, offer_pdf_sha256: offer.pdfSha256 }
        : {}),
    })
    .select('id')
    .single()
  if (inserted.error) {
    if (isMissingTable(inserted.error)) throw new MailContentAbort(MAIL_CONTENT_MIGRATION_PENDING)
    if (isUniqueViolation(inserted.error)) return { outcome: 'duplicate' }
    logDbError('mailContent.insert', inserted.error)
    throw new Error('mail_content_intake: chyba zápisu')
  }
  const rowId = (inserted.data as { id: number }).id
  if (match.status !== 'matched') return { outcome: 'queued', reason: waitReason }

  const wait = async (reason: MailWaitReason): Promise<MessageOutcome> => {
    const { error } = await audited.from('mail_content_intake').update({ wait_reason: reason }).eq('id', rowId).eq('status', 'queued')
    if (error) logDbError('mailContent.wait', error, { row: rowId })
    return { outcome: 'queued', reason }
  }

  // --- dodávka / obchod a milník
  const targets = await loadMailTargets(admin, match.accountId)
  if (!targets.accountName) return wait('assign_failed')
  const choice = chooseTarget(targets.options, msg.subject, latest)
  if (choice.status === 'ambiguous') return wait('ambiguous_target')
  const target = choice.status === 'chosen' ? choice.target : null
  const milestone = chooseMilestone(target?.kind === 'engagement' ? (targets.milestones[target.id] ?? []) : [], recognition.signals, msg.subject, latest)

  // --- návrh
  const proposal = await proposeFromMessage(admin, {
    row: {
      id: rowId,
      dedupeKey,
      evidence: evidenceRef,
      receivedAt: msg.receivedAt,
      signals: recognition.signals,
      proposedDate: recognition.proposedDate,
      attachmentNames,
      aiUsed,
      aiSummary,
    },
    account: { id: match.accountId, name: targets.accountName },
    target,
    targetUnclear: false,
    milestone,
  })
  if (proposal.status === 'pending_exists') return wait('proposal_pending')

  const patch = markProposedPatch({
    accountId: match.accountId,
    method: match.method,
    targeting: { target, unclear: false, milestone },
    proposalId: proposal.proposalId,
    actor: { type: 'system', id: MAIL_CONTENT_ACTOR_ID },
    now: ctx.now(),
  })
  const closed = await audited.from('mail_content_intake').update(patch).eq('id', rowId).eq('status', 'queued').select('id')
  if (closed.error) {
    // Návrh už existuje; řádek zůstane ve frontě a další pokus ho najde jako existující.
    logDbError('mailContent.close', closed.error, { row: rowId })
    return wait('assign_failed')
  }
  return { outcome: 'proposed' }
}

// ---------------------------------------------------------------------------
// Běh nad složkou

export type MailContentGraph = {
  findFolder(name: string): Promise<FolderLookup>
  createFolder(name: string): Promise<FolderLookup>
  fetchPage(url: string): Promise<ContentDeltaResult>
  fetchAttachments(graphId: string): Promise<AttachmentNames>
}

export function createMailContentGraph(accessToken: string): MailContentGraph {
  return {
    findFolder: (name) => findMailFolder(accessToken, name),
    createFolder: (name) => createMailFolder(accessToken, name),
    fetchPage: (url) => fetchContentDeltaPage(accessToken, url),
    fetchAttachments: (id) => fetchAttachmentNames(accessToken, id),
  }
}

export type MailContentRunOptions = {
  maxPages: number
  budgetMs: number
  maxThrottleAttempts: number
  maxWaitMs: number
  maxResyncs: number
}

export const DEFAULT_CONTENT_OPTIONS: MailContentRunOptions = {
  maxPages: 5,
  budgetMs: 20_000,
  maxThrottleAttempts: 2,
  maxWaitMs: 8_000,
  maxResyncs: 1,
}

type ContentCursor = { folderId: string; phase: 'paging' | 'delta'; link: string }

export function parseContentCursor(raw: string | null | undefined): ContentCursor | null {
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as { folderId?: unknown; phase?: unknown; link?: unknown }
    if (typeof v.folderId === 'string' && (v.phase === 'paging' || v.phase === 'delta') && isGraphLink(v.link)) {
      return { folderId: v.folderId, phase: v.phase, link: v.link }
    }
  } catch {
    /* neplatný JSON */
  }
  return null
}

const serializeCursor = (c: ContentCursor): string => JSON.stringify(c)

export const folderMissingMessage = (name: string): string =>
  `Složka „${name}“ v Outlooku neexistuje. Založte ji (nebo zapněte MAIL_CONTENT_FOLDER_CREATE), návod: docs/PROVOZ.md`
export const FOLDER_CREATE_FORBIDDEN_MESSAGE =
  'Cockpit nemá právo složku založit (chybí Mail.ReadWrite). Založte ji ručně v Outlooku, návod: docs/PROVOZ.md'

/**
 * Přečte nové zprávy ze složky a zpracuje je (viz hlavička souboru). Nikdy
 * nevyhazuje; výsledek jsou počty a kódy, žádný obsah. Chybu tokenu řeší volající.
 */
export async function runMailContentIntake(args: {
  admin: Db
  graph: MailContentGraph
  ownerId: string | null
  folderName: string
  createFolder: boolean
  ai: MailContentContext['ai']
  /** Nabídky z příloh (MAIL_OFFER_ATTACHMENT_ENABLED); null = přílohy jen jako názvy. */
  offer?: ((remainingMs: () => number, nowDate: () => Date) => MailOfferContext) | null
  now?: () => number
  sleep?: (ms: number) => Promise<void>
  options?: Partial<MailContentRunOptions>
}): Promise<MailContentRunStats> {
  const opt = { ...DEFAULT_CONTENT_OPTIONS, ...args.options }
  const now = args.now ?? Date.now
  const sleep = args.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const start = now()
  const remaining = () => opt.budgetMs - (now() - start)
  const stats = emptyRunStats()
  const connector = MAIL_CONTENT_CONNECTOR

  if (!COMPANY.capabilities.mailContent) {
    stats.outcome = 'not_configured'
    stats.aborted = MAIL_CONTENT_NOT_CONFIGURED
    return stats
  }

  try {
    // --- složka
    let folder = await args.graph.findFolder(args.folderName)
    if (folder.kind === 'missing' && args.createFolder) {
      folder = await args.graph.createFolder(args.folderName)
      if (folder.kind === 'found') stats.folder = 'created'
      else if (folder.kind === 'forbidden') {
        stats.folder = 'forbidden'
        stats.outcome = 'no_folder'
        await recordConnectorError(connector, FOLDER_CREATE_FORBIDDEN_MESSAGE)
        return stats
      }
    }
    if (folder.kind === 'forbidden') {
      stats.folder = 'forbidden'
      stats.outcome = 'missing_scope'
      await recordConnectorError(connector, MISSING_SCOPE_ERROR)
      return stats
    }
    if (folder.kind === 'throttled') {
      stats.folder = 'throttled'
      stats.outcome = 'throttled'
      return stats
    }
    if (folder.kind === 'error') {
      stats.folder = 'error'
      stats.outcome = 'error'
      stats.firstError = folder.message
      await recordConnectorError(connector, folder.message)
      return stats
    }
    if (folder.kind === 'missing') {
      stats.folder = 'missing'
      stats.outcome = 'no_folder'
      await recordConnectorError(connector, folderMissingMessage(args.folderName))
      return stats
    }
    if (stats.folder === 'not_checked') stats.folder = 'found'
    const folderId = folder.id
    const startUrl = contentDeltaStartUrl(folderId)

    // --- kurzor (jiná složka než minule = od začátku; duplicity odfiltruje dedupe_key)
    const stored = await args.admin.from('connector_state').select('cursor').eq('connector', connector).maybeSingle()
    let cursor = parseContentCursor((stored.data as { cursor?: string | null } | null)?.cursor)
    if (cursor && cursor.folderId !== folderId) cursor = null
    const saveCursor = async (c: string | null) => {
      const { error } = await args.admin
        .from('connector_state')
        .upsert({ connector, cursor: c, updated_at: new Date().toISOString() }, { onConflict: 'connector' })
      if (error) throw new Error(`connector_state: ${error.code ?? 'chyba zápisu'}`)
    }

    // Nabídky z příloh potřebují sloupce z migrace 0099; bez nich funkce nic nečte
    // a zprávy projdou běžnou cestou (nic se nerozbije).
    let offerCtx: MailOfferContext | null = null
    if (args.offer) {
      stats.offer = emptyOfferStats()
      if (await offerColumnsAvailable(args.admin)) offerCtx = args.offer(remaining, () => new Date(now()))
      else stats.offerDisabled = 'migration_pending'
    }

    let matchData: AccountMatchData | null = null
    const ctx: MailContentContext = {
      admin: args.admin,
      ownerId: args.ownerId,
      now: () => new Date(now()),
      attachments: args.graph.fetchAttachments,
      ai: args.ai,
      matchData: async () => (matchData ??= await loadMatchData(args.admin)),
      stats,
      offer: offerCtx,
    }

    let url = cursor?.link ?? startUrl
    let attempt = 0
    let resyncs = 0
    stats.outcome = 'more_pending'

    while (true) {
      if (stats.pages >= opt.maxPages || remaining() < REQUEST_RESERVE_MS) {
        stats.outcome = 'more_pending'
        break
      }
      const res = await args.graph.fetchPage(url)

      if (res.kind === 'throttled') {
        const d = decideThrottle({
          retryAfterSeconds: res.retryAfterSeconds,
          attempt,
          maxAttempts: opt.maxThrottleAttempts,
          remainingMs: remaining(),
          maxWaitMs: opt.maxWaitMs,
        })
        if (d.action === 'stop') {
          stats.outcome = 'throttled'
          break
        }
        attempt++
        await sleep(d.waitMs)
        continue
      }
      attempt = 0

      if (res.kind === 'expired') {
        await saveCursor(null)
        if (resyncs >= opt.maxResyncs) {
          stats.outcome = 'expired'
          break
        }
        resyncs++
        url = startUrl
        continue
      }
      if (res.kind === 'forbidden') {
        stats.outcome = 'missing_scope'
        await recordConnectorError(connector, MISSING_SCOPE_ERROR)
        break
      }
      if (res.kind === 'error') {
        stats.outcome = 'error'
        stats.firstError = res.message
        await recordConnectorError(connector, res.message)
        break
      }

      // Stránka: nejdřív zpracovat zprávy, teprve pak posunout kurzor.
      let pageFailed = false
      let pageDeferred = false
      for (const raw of res.messages) {
        const m = toContentMessage(raw)
        if ('skip' in m) {
          stats.skipped[m.skip] = (stats.skipped[m.skip] ?? 0) + 1
          continue
        }
        stats.messages++
        try {
          const r = await processContentMessage(ctx, m.message)
          if (r.outcome === 'duplicate') stats.skipped.duplicate = (stats.skipped.duplicate ?? 0) + 1
          else if (r.outcome === 'proposed') stats.proposed++
          else {
            stats.queued++
            stats.queuedReasons[r.reason] = (stats.queuedReasons[r.reason] ?? 0) + 1
          }
        } catch (e) {
          if (e instanceof MailOfferDefer) {
            // Není chyba: zpráva s nabídkou počká na další běh (čas, kapacita, Graph žádá počkat).
            pageDeferred = true
            break
          }
          if (e instanceof MailContentAbort) {
            stats.aborted = e.message
            stats.outcome = 'migration_pending'
            await recordConnectorError(connector, e.message)
            return stats
          }
          stats.errors++
          stats.firstError ??= shortError(e)
          pageFailed = true
          break
        }
      }
      if (pageDeferred) {
        // Kurzor se neposouvá: hotové zprávy přeskočí dedupe_key, odložená se zpracuje příště.
        stats.outcome = 'more_pending'
        break
      }
      if (pageFailed) {
        // Kurzor se neposouvá: další běh stránku zopakuje, hotové zprávy přeskočí dedupe_key.
        stats.outcome = 'error'
        await recordConnectorError(connector, `Zpracování zprávy selhalo: ${stats.firstError ?? 'chyba'}`)
        break
      }
      stats.pages++

      const next = res.nextLink
        ? ({ folderId, phase: 'paging', link: res.nextLink } as const)
        : res.deltaLink
          ? ({ folderId, phase: 'delta', link: res.deltaLink } as const)
          : null
      if (!next) {
        stats.outcome = 'error'
        stats.firstError = 'Graph nevrátil nextLink ani deltaLink'
        await recordConnectorError(connector, stats.firstError)
        break
      }
      cursor = next
      await saveCursor(serializeCursor(cursor))
      if (next.phase === 'delta') {
        stats.outcome = 'caught_up'
        await recordConnectorSuccess(connector, serializeCursor(cursor))
        break
      }
      url = next.link
    }
  } catch (e) {
    stats.outcome = 'error'
    stats.errors++
    stats.firstError ??= shortError(e)
    logError('mailContent.run', e instanceof Error ? e.name : 'chyba')
    await recordConnectorError(connector, `Synchronizace složky selhala: ${stats.firstError}`)
  }
  return stats
}

/**
 * Běh pro cron: skutečný Graph, servisní klíč a (jen s MAIL_CONTENT_AI_ENABLED
 * a ANTHROPIC_API_KEY) model. Zapnutí přepínačem hlídá volající.
 */
export async function runMailContentIntakeLive(args: {
  accessToken: string
  ownerId: string | null
  budgetMs: number
  env?: Record<string, string | undefined>
}): Promise<MailContentRunStats> {
  const env = args.env ?? process.env
  const aiOn = mailContentAiEnabledFromEnv(env) && !!env.ANTHROPIC_API_KEY
  const admin = createAdminClient()
  // Nabídky z příloh: jen se zapnutým MAIL_OFFER_ATTACHMENT_ENABLED, zapnutou poštou
  // s obsahem (jsme tady) a ANTHROPIC_API_KEY.
  const offerOn = mailOfferEnabledFromEnv({ ...env, MAIL_CONTENT_INTAKE_ENABLED: 'true' })
  const keywords = offerKeywordsFromEnv(env)
  return runMailContentIntake({
    admin,
    graph: createMailContentGraph(args.accessToken),
    ownerId: args.ownerId,
    folderName: mailContentFolderName(env),
    createFolder: mailContentFolderCreateFromEnv(env),
    ai: aiOn ? (input) => summarizeMailContent(input) : null,
    offer: offerOn
      ? (remainingMs, nowDate) => createMailOfferContext(createLiveOfferDeps({ accessToken: args.accessToken, admin, remainingMs, now: nowDate, keywords }))
      : null,
    options: { budgetMs: args.budgetMs },
  })
}

/** Retence obsahu (0091): čekající po 30 dnech vyprší, návrhy ztratí úryvek. Bez migrace tiše null. */
export async function purgeMailContent(admin: Db): Promise<{ expired: number; cleared: number } | null> {
  const { data, error } = await admin.rpc('purge_mail_content_intake')
  if (error) {
    if (error.code === '42883' || error.code === 'PGRST202' || isMissingTable(error)) return null
    logDbError('mailContent.purge', error)
    return null
  }
  const r = data as { expired?: number; cleared?: number } | null
  return { expired: r?.expired ?? 0, cleared: r?.cleared ?? 0 }
}

// ---------------------------------------------------------------------------
// Ruční rozhodnutí (fronta „Pošta k zařazení")

type QueueRow = {
  id: number
  status: string
  dedupe_key: string
  evidence_id: number
  received_at: string
  subject: string | null
  excerpt: string | null
  attachment_names: unknown
  signals: unknown
  proposed_date: string | null
  ai_used: boolean
  wait_reason: string | null
}

const QUEUE_COLUMNS = 'id, status, wait_reason, dedupe_key, evidence_id, received_at, subject, excerpt, attachment_names, signals, proposed_date, ai_used'

const stringArray = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
const signalArray = (v: unknown): MailSignal[] => stringArray(v).filter((s): s is MailSignal => (MAIL_SIGNALS as readonly string[]).includes(s))

function failed(error: string, status = 400): WriteResult<never> {
  return { ok: false, status, error }
}

async function loadQueueRow(db: Db, id: number): Promise<WriteResult<QueueRow>> {
  // Návrh zakázky z konektoru (source mcp_connector) se tudy nepřiřazuje ani nezahazuje: jen /rozhodnuti.
  const { data, error } = await db.from('mail_content_intake').select(QUEUE_COLUMNS).eq('id', id).neq('source', CONNECTOR_SOURCE).maybeSingle()
  if (error) {
    if (isMissingTable(error)) return failed(MAIL_CONTENT_MIGRATION_PENDING, 503)
    logDbError('mailContent.load', error, { row: id })
    return failed('Zprávu se nepodařilo načíst.', 500)
  }
  if (!data) return failed(MAIL_ROW_NOT_FOUND_ERROR, 404)
  const row = data as QueueRow
  if (row.status !== 'queued') return failed(MAIL_ROW_HANDLED_ERROR, 409)
  return { ok: true, data: row }
}

/**
 * Volba dodávky z formuláře: 'engagement:12', 'deal:5', 'account' (jen klient,
 * bez dodávky) nebo prázdné (Cockpit vybere sám podle předmětu a úryvku).
 */
export function parseTargetKey(raw: string | null | undefined): { kind: 'engagement' | 'deal'; id: number } | 'account' | null | 'invalid' {
  const v = (raw ?? '').trim()
  if (v === '') return null
  if (v === 'account') return 'account'
  const m = /^(engagement|deal):([1-9]\d{0,17})$/.exec(v)
  return m ? { kind: m[1] as 'engagement' | 'deal', id: Number(m[2]) } : 'invalid'
}

/**
 * Člověk přiřadí čekající zprávu ke klientovi (a případně dodávce nebo obchodu).
 * Vznikne NÁVRH pracovního případu; řádek se uzavře jako 'proposed'. Volá server
 * akce PO requireUser({ aal2: true }) a kontrole obchodní role. Opakované volání
 * (dvojklik, výpadek po založení návrhu) nic nezdvojí: návrh má klíč zprávy.
 */
export async function assignQueuedMail(args: {
  rowId: number
  accountId: number
  targetKey?: string | null
  userId: string
  now?: Date
}): Promise<WriteResult<{ proposalId: number }>> {
  const admin = createAdminClient()
  const loaded = await loadQueueRow(admin, args.rowId)
  if (!loaded.ok) return loaded
  const row = loaded.data
  // Návrh zakázky se potvrzuje v jeho formuláři (confirmOfferProposal), ne přiřazením ke klientovi.
  if (row.wait_reason === 'offer_draft') return failed(MAIL_OFFER_ROW_ERROR, 409)

  const parsedKey = parseTargetKey(args.targetKey)
  if (parsedKey === 'invalid') return failed('Neplatná volba dodávky.')

  let targets: AccountTargets
  try {
    targets = await loadMailTargets(admin, args.accountId)
  } catch (e) {
    logDbError('mailContent.assign.targets', e, { row: row.id })
    return failed('Klienta se nepodařilo načíst.', 500)
  }
  if (!targets.accountName) return failed(MAIL_ACCOUNT_NOT_FOUND_ERROR, 404)

  const subject = row.subject ?? ''
  const text = row.excerpt ?? ''
  let target: TargetOption | null = null
  let unclear = false
  if (parsedKey === 'account') {
    unclear = targets.options.length > 0
  } else if (parsedKey) {
    target = targets.options.find((o) => o.kind === parsedKey.kind && o.id === parsedKey.id) ?? null
    if (!target) return failed(MAIL_TARGET_MISMATCH_ERROR)
  } else {
    const choice = chooseTarget(targets.options, subject, text)
    if (choice.status === 'chosen') target = choice.target
    // Klienta už vybral člověk; nejasná dodávka se v návrhu jen přizná.
    else if (choice.status === 'ambiguous') unclear = true
  }
  const signals = signalArray(row.signals)
  const milestone = chooseMilestone(target?.kind === 'engagement' ? (targets.milestones[target.id] ?? []) : [], signals, subject, text)

  const ref = await loadEvidenceRef(admin, row.evidence_id)
  if (!ref) return failed('Odkaz na zprávu se nepodařilo načíst.', 500)

  let proposal: ProposalResult
  try {
    proposal = await proposeFromMessage(admin, {
      row: {
        id: row.id,
        dedupeKey: row.dedupe_key,
        evidence: ref,
        receivedAt: new Date(row.received_at).toISOString(),
        signals,
        proposedDate: row.proposed_date,
        attachmentNames: stringArray(row.attachment_names),
        aiUsed: row.ai_used,
        aiSummary: null,
      },
      account: { id: args.accountId, name: targets.accountName },
      target,
      targetUnclear: unclear,
      milestone,
    })
  } catch (e) {
    if (e instanceof MailContentAbort) return failed(e.message, 503)
    logDbError('mailContent.assign.proposal', e, { row: row.id })
    return failed('Návrh se nepodařilo založit.', 500)
  }

  const actor: Actor = { type: 'user', id: args.userId }
  const audited = createAuditedAdminClient({ actor: auditActor(actor), evidenceId: row.evidence_id })
  if (proposal.status === 'pending_exists') {
    await audited.from('mail_content_intake').update({ account_id: args.accountId, wait_reason: 'proposal_pending' }).eq('id', row.id).eq('status', 'queued')
    return failed(MAIL_WAIT_REASON_TEXT.proposal_pending, 409)
  }
  const patch = markProposedPatch({
    accountId: args.accountId,
    method: 'manual',
    targeting: { target, unclear, milestone },
    proposalId: proposal.proposalId,
    actor,
    now: args.now ?? new Date(),
  })
  const closed = await audited.from('mail_content_intake').update(patch).eq('id', row.id).eq('status', 'queued').select('id')
  if (closed.error) {
    logDbError('mailContent.assign.close', closed.error, { row: row.id })
    return failed('Zprávu se nepodařilo uzavřít.', 500)
  }
  if (!closed.data || closed.data.length === 0) return failed(MAIL_ROW_HANDLED_ERROR, 409)
  return { ok: true, data: { proposalId: proposal.proposalId } }
}

/** Člověk čekající zprávu zahodí; předmět, úryvek a názvy příloh se smažou. */
export async function discardQueuedMail(args: { rowId: number; userId: string; now?: Date }): Promise<WriteResult<{ id: number }>> {
  const admin = createAdminClient()
  const loaded = await loadQueueRow(admin, args.rowId)
  if (!loaded.ok) return loaded
  const actor: Actor = { type: 'user', id: args.userId }
  const audited = createAuditedAdminClient({ actor: auditActor(actor) })
  const { data, error } = await audited
    .from('mail_content_intake')
    .update({
      status: 'discarded',
      wait_reason: null,
      subject: null,
      excerpt: null,
      attachment_names: [],
      // Návrh zakázky z nabídky (0099) se zahozením smaže; sloupec existuje jen tam, kde je takový řádek.
      ...(loaded.data.wait_reason === 'offer_draft' ? { offer_draft: null } : {}),
      decided_by: actorText(actor),
      decided_at: (args.now ?? new Date()).toISOString(),
    })
    .eq('id', args.rowId)
    .eq('status', 'queued')
    .select('id')
  if (error) {
    logDbError('mailContent.discard', error, { row: args.rowId })
    return failed('Zprávu se nepodařilo zahodit.', 500)
  }
  if (!data || data.length === 0) return failed(MAIL_ROW_HANDLED_ERROR, 409)
  return { ok: true, data: { id: args.rowId } }
}

async function loadEvidenceRef(db: Db, evidenceId: number): Promise<EvidenceRef | null> {
  const { data, error } = await db.from('evidence').select('source_kind, source_id, web_link').eq('id', evidenceId).maybeSingle()
  if (error || !data) return null
  const r = data as { source_kind: string; source_id: string; web_link: string | null }
  if (r.source_kind !== 'email_message') return null
  return { kind: 'email_message', sourceId: r.source_id, webLink: r.web_link }
}
