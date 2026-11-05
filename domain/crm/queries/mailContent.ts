import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { logError } from '@/lib/log'
import { isMissingColumn, isMissingRelation } from '@/core/loopQueries'
import { findAccountByName } from '@/domain/crm/offerAccount'
import { parseStoredProposal } from '@/domain/crm/offerProposal'
import type { OfferProposalView } from '@/domain/crm/actions/offers'
import { MAIL_SIGNALS, MAIL_WAIT_REASONS, type MailSignal, type MailWaitReason, type TargetOption } from '@/domain/crm/mailContent'
import { loadMailTargets } from '@/domain/crm/mailTargets'
// Návrhy zakázek z konektoru (Claude) žijí ve stejné tabulce, ale schvalují se na
// /rozhodnuti (domain/crm/connectorProposals.ts) — do „Pošty k zařazení" nepatří.
import { CONNECTOR_SOURCE } from '@/domain/crm/connectorProposals'

// Pošta s obsahem (migrace 0091): fronta „Pošta k zařazení", karta na Dnes,
// úryvky u návrhů. Čtení jde přes session klienta — RLS pustí jen obchodní
// role (can_see_sales) s AAL2; ostatním se vrátí prázdno. Bez migrace 0091
// (tabulka neexistuje) vrací dotazy null / prázdné pole, obrazovky se nerozbijí.

type Db = Pick<SupabaseClient, 'from'>
type Joined<T> = T | T[] | null
const one = <T,>(v: Joined<T>): T | null => (Array.isArray(v) ? (v[0] ?? null) : v)

const stringArray = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
const signalArray = (v: unknown): MailSignal[] => stringArray(v).filter((s): s is MailSignal => (MAIL_SIGNALS as readonly string[]).includes(s))

export type MailContentStats = {
  /** Zpráv čekajících na ruční přiřazení. */
  queued: number
  /** Zpráv, ze kterých za posledních 30 dní vznikl návrh. */
  proposed30d: number
  /** Kdy Cockpit zprávu naposledy převzal, nebo null. */
  lastAt: string | null
}

export const MAIL_CONTENT_WINDOW_DAYS = 30

/** Počty pro záložku ve frontě, kartu a Nastavení; null = bez migrace 0091. */
export async function getMailContentStats(db?: Db, now: Date = new Date()): Promise<MailContentStats | null> {
  const s = db ?? (await createClient())
  const since = new Date(now.getTime() - MAIL_CONTENT_WINDOW_DAYS * 86_400_000).toISOString()
  const [waiting, proposed, last] = await Promise.all([
    s.from('mail_content_intake').select('id', { count: 'exact', head: true }).eq('status', 'queued').neq('source', CONNECTOR_SOURCE),
    s.from('mail_content_intake').select('id', { count: 'exact', head: true }).eq('status', 'proposed').neq('source', CONNECTOR_SOURCE).gte('created_at', since),
    s.from('mail_content_intake').select('created_at').neq('source', CONNECTOR_SOURCE).order('created_at', { ascending: false }).limit(1),
  ])
  for (const r of [waiting, proposed, last]) {
    if (r.error) {
      if (isMissingRelation(r.error)) return null
      throw new Error(`Načtení pošty k zařazení selhalo: ${r.error.code ?? 'chyba'}`)
    }
  }
  return {
    queued: waiting.count ?? 0,
    proposed30d: proposed.count ?? 0,
    lastAt: (last.data?.[0] as { created_at: string } | undefined)?.created_at ?? null,
  }
}

export type QueuedMail = {
  id: number
  receivedAt: string
  subject: string | null
  excerpt: string
  senderDomain: string | null
  attachmentNames: string[]
  signals: MailSignal[]
  proposedDate: string | null
  waitReason: MailWaitReason
  accountId: number | null
  accountName: string | null
  /** Odkaz na zprávu v Outlooku (evidence), nebo null. */
  webLink: string | null
  /** Dodávky a obchody klienta k výběru (jen když je klient znám). */
  targets: TargetOption[]
  /** Návrh zakázky z PDF nabídky v příloze (waitReason 'offer_draft'), jinak null. */
  offer?: OfferProposalView | null
}

type QueueRaw = {
  id: number
  received_at: string
  subject: string | null
  excerpt: string | null
  sender_domain: string | null
  attachment_names: unknown
  signals: unknown
  proposed_date: string | null
  wait_reason: string | null
  account_id: number | null
  account: Joined<{ name: string | null }>
  evidence: Joined<{ web_link: string | null }>
  offer_proposal_id?: string | null
  offer_draft?: unknown
}

const QUEUE_SELECT =
  'id, received_at, subject, excerpt, sender_domain, attachment_names, signals, proposed_date, wait_reason, account_id, account(name), evidence(web_link)'
// Od migrace 0099 nese řádek navíc návrh zakázky z nabídky v příloze.
const QUEUE_SELECT_OFFER = `${QUEUE_SELECT}, offer_proposal_id, offer_draft`

/** Zprávy čekající na ruční přiřazení, nejstarší první. */
export async function listQueuedMail(limit = 50, db?: Db): Promise<QueuedMail[]> {
  const s = db ?? (await createClient())
  const query = (select: string) =>
    s.from('mail_content_intake').select(select).eq('status', 'queued').neq('source', CONNECTOR_SOURCE).order('created_at', { ascending: true }).limit(limit)
  let { data, error } = await query(QUEUE_SELECT_OFFER)
  // Před migrací 0099 sloupce s návrhem zakázky nejsou: fronta se čte jako dřív.
  if (isMissingColumn(error)) ({ data, error } = await query(QUEUE_SELECT))
  if (error) {
    if (isMissingRelation(error)) return []
    throw new Error(`Načtení pošty k zařazení selhalo: ${error.code ?? 'chyba'}`)
  }
  const rows = (data ?? []) as unknown as QueueRaw[]
  const out: QueuedMail[] = []
  for (const r of rows) {
    if (typeof r.excerpt !== 'string') continue
    let targets: TargetOption[] = []
    if (r.account_id != null) {
      try {
        targets = (await loadMailTargets(s, r.account_id)).options
      } catch (e) {
        logError('mailContent.queue.targets', e instanceof Error ? e.name : 'chyba')
      }
    }
    out.push({
      id: r.id,
      receivedAt: r.received_at,
      subject: r.subject,
      excerpt: r.excerpt,
      senderDomain: r.sender_domain,
      attachmentNames: stringArray(r.attachment_names),
      signals: signalArray(r.signals),
      proposedDate: r.proposed_date,
      waitReason: (MAIL_WAIT_REASONS as readonly string[]).includes(r.wait_reason ?? '') ? (r.wait_reason as MailWaitReason) : 'assign_failed',
      accountId: r.account_id,
      accountName: one(r.account)?.name ?? null,
      webLink: one(r.evidence)?.web_link ?? null,
      targets,
      offer: await offerViewOf(s, r),
    })
  }
  return out
}

/** Návrh zakázky z řádku fronty (jen čekající řádek s návrhem); klient se hledá podle jména z PDF. */
async function offerViewOf(s: Db, r: Pick<QueueRaw, 'offer_proposal_id' | 'offer_draft'>): Promise<OfferProposalView | null> {
  if (typeof r.offer_proposal_id !== 'string' || r.offer_draft == null) return null
  const stored = parseStoredProposal(r.offer_draft, r.offer_proposal_id)
  if (!stored) return null
  let account: OfferProposalView['account'] = { kind: 'unknown' }
  try {
    const found = await findAccountByName(s, stored.fields.account_name)
    if (found.kind !== 'error') account = found
  } catch (e) {
    logError('mailContent.queue.offerAccount', e instanceof Error ? e.name : 'chyba')
  }
  return {
    proposalId: stored.proposal_id,
    fileName: stored.file_name,
    fields: { ...stored.fields, pillar: (stored.fields.pillar as OfferProposalView['fields']['pillar']) ?? null },
    warnings: stored.warnings,
    flags: stored.injection_flags,
    account,
  }
}

export type MailProposalEvidence = {
  excerpt: string | null
  subject: string | null
  signals: MailSignal[]
  attachmentNames: string[]
}

/**
 * Úryvky ze zpráv, ze kterých vznikly dané návrhy (jen obchodní role: RLS
 * ostatním nevrátí nic, návrh se u nich zobrazí bez citace). Nevyhazuje.
 */
export async function getMailProposalEvidence(proposalIds: readonly number[], db?: Db): Promise<Map<number, MailProposalEvidence>> {
  const out = new Map<number, MailProposalEvidence>()
  if (proposalIds.length === 0) return out
  try {
    const s = db ?? (await createClient())
    const { data, error } = await s
      .from('mail_content_intake')
      .select('proposal_id, subject, excerpt, signals, attachment_names')
      .in('proposal_id', [...proposalIds])
    if (error) {
      if (!isMissingRelation(error)) logError('mailContent.evidence', error)
      return out
    }
    for (const r of (data ?? []) as { proposal_id: number | null; subject: string | null; excerpt: string | null; signals: unknown; attachment_names: unknown }[]) {
      if (r.proposal_id == null || (r.excerpt == null && r.subject == null)) continue
      out.set(r.proposal_id, {
        excerpt: r.excerpt,
        subject: r.subject,
        signals: signalArray(r.signals),
        attachmentNames: stringArray(r.attachment_names),
      })
    }
  } catch (e) {
    logError('mailContent.evidence', e instanceof Error ? e.name : 'chyba')
  }
  return out
}

// ---------------------------------------------------------------------------
// Karta na obrazovce Dnes

export type MailContentCardItem = {
  id: number
  subject: string | null
  senderDomain: string | null
  accountName: string | null
  waitReason: MailWaitReason
  receivedAt: string
  /** Návrh zakázky z nabídky v příloze: klient a cena z PDF (k potvrzení). */
  offer?: { clientName: string; amount: number | null; currency: 'CZK' | 'EUR'; title: string } | null
}

export type MailContentCard =
  | { state: 'ok'; queued: number; items: MailContentCardItem[]; pendingProposals: number }
  | { state: 'missing_migration' }
  | { state: 'error' }

function cardOffer(r: { offer_proposal_id?: string | null; offer_draft?: unknown }): MailContentCardItem['offer'] {
  if (typeof r.offer_proposal_id !== 'string' || r.offer_draft == null) return null
  const stored = parseStoredProposal(r.offer_draft, r.offer_proposal_id)
  if (!stored) return null
  const f = stored.fields
  return { clientName: f.account_name, amount: f.amount_one_time, currency: f.currency, title: f.title }
}

/** Počet čekajících zpráv, tři nejstarší a počet čekajících návrhů z pošty. Nevyhazuje. */
export async function getMailContentCard(db?: Db): Promise<MailContentCard> {
  try {
    const s = db ?? (await createClient())
    const listQuery = (select: string) =>
      s.from('mail_content_intake').select(select).eq('status', 'queued').neq('source', CONNECTOR_SOURCE).order('created_at', { ascending: true }).limit(3)
    const CARD_SELECT = 'id, subject, sender_domain, wait_reason, received_at, account(name)'
    const [waiting, listWithOffer, pending] = await Promise.all([
      s.from('mail_content_intake').select('id', { count: 'exact', head: true }).eq('status', 'queued').neq('source', CONNECTOR_SOURCE),
      listQuery(`${CARD_SELECT}, offer_proposal_id, offer_draft`),
      s.from('case_proposal').select('id', { count: 'exact', head: true }).like('capability', 'mail_content_%').eq('status', 'pending'),
    ])
    // Před migrací 0099 sloupce s návrhem zakázky nejsou: karta se čte jako dřív.
    const list = isMissingColumn(listWithOffer.error) ? await listQuery(CARD_SELECT) : listWithOffer
    if (isMissingRelation(waiting.error) || isMissingRelation(list.error)) return { state: 'missing_migration' }
    if (waiting.error) throw waiting.error
    if (list.error) throw list.error
    type Raw = {
      id: number; subject: string | null; sender_domain: string | null; wait_reason: string | null; received_at: string
      account: Joined<{ name: string | null }>; offer_proposal_id?: string | null; offer_draft?: unknown
    }
    return {
      state: 'ok',
      queued: waiting.count ?? 0,
      items: ((list.data ?? []) as unknown as Raw[]).map((r) => ({
        id: r.id,
        subject: r.subject,
        senderDomain: r.sender_domain,
        accountName: one(r.account)?.name ?? null,
        waitReason: (MAIL_WAIT_REASONS as readonly string[]).includes(r.wait_reason ?? '') ? (r.wait_reason as MailWaitReason) : 'assign_failed',
        receivedAt: r.received_at,
        offer: cardOffer(r),
      })),
      // Návrhy jsou od 0067; bez nich se jen nepočítají.
      pendingProposals: pending.error ? 0 : (pending.count ?? 0),
    }
  } catch (e) {
    logError('mailContent.card', e instanceof Error ? e.name : 'chyba')
    return { state: 'error' }
  }
}
