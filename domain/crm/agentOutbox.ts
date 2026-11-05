// Úloha agent-outbox (balík P3): jediná cesta, kudy Cockpit posílá e-mail
// zákazníkovi. Logika je tady s vstříknutým úložištěm (OutboxStore, RPC
// z 0104) a poštou (OutboxMail, Gmail), takže je testovatelná bez sítě
// a databáze. Zapojení na Supabase a Gmail: ./agentOutboxService.ts.
//
// Běh:
//   1) rezervace visící déle než N minut → needs_attention + úkol (nic znovu),
//   2) zamítnuté/vypršelé žádosti → důvod u čekající zprávy,
//   3) nejisté zprávy (needs_attention s vlastním Message-ID) se dohledají
//      v Odeslané poště; nalezená = potvrzení, nenalezená = rozhodne člověk,
//   4) zprávy ve stavu queued: fakta → decideOutbox (core/agents/outboxPolicy)
//      → claim (rezervace, limity) → Gmail → confirm / finish,
//   5) retence textů.
//
// ZÁRUKA „NIKDY DVAKRÁT": Gmail se volá jen po úspěšném claimu (řádek
// queued → claimed v DB pod zámkem). Zprávu ve stavu claimed nebo
// needs_attention úloha sama nikdy znovu neposílá — jen ji dohledává podle
// Message-ID. Do fronty ji vrátí jedině agent_outbox_release (člověk)
// nebo prokazatelné odmítnutí limitem Gmailu (throttled).
//
// LOGY: jen id, druhy a kódy. Nikdy text, předmět ani adresy.
import { createHash, randomBytes } from 'node:crypto'
import type { OutboxHeaders, OutboxKind } from '@/core/agents/outboxPort'
import type { AgentOutboxConfig } from '@/core/agents/outboxConfig'
import {
  OUTBOX_REASON_LABELS,
  customerText,
  decideOutbox,
  isAutomatedAddress,
  isOwnAddress,
  isVipAddress,
  normalizeAddress,
  outboxLimits,
  replyTarget,
  type OutboxDecision,
  type OutboxFacts,
  type OutboxGates,
  type OutboxItemView,
  type ReplyProblem,
} from '@/core/agents/outboxPolicy'

// --- Data ----------------------------------------------------------------------

/** Řádek agent_outbox, jak ho úloha čte (servisní klíč). */
export interface OutboxRow {
  id: number
  kind: OutboxKind
  source_ref: string
  deal_id: number
  scope_version_id: number | null
  mailbox_member_id: string | null
  mode: 'reply' | 'to'
  in_reply_to_message_id: string | null
  to_email: string | null
  subject: string | null
  body: string | null
  /** Jen oslovení (P7): List-Unsubscribe a List-Unsubscribe-Post. */
  headers?: OutboxHeaders | null
  price_map_version: string | null
  quote_total: number | string | null
  status: string
  stop_reason: string | null
  approved_at: string | null
  rfc_message_id: string | null
  created_at: string
  body_purged_at: string | null
}

export const OUTBOX_COLUMNS =
  'id, kind, source_ref, deal_id, scope_version_id, mailbox_member_id, mode, in_reply_to_message_id, to_email, subject, body, headers, price_map_version, quote_total, status, stop_reason, approved_at, rfc_message_id, created_at, body_purged_at'

/** Fakta z CRM k jedné zprávě (bez osobních údajů v logu). */
export interface DealFacts {
  dealClosed: boolean
  snoozed: boolean
  /** Příjemce nesouhlasí s oslovením (kontakt s adresou, do_not_contact). */
  doNotContact: boolean
  /** Nabídka: stav verze (null = bez verze). */
  versionStatus: string | null
  /** Nabídka: verze schválená k odeslání (send_approved_at). */
  versionSendApproved: boolean
  mailbox: { email: string; active: boolean } | null
  /** Člověk zapsal k obchodu aktivitu po daném okamžiku. */
  humanActivity: boolean
}

export type ClaimResult = { ok: true } | { ok: false; reason: string }

export interface OutboxStore {
  markStale(minutes: number): Promise<number[]>
  syncApprovals(): Promise<number>
  listQueued(limit: number): Promise<OutboxRow[]>
  /** needs_attention s vlastním Message-ID (nejisté odeslání), nejstarší první. */
  listUncertain(limit: number): Promise<OutboxRow[]>
  autonomyGranted(kind: OutboxKind): Promise<boolean>
  dealFacts(row: OutboxRow, recipient: string | null, since: string): Promise<DealFacts>
  claim(input: { id: number; recipient: string; rfcMessageId: string; autonomous: boolean; dailyLimit: number; limitKinds: OutboxKind[]; perRecipientDailyLimit: number }): Promise<ClaimResult>
  confirm(id: number, sentMessageId: string, sentThreadId: string | null, bodySha256: string | null): Promise<void>
  finish(id: number, status: 'blocked' | 'failed' | 'needs_attention' | 'queued', reason: string, errorCode?: string | null, task?: { title: string; text: string } | null): Promise<boolean>
  requestOfferApproval(id: number): Promise<{ ok: boolean; reason?: string }>
  purgeText(days: number): Promise<number>
  /**
   * Režim nové zprávy ({to}) u odpovědi na e-mailovou poptávku
   * ('inquiry:<run id>', jiná schránka než příjemce): Message-ID původní
   * zprávy z inquiry_agent_run.internet_message_id pro In-Reply-To
   * a References, ať zákazník odpověď vidí ve svém vlákně. null = nic.
   */
  threadHeaders?(row: OutboxRow): Promise<{ inReplyTo: string; references: string } | null>
}

/** reason: kód selhání tokenu (např. invalid_grant, not_configured) — do statistik a alarmu. */
export type MailToken = { ok: true; accessToken: string } | { ok: false; reason?: string }

export interface OriginalMessage {
  threadId: string | null
  from: string | null
  replyTo: string | null
  messageId: string | null
  references: string | null
  authResults: string[]
}

export type SendOutcome =
  | { kind: 'accepted'; id: string; threadId: string | null }
  | { kind: 'throttled' | 'unauthorized' | 'forbidden' | 'rejected' | 'uncertain'; reason: string }

export interface OutboxMail {
  token(memberId: string): Promise<MailToken>
  original(token: string, gmailMessageId: string): Promise<{ ok: true; message: OriginalMessage } | { ok: false; kind: 'not_found' | 'unauthorized' | 'forbidden' | 'error' }>
  /** Napsal zákazník do vlákna po `sinceMs` (zpráva bez štítku SENT od jiné adresy než schránka)? */
  customerRepliedInThread(token: string, threadId: string, sinceMs: number, mailboxEmail: string): Promise<boolean | null>
  send(token: string, input: { from: { name: string; address: string }; to: string; subject: string; text: string; messageId: string; inReplyTo: string | null; references: string | null; threadId: string | null; outboxId: number; headers?: OutboxHeaders | null }): Promise<SendOutcome>
  findSent(token: string, rfcMessageId: string): Promise<{ ok: true; found: { id: string; threadId: string | null } | null } | { ok: false }>
}

export interface OutboxRunConfig {
  outbox: AgentOutboxConfig
  /** env AGENT_AUTOSEND_ENABLED === 'true' */
  autoSendEnabled: boolean
  companyMapVersion: string | null
  autoSendMaxTotal: number | null
  autoSendKinds: readonly OutboxKind[]
  inquiryLimits: { dailyAutoSendLimit: number; perRecipientDailyLimit: number } | null
  followUpLimits: { dailyLimit: number } | null
  /** Je teď okno odesílání připomínek? (null = připomínky bez okna) */
  followUpWindowOpen: boolean | null
  /** Oslovení (P7): denní limit z outboundAgent.outreach; null = firma outbound nemá (nic neodejde). */
  outreachLimits?: { dailyLimit: number } | null
  /** Je teď okno odesílání oslovení (outboundAgent.outreach.sendWindow)? */
  outreachWindowOpen?: boolean | null
  wonPhases: readonly string[]
}

export interface OutboxRunStats {
  stale: number
  approvalsSynced: number
  reconciled: number
  processed: number
  sent: number
  sentAutonomous: number
  approvalRequested: number
  blocked: number
  failed: number
  uncertain: number
  deferred: number
  purged: number
  reasons: Record<string, number>
}

const emptyStats = (): OutboxRunStats => ({
  stale: 0, approvalsSynced: 0, reconciled: 0, processed: 0, sent: 0, sentAutonomous: 0, approvalRequested: 0,
  blocked: 0, failed: 0, uncertain: 0, deferred: 0, purged: 0, reasons: {},
})

const bump = (s: OutboxRunStats, reason: string) => {
  s.reasons[reason] = (s.reasons[reason] ?? 0) + 1
}

// --- Pomocné ---------------------------------------------------------------------

const KIND_LABEL: Record<OutboxKind, string> = { offer: 'cenová nabídka', info_request: 'doptání údajů', follow_up: 'připomínka nabídky', outreach: 'obchodní oslovení' }

/** Vlastní Message-ID (podle něj se zpráva dohledá v Odeslané poště). */
export function newRfcMessageId(id: number, domain: string, rand: () => string = () => randomBytes(9).toString('hex')): string {
  const d = domain.trim().toLowerCase()
  if (!/^[a-z0-9.-]{1,70}$/.test(d)) throw new Error('agentOutbox: neplatná doména Message-ID')
  return `<ao.${id}.${rand()}@${d}>`
}

export const sha256Hex = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex')

/** Stop pravidla, u kterých vlastník dostane úkol (u uzavřeného obchodu nebo nesouhlasu ne). */
const BLOCK_WITH_TASK = new Set<string>([
  'missing_recipient', 'own_address', 'automated_recipient', 'version_not_draft', 'mailbox_inactive',
  'from_invalid', 'reply_to_mismatch', 'sender_not_verified', 'customer_replied',
])

function taskFor(row: OutboxRow, reason: string, what: string): { title: string; text: string } {
  const label = OUTBOX_REASON_LABELS[reason as keyof typeof OUTBOX_REASON_LABELS] ?? reason
  return {
    title: `${what}: ${KIND_LABEL[row.kind]} (fronta č. ${row.id})`,
    text: `Odchozí fronta agenta zprávu (${KIND_LABEL[row.kind]}) neodeslala: ${label}. Zkontroluj obchod a zprávu v Cockpitu; když má odejít, uvolni ji, jinak odpověz zákazníkovi sám.`,
  }
}

function hoursSince(iso: string, now: Date): number {
  const t = Date.parse(iso)
  return Number.isFinite(t) ? Math.max(0, (now.getTime() - t) / 3_600_000) : Number.POSITIVE_INFINITY
}

// --- Běh -------------------------------------------------------------------------

export interface OutboxRunDeps {
  store: OutboxStore
  mail: OutboxMail
  config: OutboxRunConfig
  now: () => Date
  /** Měkký limit času běhu (ms od startu); po něm se další zprávy nezačínají. */
  budgetMs?: number
  log?: (event: string, ctx: Record<string, string | number | boolean | null>) => void
}

export async function runAgentOutbox(deps: OutboxRunDeps): Promise<OutboxRunStats> {
  const { store, config } = deps
  const stats = emptyStats()
  const started = deps.now().getTime()
  const overBudget = () => deps.budgetMs != null && deps.now().getTime() - started > deps.budgetMs
  const log = deps.log ?? (() => undefined)
  const tokens = new Map<string, Promise<MailToken>>()
  const tokenFor = (memberId: string) => {
    let t = tokens.get(memberId)
    if (!t) {
      t = deps.mail.token(memberId)
      tokens.set(memberId, t)
    }
    return t
  }

  stats.stale = (await store.markStale(config.outbox.staleClaimMinutes)).length
  stats.approvalsSynced = await store.syncApprovals()

  // 3) Nejisté zprávy: jen dohledat, nikdy znovu poslat.
  for (const row of await store.listUncertain(config.outbox.maxPerRun)) {
    if (overBudget()) break
    if (!row.mailbox_member_id || !row.rfc_message_id) continue
    const tok = await tokenFor(row.mailbox_member_id)
    if (!tok.ok) continue
    try {
      const found = await deps.mail.findSent(tok.accessToken, row.rfc_message_id)
      if (found.ok && found.found) {
        await store.confirm(row.id, found.found.id, found.found.threadId, null)
        stats.reconciled++
        log('outbox.reconciled', { id: row.id, kind: row.kind })
      }
    } catch (e) {
      bump(stats, 'reconcile_error')
      log('outbox.error', { id: row.id, kind: row.kind, error: e instanceof Error ? e.name : 'unknown' })
    }
  }

  // 4) Fronta.
  for (const row of await store.listQueued(config.outbox.maxPerRun)) {
    if (overBudget()) break
    stats.processed++
    try {
      await processRow(row, deps, stats, tokenFor, log)
    } catch (e) {
      // Chyba DB/sítě mimo odeslání: řádek zůstává, jak byl (queued nebo
      // claimed → mark_stale → dohledání). Nikdy nic znovu neposíláme.
      bump(stats, 'error')
      log('outbox.error', { id: row.id, kind: row.kind, error: e instanceof Error ? e.name : 'unknown' })
    }
  }

  stats.purged = await store.purgeText(config.outbox.retentionDays)
  return stats
}

async function processRow(
  row: OutboxRow,
  deps: OutboxRunDeps,
  stats: OutboxRunStats,
  tokenFor: (memberId: string) => Promise<MailToken>,
  log: NonNullable<OutboxRunDeps['log']>,
): Promise<void> {
  const { store, config, mail } = deps
  const now = deps.now()
  const block = async (reason: string) => {
    const task = BLOCK_WITH_TASK.has(reason) ? taskFor(row, reason, 'Neodesláno') : null
    await store.finish(row.id, 'blocked', reason, null, task)
    stats.blocked++
    bump(stats, reason)
    log('outbox.blocked', { id: row.id, kind: row.kind, reason })
  }

  if (row.body_purged_at || !row.body || !row.subject) return block('body_purged')
  if (!row.mailbox_member_id) return block('mailbox_inactive')
  // Oslovení (P7) bez hlaviček odhlášení nesmí odejít (DB to hlídá taky).
  if (row.kind === 'outreach' && !row.headers?.['List-Unsubscribe']) return block('missing_unsubscribe')

  const tok = await tokenFor(row.mailbox_member_id)
  if (!tok.ok) {
    // Schránka není připojená: nic se nemění, zkusí se v dalším běhu.
    // Kód (token_invalid_grant …) jde do statistik běhu; z nich alarm
    // (domain/ops/opsHealth.ts) pozná neplatný OAuth Gmailu.
    stats.deferred++
    bump(stats, tok.reason ? `token_${tok.reason}` : 'token_unavailable')
    return
  }

  // Příjemce a vlákno.
  let recipient: string | null = null
  let replyProblems: ReplyProblem[] = []
  let original: OriginalMessage | null = null
  if (row.mode === 'reply') {
    const o = row.in_reply_to_message_id ? await mail.original(tok.accessToken, row.in_reply_to_message_id) : null
    if (!o || !o.ok) {
      if (o && !o.ok && o.kind === 'error') {
        stats.deferred++
        bump(stats, 'gmail_read_error')
        return
      }
      return block('from_invalid')
    }
    original = o.message
    const t = replyTarget({ from: original.from, replyTo: original.replyTo, authResults: original.authResults, trustedAuthServId: config.outbox.trustedAuthServId })
    recipient = t.recipient
    replyProblems = t.problems
  } else {
    recipient = normalizeAddress(row.to_email)
  }
  // Nová zpráva ({to}) jako odpověď na e-mailovou poptávku: zařadit do vlákna zákazníka.
  const thread = row.mode === 'to' && store.threadHeaders ? await store.threadHeaders(row) : null

  const since = row.approved_at && row.approved_at > row.created_at ? row.approved_at : row.created_at
  const facts = await store.dealFacts(row, recipient, since)
  let customerReplied = false
  if (original?.threadId && facts.mailbox && recipient) {
    customerReplied = (await mail.customerRepliedInThread(tok.accessToken, original.threadId, Date.parse(since), facts.mailbox.email)) === true
  }

  const item: OutboxItemView = {
    kind: row.kind,
    priceMapVersion: row.price_map_version,
    quoteTotal: row.quote_total == null ? null : Number(row.quote_total),
    humanApproved: row.kind === 'offer' ? facts.versionSendApproved : row.approved_at != null,
    bodyPurged: false,
    ageHours: hoursSince(row.created_at, now),
  }
  const f: OutboxFacts = {
    recipient,
    replyProblems,
    ownAddress: recipient != null && isOwnAddress(recipient, config.outbox.ownDomains),
    automatedRecipient: recipient != null && isAutomatedAddress(recipient),
    doNotContact: facts.doNotContact,
    dealClosed: facts.dealClosed,
    versionIsDraft: row.kind === 'offer' ? facts.versionStatus === 'draft' : null,
    mailboxActive: facts.mailbox?.active === true,
    customerReplied,
    humanActivity: facts.humanActivity,
    snoozed: facts.snoozed,
    vip: recipient != null && isVipAddress(recipient, config.outbox.vipAddresses),
  }
  const gates: OutboxGates = {
    autoSendEnabled: config.autoSendEnabled,
    // DB se ptáme jen, když má smysl (přepínač zapnutý a druh povolený).
    autonomyGranted: config.autoSendEnabled && config.autoSendKinds.includes(row.kind) ? await store.autonomyGranted(row.kind) : false,
    companyMapVersion: config.companyMapVersion,
    autoSendKinds: config.autoSendKinds,
    autoSendMaxTotal: config.autoSendMaxTotal,
    maxQueueAgeHours: config.outbox.maxQueueAgeHours,
    withinSendWindow: row.kind === 'follow_up' ? config.followUpWindowOpen
      : row.kind === 'outreach' ? (config.outreachLimits ? config.outreachWindowOpen ?? false : false)
      : null,
  }

  const decision: OutboxDecision = decideOutbox(item, f, gates)
  if (decision.action === 'block') return block(decision.reason)
  if (decision.action === 'wait') {
    stats.deferred++
    bump(stats, decision.reason)
    return
  }
  if (decision.action === 'request_approval') return requestApproval(row, decision.reasons[0] ?? 'authority_not_l4', deps, stats, log)

  // --- Odeslání: claim → Gmail → confirm/finish -------------------------------
  const limits = outboxLimits(row.kind, config.inquiryLimits, config.followUpLimits, config.outreachLimits)
  const rfcMessageId = newRfcMessageId(row.id, config.outbox.messageIdDomain)
  const claimed = await store.claim({
    id: row.id, recipient: recipient!, rfcMessageId, autonomous: decision.autonomous,
    dailyLimit: limits.dailyLimit, limitKinds: limits.limitKinds, perRecipientDailyLimit: limits.perRecipientDailyLimit,
  })
  if (!claimed.ok) {
    if (claimed.reason === 'daily_limit' || claimed.reason === 'recipient_limit') {
      // Zůstává ve frontě, další den se zkusí znovu.
      stats.deferred++
      bump(stats, claimed.reason)
      return
    }
    if (claimed.reason === 'not_authorized' || claimed.reason === 'not_approved') {
      return requestApproval(row, 'authority_not_l4', deps, stats, log)
    }
    if (claimed.reason === 'quote_mismatch') {
      // 0109: částka nebo rozsah verze nabídky se po přípravě textu změnily.
      // Claim zprávu už přepnul na needs_attention a založil úkol (přegenerovat
      // koncept); stará cena zákazníkovi neodejde.
      stats.blocked++
      bump(stats, 'quote_mismatch')
      log('outbox.quote_mismatch', { id: row.id, kind: row.kind })
      return
    }
    bump(stats, `claim_${claimed.reason}`)
    return
  }

  const text = customerText(row.kind, row.body!, config.outbox)
  const outcome = await mail.send(tok.accessToken, {
    from: { name: config.outbox.fromName, address: facts.mailbox!.email },
    to: recipient!,
    subject: row.subject!,
    text,
    messageId: rfcMessageId,
    inReplyTo: original?.messageId ?? thread?.inReplyTo ?? null,
    references: original?.references ?? thread?.references ?? null,
    threadId: original?.threadId ?? null,
    outboxId: row.id,
    headers: row.kind === 'outreach' ? row.headers ?? null : null,
  })

  if (outcome.kind === 'accepted') {
    // Selže-li potvrzení (DB), řádek zůstane claimed → mark_stale → dohledání
    // podle Message-ID. Znovu se neposílá.
    await store.confirm(row.id, outcome.id, outcome.threadId, sha256Hex(text))
    stats.sent++
    if (decision.autonomous) stats.sentAutonomous++
    log('outbox.sent', { id: row.id, kind: row.kind, autonomous: decision.autonomous })
    return
  }
  if (outcome.kind === 'throttled') {
    await store.finish(row.id, 'queued', 'throttled', null, null)
    stats.deferred++
    bump(stats, 'throttled')
    return
  }
  if (outcome.kind === 'uncertain') {
    await store.finish(row.id, 'needs_attention', 'uncertain', outcome.reason.toLowerCase().slice(0, 64) || null, taskFor(row, 'uncertain', 'Zkontrolovat odeslání'))
    stats.uncertain++
    bump(stats, 'uncertain')
    log('outbox.uncertain', { id: row.id, kind: row.kind })
    return
  }
  await store.finish(row.id, 'failed', outcome.kind, outcome.reason.toLowerCase().slice(0, 64) || null, taskFor(row, outcome.kind, 'Odeslání selhalo'))
  stats.failed++
  bump(stats, outcome.kind)
  log('outbox.failed', { id: row.id, kind: row.kind, reason: outcome.kind })
}

async function requestApproval(
  row: OutboxRow,
  reason: string,
  deps: OutboxRunDeps,
  stats: OutboxRunStats,
  log: NonNullable<OutboxRunDeps['log']>,
): Promise<void> {
  stats.approvalRequested++
  bump(stats, reason)
  if (row.kind === 'offer') {
    // Typovaná žádost send_offer (Ke schválení); po schválení se zpráva vrátí do fronty.
    const r = await deps.store.requestOfferApproval(row.id)
    log('outbox.approval_requested', { id: row.id, kind: row.kind, ok: r.ok })
    return
  }
  const label = OUTBOX_REASON_LABELS[reason as keyof typeof OUTBOX_REASON_LABELS] ?? reason
  await deps.store.finish(row.id, 'blocked', 'approval_required', null, {
    title: `Schválit odeslání: ${KIND_LABEL[row.kind]} (fronta č. ${row.id})`,
    text: `Agent připravil zprávu zákazníkovi (${KIND_LABEL[row.kind]}), ale sám ji neodešle: ${label}. Zkontroluj text v Cockpitu a uvolni ho k odeslání, nebo odpověz sám.`,
  })
  log('outbox.approval_requested', { id: row.id, kind: row.kind, ok: true })
}
