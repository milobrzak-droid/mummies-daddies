import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/admin'
import { createAuditedAdminClient } from '@/core/auditDb'
import { recordAudit } from '@/core/audit'
import { recordEvidence } from '@/core/evidence'
import type { EvidenceKind } from '@/core/informationState'
import { isMissingColumn, isMissingRelation } from '@/core/loopQueries'
import { detectInjectionMarkers, injectionAuditMeta, type InjectionFlag } from '@/core/untrusted'
import { dbErrorMessage } from '@/lib/actionResult'
import { logError, logWarn } from '@/lib/log'
import { pragueToday } from '@/lib/pragueDate'
import { normalizeDealStage } from '@/lib/dealStageLegacy'
import { defaultProbabilityForStage, isPillar, phasesFor } from '@/lib/domain'
import { categoryForLine, dealCurrency, isRealDay, revenueLine } from '@/lib/validation/schemas'
import { DEFAULT_IMPORT_REVENUE_LINE, fold, matchClient, type AccountIndex } from '@/domain/crm/bulkImport'
import { loadAccountIndex } from '@/domain/crm/bulkImportService'
import { canonicalIco } from '@/domain/crm/meetingIntake'
import { similarAccounts, type AccountCandidate } from '@/domain/crm/apiAccountMatch'
import { findDuplicateContact } from '@/domain/crm/apiContacts'
import { FX_FAILED, amountColumns, applyDealChanges, type UpdateDealInput } from '@/domain/crm/apiDeals'
import { SALES_ONLY_ERROR, type WriteResult } from '@/domain/crm/apiWrite'
import { mailOfferPath } from '@/domain/crm/offerProposal'
import { resolveNewOfferAccount } from '@/domain/crm/offerAccount'
import {
  CONNECTOR_SOURCE, COVERAGE_MAX, COVERAGE_STATUS_LABEL, PROPOSAL_DRAFT_MAX_BYTES, PROPOSAL_STAGES, PROPOSAL_STATUS_LABEL,
  PROPOSAL_TEXT_LIMITS, PROPOSALS_PENDING_MESSAGE, PROPOSE_BATCH_MAX, PROPOSE_UPDATE_FIELDS,
  batchLabel, classifyAgainstDeals, contactEmailField, contactPhoneField, coverageItemInput, dealStageForProposal,
  firstProposalIssue, injectionWarnings, isAllowedSourceLink, parseConnectorDraft, proposalStatusOf, proposeDealInput,
  proposeDealUpdateInput, rangeMidpoint, similarDeals,
  type ConnectorDraft, type CoverageDiff, type CoverageStatus, type DealLike, type DuplicateHit, type ProposalStage,
  type ProposalStatus, type ProposalWarning, type ProposeDealInput, type ProposeDealUpdateInput, type SourceKind,
} from '@/domain/crm/connectorProposals'

// Fronta návrhů zakázek z konektoru (proč tahle tabulka a ne jiná:
// domain/crm/connectorProposals.ts). Tady je I/O:
//   * propose — návrh do mail_content_intake (status queued, wait_reason
//     offer_draft, source mcp_connector). NIKDY nezakládá obchod, kontakt ani
//     klienta; jediný další zápis je odkaz na zdroj (evidence) s id ve jmenném
//     prostoru návrhu (`mcp-proposal:<uuid>`), takže podvržené Message-ID ani
//     odkaz od modelu neotráví sdílený doklad skutečné zprávy (core/evidence.ts).
//   * coverage — jen čtení (check_deals_coverage),
//   * list — stav návrhů vlastníka klíče (get_proposals),
//   * approve / reject — volá je server akce po přihlášení s 2FA a ověření role
//     vedení/admin (domain/crm/actions/connectorProposals.ts); teprve tady
//     vzniká obchod (+ kontakt, aktivita, audit human_confirmed s dokladem).

type Admin = ReturnType<typeof createAdminClient>
type Db = Pick<Admin, 'from'>

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex')

/** Otisk zdroje (Message-ID) — hledání „stejný zdroj" napříč klienty. Sloupec offer_pdf_sha256 (0099). */
export function sourceFingerprint(messageId: string): string {
  return sha256(`mcp-source|${messageId.trim()}`)
}

/** Klíč idempotence: stejná zpráva + stejný klient (+ druh návrhu) = jeden návrh. */
export function proposalDedupeKey(parts: { mode: 'create' | 'update'; messageId: string | null; accountKey: string; uuid: string }): string {
  const base = parts.messageId ? `mcp|${parts.mode}|${parts.messageId.trim()}|${parts.accountKey}` : `mcp|${parts.mode}|uuid|${parts.uuid}`
  return `sha256:${sha256(base)}`
}

const EVIDENCE_KIND: Record<SourceKind, EvidenceKind> = { email: 'email_message', pdf: 'file', transcript: 'meeting', other: 'url' }

function isQueueMissing(err: { code?: string | null; message?: string | null } | null | undefined): boolean {
  return isMissingRelation(err) || isMissingColumn(err) || err?.code === 'PGRST204'
}

function failed(error: string, status = 400): WriteResult<never> {
  return { ok: false, status, error }
}

const clip = (s: string | null | undefined, max: number): string | null => {
  const v = (s ?? '').trim()
  return v ? v.slice(0, max) : null
}

function toIsoOrNow(date: string | null | undefined): string {
  if (date) {
    const iso = /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T12:00:00Z` : date
    const t = Date.parse(iso)
    if (Number.isFinite(t)) return new Date(t).toISOString()
  }
  return new Date().toISOString()
}

function emailDomain(...candidates: (string | null | undefined)[]): string | null {
  for (const c of candidates) {
    const m = /@([a-z0-9.-]+\.[a-z]{2,})\b/i.exec(c ?? '')
    if (m) return m[1].toLowerCase().slice(0, 253)
  }
  return null
}

async function ownerName(admin: Db, createdBy: string | null): Promise<string | null> {
  if (!createdBy) return null
  const { data } = await admin.from('team_member').select('full_name').eq('id', createdBy).maybeSingle()
  return (data as { full_name?: string | null } | null)?.full_name ?? null
}

// ---------------------------------------------------------------------------
// Klient návrhu: nikdy nehádat

type AccountPick = ConnectorDraft['account'] & { owner_id?: string | null }

async function pickAccount(admin: Db, input: { account_id?: number; account_name?: string; account_ico?: string }, index: () => Promise<AccountIndex>): Promise<AccountPick | { error: string }> {
  if (input.account_id != null) {
    const { data, error } = await admin.from('account').select('id, name, ico, owner_id').eq('id', input.account_id).maybeSingle()
    if (error) throw error
    if (!data) return { error: 'Klient s tímto account_id v Cockpitu není. Pošli account_name (a IČO), Cockpit nabídne kandidáty.' }
    const a = data as { id: number; name: string; ico: string | null; owner_id: string | null }
    return { id: a.id, name: a.name, ico: a.ico, status: 'matched', matched_by: 'id', candidates: [], owner_id: a.owner_id }
  }
  const name = (input.account_name ?? '').trim()
  let ico: string | null = null
  if (input.account_ico?.trim()) {
    ico = canonicalIco(input.account_ico.trim())
    if (!ico) return { error: 'account_ico není platné IČO (8 číslic).' }
  }
  const idx = await index()
  const m = matchClient({ name, ico }, idx)
  if (m.kind === 'matched') {
    const { data } = await admin.from('account').select('owner_id').eq('id', m.accountId).maybeSingle()
    return {
      id: m.accountId, name: m.name, ico, status: 'matched', matched_by: m.by, candidates: [],
      owner_id: (data as { owner_id?: string | null } | null)?.owner_id ?? null,
    }
  }
  const candidates: AccountCandidate[] = m.kind === 'ambiguous'
    ? m.candidates.slice(0, 10).map((c) => ({ id: c.id, name: c.name }))
    : similarAccounts(name, idx.accounts)
  return { id: null, name: name.slice(0, 300), ico, status: m.kind === 'ambiguous' ? 'ambiguous' : 'not_found', matched_by: null, candidates }
}

type DealRow = DealLike & { account_id: number }
const DEAL_COLUMNS = 'id, account_id, title, stage, currency, amount_one_time, amount_one_time_original'

async function dealsOfAccounts(admin: Db, ids: readonly number[]): Promise<DealRow[]> {
  if (ids.length === 0) return []
  const { data, error } = await admin.from('deal').select(DEAL_COLUMNS).in('account_id', [...ids])
  if (error) throw error
  return ((data ?? []) as DealRow[]).map((d) => ({
    ...d,
    amount_one_time: d.amount_one_time == null ? null : Number(d.amount_one_time),
    amount_one_time_original: d.amount_one_time_original == null ? null : Number(d.amount_one_time_original),
  }))
}

type QueueRow = {
  id: number
  status: string
  account_id: number | null
  deal_id: number | null
  offer_proposal_id: string | null
  offer_pdf_sha256?: string | null
  created_by?: string | null
}

// ---------------------------------------------------------------------------
// propose_deal / propose_deals

export type ProposeItemResult =
  | {
    index: number
    ok: true
    created: boolean
    proposal_id: number
    status: ProposalStatus
    deal_id: number | null
    account: { id: number | null; name: string; status: ConnectorDraft['account']['status']; candidates: AccountCandidate[] }
    warnings: ProposalWarning[]
    duplicates: DuplicateHit[]
    injection_flags: InjectionFlag[]
  }
  | { index: number; ok: false; error: string }

export type ProposeBatchResult = WriteResult<{ batch: { id: string; label: string } | null; results: ProposeItemResult[] }>

type ProposeCtx = { createdBy: string | null; canSeeSales: boolean }

async function findByDedupe(admin: Db, key: string): Promise<QueueRow | null> {
  const { data, error } = await admin.from('mail_content_intake')
    .select('id, status, account_id, deal_id, offer_proposal_id').eq('dedupe_key', key).maybeSingle()
  if (error) throw error
  return (data as QueueRow | null) ?? null
}

class QueueMissing extends Error {}

export async function proposeDeals(
  rawItems: unknown,
  ctx: ProposeCtx,
  opts: { batch: boolean; batchLabel?: string | null; defaultStage: ProposalStage },
): Promise<ProposeBatchResult> {
  if (!ctx.canSeeSales) return failed(SALES_ONLY_ERROR, 403)
  if (!Array.isArray(rawItems) || rawItems.length === 0) return failed('Pošli aspoň jednu položku (items).')
  if (rawItems.length > PROPOSE_BATCH_MAX) return failed(`Naráz nejvýš ${PROPOSE_BATCH_MAX} položek — rozděl je do víc volání.`)

  const admin = createAdminClient()
  let idx: AccountIndex | null = null
  const index = async () => (idx ??= await loadAccountIndex(admin))
  const parsed = rawItems.map((raw) => proposeDealInput.safeParse(raw))
  const valid = parsed.filter((p) => p.success).map((p) => p.data as ProposeDealInput)
  const label = opts.batch
    ? (clip(opts.batchLabel, PROPOSAL_TEXT_LIMITS.batchLabel) ?? batchLabel(valid.map((v) => v.source.date), valid.length))
    : null
  const batch = opts.batch ? { id: randomUUID(), label: label as string } : null
  const name = await ownerName(admin, ctx.createdBy)

  const results: ProposeItemResult[] = []
  try {
    for (let i = 0; i < parsed.length; i++) {
      const p = parsed[i]
      if (!p.success) {
        results.push({ index: i, ok: false, error: firstProposalIssue(p.error) })
        continue
      }
      results.push(await proposeOne(admin, p.data, i, ctx, { batch, defaultStage: opts.defaultStage, ownerName: name, index }))
    }
  } catch (e) {
    if (e instanceof QueueMissing) return failed(PROPOSALS_PENDING_MESSAGE, 503)
    throw e
  }
  return { ok: true, data: { batch: results.some((r) => r.ok && r.created) ? batch : null, results } }
}

async function proposeOne(
  admin: Admin,
  input: ProposeDealInput,
  i: number,
  ctx: ProposeCtx,
  o: { batch: { id: string; label: string } | null; defaultStage: ProposalStage; ownerName: string | null; index: () => Promise<AccountIndex> },
): Promise<ProposeItemResult> {
  const account = await pickAccount(admin, input, o.index)
  if ('error' in account) return { index: i, ok: false, error: account.error }

  const uuid = randomUUID()
  const messageId = input.source.message_id?.trim() || null
  const accountKey = account.id != null ? `id:${account.id}` : `name:${fold(account.name)}`
  const dedupeKey = proposalDedupeKey({ mode: 'create', messageId, accountKey, uuid })
  const existing = await findByDedupe(admin, dedupeKey).catch((e) => {
    if (isQueueMissing(e)) throw new QueueMissing()
    throw e
  })
  if (existing) return existingResult(i, existing, account)

  const warnings = new Set<ProposalWarning>()
  if (account.status === 'ambiguous') warnings.add('client_ambiguous')
  if (account.status === 'not_found') warnings.add('client_not_found')

  // Stejný zdroj (Message-ID) už vedl k obchodu nebo návrhu (třeba u jiného klienta).
  const duplicates: DuplicateHit[] = []
  const fp = messageId ? sourceFingerprint(messageId) : null
  if (fp) {
    const { data, error } = await admin.from('mail_content_intake')
      .select('id, status, deal_id').eq('source', CONNECTOR_SOURCE).eq('offer_pdf_sha256', fp)
    if (error && isQueueMissing(error)) throw new QueueMissing()
    const same = (data ?? []) as { id: number; status: string; deal_id: number | null }[]
    if (same.some((r) => r.status === 'queued' || r.deal_id != null)) warnings.add('duplicate_source')
    const ids = same.flatMap((r) => (r.deal_id != null ? [r.deal_id] : []))
    if (ids.length > 0) {
      const { data: deals } = await admin.from('deal').select('id, title, stage, amount_one_time').in('id', ids)
      for (const d of (deals ?? []) as { id: number; title: string; stage: string; amount_one_time: number | null }[]) {
        duplicates.push({ deal_id: d.id, title: d.title.slice(0, 300), stage: d.stage, amount_czk: d.amount_one_time == null ? null : Number(d.amount_one_time), reason: 'same_source' })
      }
    }
  }

  let amount = input.amount ?? null
  let range: { min: number; max: number } | null = null
  if (input.amount_min != null && input.amount_max != null) {
    range = { min: input.amount_min, max: input.amount_max }
    amount = rangeMidpoint(input.amount_min, input.amount_max)
    warnings.add('price_estimate')
  }
  if (amount == null) warnings.add('price_missing')
  const currency = input.currency ?? 'CZK'
  if (currency === 'EUR') warnings.add('eur')

  if (account.id != null) {
    const deals = await dealsOfAccounts(admin, [account.id])
    for (const hit of similarDeals(input.title, deals, amount, currency)) {
      if (!duplicates.some((d) => d.deal_id === hit.deal_id)) duplicates.push(hit)
    }
  }
  if (duplicates.some((d) => d.reason !== 'same_source')) warnings.add('duplicate_deal')

  let webLink: string | null = null
  if (input.source.web_link) {
    if (isAllowedSourceLink(input.source.web_link)) webLink = input.source.web_link
    else warnings.add('link_dropped')
  }

  const flags = detectInjectionMarkers([
    input.title, input.note, input.next_step, input.account_name, input.contact?.full_name, input.contact?.role,
    input.source.subject, input.source.sender, input.source.label,
  ].filter(Boolean).join('\n'))
  for (const w of injectionWarnings(flags)) warnings.add(w)
  if (flags.length > 0) logWarn('connector.proposal', 'návrh z konektoru nese příznaky možných pokynů pro AI', { flags })

  const draft: ConnectorDraft = {
    version: 1,
    kind: 'connector_deal',
    info_state: 'ai_suggestion',
    mode: 'create',
    proposed_by: ctx.createdBy,
    proposed_by_name: clip(o.ownerName, 200),
    proposed_at: new Date().toISOString(),
    batch: o.batch,
    account: { id: account.id, name: account.name, ico: account.ico, status: account.status, matched_by: account.matched_by, candidates: account.candidates },
    deal_id: null,
    fields: {
      title: input.title,
      stage: input.stage ?? o.defaultStage,
      amount,
      amount_range: range,
      currency,
      cogs: input.cogs ?? null,
      estimate_md: input.estimate_md ?? null,
      pillar: input.pillar ?? null,
      phase: input.phase ?? null,
      revenue_line: input.revenue_line ?? null,
      expected_close: input.expected_close ?? null,
      next_step: input.next_step ?? null,
      next_step_due: input.next_step_due ?? null,
      note: input.note ?? null,
    },
    changes: null,
    reason: null,
    contact: input.contact
      ? { full_name: input.contact.full_name, email: input.contact.email ?? null, phone: input.contact.phone ?? null, role: input.contact.role ?? null }
      : null,
    source: sourceOf(input.source, webLink),
    duplicates: duplicates.slice(0, 10),
    warnings: [...warnings],
    injection_flags: flags,
  }
  const row = await insertProposal(admin, draft, {
    uuid, dedupeKey, fp, ctx, accountId: account.id, dealId: null,
    subject: input.source.subject ?? input.title,
    excerpt: `Návrh zakázky od Claude${o.ownerName ? ` (jménem ${o.ownerName})` : ''}: ${input.title}`,
    contactEmail: input.contact?.email ?? null,
  })
  if ('existing' in row) return existingResult(i, row.existing, account)
  if ('error' in row) return { index: i, ok: false, error: row.error }
  return {
    index: i, ok: true, created: true, proposal_id: row.id, status: 'pending', deal_id: null,
    account: { id: account.id, name: account.name, status: account.status, candidates: account.candidates },
    warnings: draft.warnings, duplicates: draft.duplicates, injection_flags: flags,
  }
}

function sourceOf(s: ProposeDealInput['source'], webLink: string | null): ConnectorDraft['source'] {
  return {
    kind: s.kind,
    message_id: s.message_id?.trim() || null,
    web_link: webLink,
    subject: s.subject ?? null,
    sender: s.sender ?? null,
    recipient: s.recipient ?? null,
    date: s.date ?? null,
    label: s.label ?? null,
  }
}

function existingResult(i: number, row: QueueRow, account: Pick<AccountPick, 'id' | 'name' | 'status' | 'candidates'>): ProposeItemResult {
  return {
    index: i, ok: true, created: false, proposal_id: row.id, status: proposalStatusOf(row.status), deal_id: row.deal_id,
    account: { id: row.account_id ?? account.id, name: account.name, status: account.status, candidates: account.candidates },
    warnings: [], duplicates: [], injection_flags: [],
  }
}

/** Zkrátí poznámku tak, aby se návrh vešel do 16 kB (CHECK z 0099). */
function fitDraft(draft: ConnectorDraft): ConnectorDraft {
  let d = draft
  while (Buffer.byteLength(JSON.stringify(d), 'utf8') > PROPOSAL_DRAFT_MAX_BYTES - 512) {
    const note = d.fields.note
    if (note && note.length > 200) d = { ...d, fields: { ...d.fields, note: `${note.slice(0, Math.floor(note.length / 2))}…` } }
    else if (d.duplicates.length > 0) d = { ...d, duplicates: d.duplicates.slice(0, -1) }
    else if (d.account.candidates.length > 0) d = { ...d, account: { ...d.account, candidates: d.account.candidates.slice(0, -1) } }
    else break
  }
  return d
}

async function insertProposal(
  admin: Admin,
  rawDraft: ConnectorDraft,
  o: {
    uuid: string; dedupeKey: string; fp: string | null; ctx: ProposeCtx; accountId: number | null; dealId: number | null
    subject: string; excerpt: string; contactEmail: string | null
  },
): Promise<{ id: number } | { existing: QueueRow } | { error: string }> {
  const draft = fitDraft(rawDraft)
  // Doklad: id ve jmenném prostoru návrhu, odkaz jen z allow-listu (sourceOf).
  const evidence = await recordEvidence(admin, {
    kind: EVIDENCE_KIND[draft.source.kind],
    sourceId: `mcp-proposal:${o.uuid}`,
    webLink: draft.source.web_link,
  }, o.ctx.createdBy ? `api_key:${o.ctx.createdBy}` : 'api_key')
  if (!evidence.ok) {
    if (evidence.reason === 'db_error' && /does not exist|could not find/i.test(evidence.message)) throw new QueueMissing()
    return { error: 'Návrh se nepodařilo uložit (doklad zdroje). Zkus to prosím znovu.' }
  }
  const audited = createAuditedAdminClient({ actor: { type: 'api_key', id: o.ctx.createdBy } })
  const { data, error } = await audited.from('mail_content_intake').insert({
    source: CONNECTOR_SOURCE,
    status: 'queued',
    wait_reason: 'offer_draft',
    dedupe_key: o.dedupeKey,
    evidence_id: evidence.id,
    received_at: toIsoOrNow(draft.source.date),
    sender_domain: emailDomain(o.contactEmail, draft.source.recipient, draft.source.sender),
    subject: clip(o.subject, 200),
    excerpt: clip(o.excerpt, 300) ?? 'Návrh zakázky z konektoru',
    attachment_names: draft.source.kind === 'pdf' && draft.source.label ? [draft.source.label.slice(0, 200)] : [],
    signals: [],
    account_id: o.accountId,
    deal_id: o.dealId,
    created_by: o.ctx.createdBy,
    offer_proposal_id: o.uuid,
    offer_draft: draft,
    offer_pdf_sha256: o.fp,
  }).select('id').single()
  if (error) {
    if (error.code === '23505') {
      const existing = await findByDedupe(admin, o.dedupeKey)
      if (existing) return { existing }
    }
    if (isQueueMissing(error)) throw new QueueMissing()
    logError('connector.proposal.insert', error)
    return { error: 'Návrh se nepodařilo uložit. Zkus to prosím znovu.' }
  }
  return { id: (data as { id: number }).id }
}

// ---------------------------------------------------------------------------
// propose_deal_update

export async function proposeDealUpdate(raw: unknown, ctx: ProposeCtx): Promise<WriteResult<Extract<ProposeItemResult, { ok: true }>>> {
  if (!ctx.canSeeSales) return failed(SALES_ONLY_ERROR, 403)
  const parsed = proposeDealUpdateInput.safeParse(raw)
  if (!parsed.success) return failed(firstProposalIssue(parsed.error))
  const input: ProposeDealUpdateInput = parsed.data
  const admin = createAdminClient()
  const { data: found, error } = await admin.from('deal').select(`${DEAL_COLUMNS}, next_step, next_step_due, expected_close, cogs_one_time, estimate_md`)
    .eq('id', input.deal_id).maybeSingle()
  if (error) return failed(dbErrorMessage('connector.proposal.update', error), 500)
  if (!found) return failed('Obchod nenalezen.', 404)
  const deal = found as DealRow
  const { data: acc } = await admin.from('account').select('id, name, ico').eq('id', deal.account_id).maybeSingle()
  const account = (acc as { id: number; name: string; ico: string | null } | null) ?? { id: deal.account_id, name: `klient ${deal.account_id}`, ico: null }

  if (input.pillar !== undefined || input.phase !== undefined) {
    const pillar = input.pillar ?? null
    if (input.phase && (!pillar || !isPillar(pillar) || !phasesFor(pillar).some((p) => p.key === input.phase))) {
      return failed('Fáze (phase) musí patřit k pilíři (pillar) a jde jen spolu s ním.')
    }
  }

  const changes: Record<string, string | number | null> = {}
  for (const k of PROPOSE_UPDATE_FIELDS) if (input[k] !== undefined) changes[k] = input[k] as string | number
  const uuid = randomUUID()
  const messageId = input.source.message_id?.trim() || null
  const dedupeKey = proposalDedupeKey({ mode: 'update', messageId, accountKey: `deal:${deal.id}`, uuid })
  const flags = detectInjectionMarkers([input.note, input.next_step, input.lost_reason, input.reason, input.source.subject].filter(Boolean).join('\n'))
  const warnings = new Set<ProposalWarning>(injectionWarnings(flags))
  let webLink: string | null = null
  if (input.source.web_link) {
    if (isAllowedSourceLink(input.source.web_link)) webLink = input.source.web_link
    else warnings.add('link_dropped')
  }
  const name = await ownerName(admin, ctx.createdBy)
  const draft: ConnectorDraft = {
    version: 1, kind: 'connector_deal', info_state: 'ai_suggestion', mode: 'update',
    proposed_by: ctx.createdBy, proposed_by_name: clip(name, 200), proposed_at: new Date().toISOString(), batch: null,
    account: { id: account.id, name: account.name, ico: account.ico, status: 'matched', matched_by: 'id', candidates: [] },
    deal_id: deal.id,
    fields: {
      title: deal.title.slice(0, PROPOSAL_TEXT_LIMITS.title), stage: null, amount: null, amount_range: null,
      currency: deal.currency === 'EUR' ? 'EUR' : 'CZK', cogs: null, estimate_md: null, pillar: null, phase: null, revenue_line: null,
      expected_close: null, next_step: null, next_step_due: null, note: null,
    },
    changes,
    reason: input.reason ?? null,
    contact: null,
    source: sourceOf(input.source, webLink),
    duplicates: [],
    warnings: [...warnings],
    injection_flags: flags,
  }
  try {
    const existing = await findByDedupe(admin, dedupeKey).catch((e) => {
      if (isQueueMissing(e)) throw new QueueMissing()
      throw e
    })
    const pick = { id: account.id, name: account.name, status: 'matched' as const, candidates: [] }
    if (existing) return { ok: true, data: existingResult(0, existing, pick) as Extract<ProposeItemResult, { ok: true }> }
    const row = await insertProposal(admin, draft, {
      uuid, dedupeKey, fp: messageId ? sourceFingerprint(messageId) : null, ctx, accountId: account.id, dealId: deal.id,
      subject: input.source.subject ?? `Změna obchodu: ${deal.title}`,
      excerpt: `Návrh změny obchodu od Claude${name ? ` (jménem ${name})` : ''}: ${deal.title} (${Object.keys(changes).join(', ')})`,
      contactEmail: null,
    })
    if ('existing' in row) return { ok: true, data: existingResult(0, row.existing, pick) as Extract<ProposeItemResult, { ok: true }> }
    if ('error' in row) return failed(row.error, 500)
    return {
      ok: true,
      data: {
        index: 0, ok: true, created: true, proposal_id: row.id, status: 'pending', deal_id: deal.id,
        account: pick, warnings: draft.warnings, duplicates: [], injection_flags: flags,
      },
    }
  } catch (e) {
    if (e instanceof QueueMissing) return failed(PROPOSALS_PENDING_MESSAGE, 503)
    throw e
  }
}

// ---------------------------------------------------------------------------
// check_deals_coverage (jen čtení)

export type CoverageResult = {
  index: number
  ref: string | null
  status: CoverageStatus | 'invalid'
  status_label: string
  account: { id: number | null; name: string; status: ConnectorDraft['account']['status']; candidates: AccountCandidate[] } | null
  deal: { id: number; title: string; stage: string; amount_czk: number | null } | null
  candidates: { id: number; title: string; stage: string; amount_czk: number | null }[]
  diff: CoverageDiff
  proposal_id: number | null
  error?: string
}

const dealView = (d: DealLike) => ({ id: d.id, title: d.title, stage: d.stage, amount_czk: d.amount_one_time })

export async function checkDealsCoverage(rawItems: unknown, canSeeSales: boolean): Promise<WriteResult<{ items: CoverageResult[]; summary: Record<CoverageStatus, number> }>> {
  if (!canSeeSales) return failed(SALES_ONLY_ERROR, 403)
  if (!Array.isArray(rawItems) || rawItems.length === 0) return failed('Pošli aspoň jednu položku (items).')
  if (rawItems.length > COVERAGE_MAX) return failed(`Naráz nejvýš ${COVERAGE_MAX} položek.`)
  const admin = createAdminClient()
  let idx: AccountIndex | null = null
  const index = async () => (idx ??= await loadAccountIndex(admin))

  const parsed = rawItems.map((r) => coverageItemInput.safeParse(r))
  const picks: (AccountPick | { error: string } | null)[] = []
  for (const p of parsed) picks.push(p.success ? await pickAccount(admin, p.data, index) : null)

  const accountIds = [...new Set(picks.flatMap((a) => (a && !('error' in a) && a.id != null ? [a.id] : [])))]
  const deals = await dealsOfAccounts(admin, accountIds)

  // Zdroj už navržený/založený: otisky Message-ID ve frontě konektoru.
  const fps = parsed.flatMap((p) => (p.success && p.data.message_id ? [sourceFingerprint(p.data.message_id)] : []))
  let sourceRows: (QueueRow & { offer_pdf_sha256: string | null })[] = []
  if (fps.length > 0) {
    const { data, error } = await admin.from('mail_content_intake')
      .select('id, status, account_id, deal_id, offer_proposal_id, offer_pdf_sha256').eq('source', CONNECTOR_SOURCE).in('offer_pdf_sha256', fps)
    if (error && !isQueueMissing(error)) throw error
    sourceRows = (data ?? []) as typeof sourceRows
  }

  const summary: Record<CoverageStatus, number> = { in_cockpit: 0, probably_in_cockpit: 0, already_proposed: 0, missing: 0 }
  const items: CoverageResult[] = parsed.map((p, i) => {
    const base = { index: i, ref: null, account: null, deal: null, candidates: [], diff: {}, proposal_id: null }
    if (!p.success) return { ...base, status: 'invalid' as const, status_label: 'neplatná položka', error: firstProposalIssue(p.error) }
    const item = p.data
    const a = picks[i]
    const ref = item.ref ?? null
    if (!a || 'error' in a) {
      return { ...base, ref, status: 'invalid' as const, status_label: 'neplatná položka', error: a && 'error' in a ? a.error : 'Neplatná položka.' }
    }
    const account = { id: a.id, name: a.name, status: a.status, candidates: a.candidates }
    const done = (status: CoverageStatus, extra: Partial<CoverageResult> = {}): CoverageResult => {
      summary[status]++
      return { ...base, ref, account, status, status_label: COVERAGE_STATUS_LABEL[status], ...extra }
    }
    const accountDeals = a.id != null ? deals.filter((d) => d.account_id === a.id) : []
    if (item.message_id) {
      const fp = sourceFingerprint(item.message_id)
      const rows = sourceRows.filter((r) => r.offer_pdf_sha256 === fp && (a.id == null || r.account_id == null || r.account_id === a.id))
      const withDeal = rows.find((r) => r.deal_id != null)
      const dealHit = withDeal ? accountDeals.find((d) => d.id === withDeal.deal_id) ?? null : null
      if (withDeal && dealHit) return done('in_cockpit', { deal: dealView(dealHit), proposal_id: withDeal.id })
      const pending = rows.find((r) => r.status === 'queued')
      if (pending) return done('already_proposed', { proposal_id: pending.id })
    }
    if (a.id == null) return done('missing')
    const c = classifyAgainstDeals({ title: item.title, amount: item.amount ?? null, currency: item.currency ?? 'CZK' }, accountDeals)
    if (c.status === 'in_cockpit' && c.deal) return done('in_cockpit', { deal: dealView(c.deal), diff: c.diff })
    if (c.status === 'probably_in_cockpit') return done('probably_in_cockpit', { candidates: c.candidates.map(dealView) })
    return done('missing')
  })
  return { ok: true, data: { items, summary } }
}

// ---------------------------------------------------------------------------
// get_proposals

export type ProposalListItem = {
  proposal_id: number
  status: ProposalStatus
  status_label: string
  mode: 'create' | 'update' | null
  title: string | null
  account_id: number | null
  deal_id: number | null
  batch: string | null
  created_at: string
  decided_at: string | null
  reason: string | null
  link: string
}

export async function listProposalsForOwner(
  createdBy: string | null,
  opts: { status?: ProposalStatus; limit?: number; offset?: number; baseUrl: string },
): Promise<WriteResult<{ items: ProposalListItem[]; next_offset: number | null; reason_unavailable?: true }>> {
  if (!createdBy) return { ok: true, data: { items: [], next_offset: null } }
  const admin = createAdminClient()
  const limit = Math.min(Math.max(opts.limit ?? 25, 1), 100)
  const offset = Math.max(opts.offset ?? 0, 0)
  const DB_STATUS: Record<ProposalStatus, string> = { pending: 'queued', approved: 'proposed', rejected: 'discarded', expired: 'expired' }
  const run = (cols: string) => {
    let q = admin.from('mail_content_intake').select(cols).eq('source', CONNECTOR_SOURCE).eq('created_by', createdBy)
    if (opts.status) q = q.eq('status', DB_STATUS[opts.status])
    return q.order('created_at', { ascending: false }).range(offset, offset + limit)
  }
  const BASE = 'id, status, offer_draft, account_id, deal_id, created_at, decided_at'
  let reasonUnavailable = false
  let { data, error } = await run(`${BASE}, decision_note`)
  if (isMissingColumn(error)) {
    reasonUnavailable = true;
    ({ data, error } = await run(BASE))
  }
  if (error) {
    if (isQueueMissing(error)) return failed(PROPOSALS_PENDING_MESSAGE, 503)
    return failed(dbErrorMessage('connector.proposals.list', error), 500)
  }
  type Raw = { id: number; status: string; offer_draft: unknown; account_id: number | null; deal_id: number | null; created_at: string; decided_at: string | null; decision_note?: string | null }
  const rows = (data ?? []) as unknown as Raw[]
  const page = rows.slice(0, limit)
  const dealIds = [...new Set(page.flatMap((r) => (r.deal_id != null ? [r.deal_id] : [])))]
  const titles = new Map<number, string>()
  if (dealIds.length > 0) {
    const { data: deals } = await admin.from('deal').select('id, title').in('id', dealIds)
    for (const d of (deals ?? []) as { id: number; title: string }[]) titles.set(d.id, d.title)
  }
  const items = page.map((r): ProposalListItem => {
    const draft = parseConnectorDraft(r.offer_draft)
    const status = proposalStatusOf(r.status)
    return {
      proposal_id: r.id,
      status,
      status_label: status === 'approved' && r.deal_id ? `${PROPOSAL_STATUS_LABEL.approved} → obchod ${r.deal_id}` : PROPOSAL_STATUS_LABEL[status],
      mode: draft?.mode ?? null,
      title: draft?.fields.title ?? (r.deal_id != null ? titles.get(r.deal_id) ?? null : null),
      account_id: r.account_id,
      deal_id: status === 'approved' ? r.deal_id : null,
      batch: draft?.batch?.label ?? null,
      created_at: r.created_at,
      decided_at: r.decided_at,
      reason: status === 'rejected' ? (r.decision_note ?? null) : null,
      link: proposalLink(opts.baseUrl, r.id),
    }
  })
  return {
    ok: true,
    data: { items, next_offset: rows.length > limit ? offset + limit : null, ...(reasonUnavailable ? { reason_unavailable: true as const } : {}) },
  }
}

export function proposalLink(baseUrl: string, id: number): string {
  return `${baseUrl.replace(/\/+$/, '')}/cockpit/rozhodnuti#navrh-${id}`
}

// ---------------------------------------------------------------------------
// Schválení a zamítnutí (volá server akce po ověření člověka a role)

const trimmed = (v: unknown) => (typeof v === 'string' ? v.trim() : v)
const emptyToUndef = (v: unknown) => {
  const t = trimmed(v)
  return t === '' || t === null ? undefined : t
}
const optNum = (max: number) => z.preprocess((v) => {
  const t = emptyToUndef(v)
  return t === undefined ? null : Number(String(t).replace(/\s/g, '').replace(',', '.'))
}, z.number({ error: 'Zadej číslo.' }).min(0, 'Nesmí být záporné.').max(max, 'Mimo rozumný rozsah.').nullable())
const optText = (max: number) => z.preprocess((v) => emptyToUndef(v) ?? null, z.string().max(max, `Nejvýš ${max} znaků.`).nullable())
const optDay = z.preprocess((v) => emptyToUndef(v) ?? null, z.string().refine(isRealDay, 'Zadej platné datum.').nullable())

export const approveEditsSchema = z.object({
  row_id: z.coerce.number().int().positive(),
  /** create = nový obchod; update = změnit existující obchod (target_deal_id). */
  mode: z.enum(['create', 'update']).default('create'),
  target_deal_id: z.preprocess(emptyToUndef, z.coerce.number().int().positive().optional()),
  /** 'id:<n>' = vybraný klient, 'new' = založit nového (jméno z new_account_name, IČO/sídlo z ARES). */
  account_choice: z.preprocess(emptyToUndef, z.string().regex(/^(id:[1-9]\d{0,17}|new)$/, 'Vyber klienta.').optional()),
  new_account_name: optText(PROPOSAL_TEXT_LIMITS.account),
  title: optText(PROPOSAL_TEXT_LIMITS.title),
  stage: z.preprocess(emptyToUndef, z.enum(PROPOSAL_STAGES).optional()),
  currency: z.preprocess(emptyToUndef, dealCurrency.optional()),
  amount: optNum(10_000_000_000),
  cogs: optNum(10_000_000_000),
  estimate_md: optNum(100_000),
  pillar: optText(40),
  phase: optText(PROPOSAL_TEXT_LIMITS.phase),
  revenue_line: z.preprocess(emptyToUndef, revenueLine.optional()),
  expected_close: optDay,
  next_step: optText(PROPOSAL_TEXT_LIMITS.nextStep),
  next_step_due: optDay,
  note: optText(PROPOSAL_TEXT_LIMITS.note),
  create_contact: z.preprocess((v) => v === 'on' || v === 'true' || v === true, z.boolean()),
  contact_full_name: optText(PROPOSAL_TEXT_LIMITS.contactName),
  contact_email: z.preprocess((v) => emptyToUndef(v), contactEmailField.optional()),
  contact_phone: z.preprocess((v) => emptyToUndef(v), contactPhoneField.optional()),
  contact_role: optText(PROPOSAL_TEXT_LIMITS.contactRole),
  /** Změny u návrhu změny (mode update návrhu): chg_<pole>. */
  chg_amount: optNum(10_000_000_000),
  chg_cogs: optNum(10_000_000_000),
  chg_estimate_md: optNum(100_000),
  chg_stage: optText(40),
  chg_lost_reason: optText(PROPOSAL_TEXT_LIMITS.lostReason),
  chg_expected_close: optDay,
  chg_next_step: optText(PROPOSAL_TEXT_LIMITS.nextStep),
  chg_next_step_due: optDay,
  chg_note: optText(PROPOSAL_TEXT_LIMITS.note),
  chg_pillar: optText(40),
  chg_phase: optText(PROPOSAL_TEXT_LIMITS.phase),
})
export type ApproveEdits = z.infer<typeof approveEditsSchema>

/** Hodnoty pro schválení beze změn (Schválit vše): přesně to, co je v návrhu. */
export function editsFromDraft(rowId: number, d: ConnectorDraft): ApproveEdits {
  const f = d.fields
  const c = d.changes ?? {}
  const num = (v: unknown) => (typeof v === 'number' ? v : null)
  const str = (v: unknown) => (typeof v === 'string' ? v : null)
  return {
    row_id: rowId, mode: d.mode, target_deal_id: d.deal_id ?? undefined,
    account_choice: d.account.id != null ? `id:${d.account.id}` : undefined,
    new_account_name: null, title: f.title, stage: f.stage ?? undefined, currency: f.currency,
    amount: f.amount, cogs: f.cogs, estimate_md: f.estimate_md, pillar: f.pillar, phase: f.phase,
    revenue_line: f.revenue_line ?? undefined, expected_close: f.expected_close, next_step: f.next_step,
    next_step_due: f.next_step_due, note: f.note,
    create_contact: d.contact != null, contact_full_name: d.contact?.full_name ?? null,
    contact_email: d.contact?.email ?? undefined, contact_phone: d.contact?.phone ?? undefined, contact_role: d.contact?.role ?? null,
    chg_amount: num(c.amount), chg_cogs: num(c.cogs), chg_estimate_md: num(c.estimate_md), chg_stage: str(c.stage),
    chg_lost_reason: str(c.lost_reason), chg_expected_close: str(c.expected_close), chg_next_step: str(c.next_step),
    chg_next_step_due: str(c.next_step_due), chg_note: str(c.note), chg_pillar: str(c.pillar), chg_phase: str(c.phase),
  }
}

export type ApproveOutcome = {
  dealId: number
  accountId: number
  title: string
  outcome: 'created' | 'updated' | 'already'
  warnings: string[]
}

type LoadedRow = { id: number; status: string; evidence_id: number; created_by: string | null; deal_id: number | null; account_id: number | null; offer_proposal_id: string; draft: ConnectorDraft; subject: string | null }

async function loadPendingRow(admin: Db, rowId: number): Promise<WriteResult<LoadedRow> | { ok: true; data: null; done: { deal_id: number | null; account_id: number | null; status: string } }> {
  const { data, error } = await admin.from('mail_content_intake')
    .select('id, status, evidence_id, created_by, deal_id, account_id, offer_proposal_id, offer_draft, subject, source')
    .eq('id', rowId).eq('source', CONNECTOR_SOURCE).maybeSingle()
  if (error) {
    if (isQueueMissing(error)) return failed(PROPOSALS_PENDING_MESSAGE, 503)
    return failed(dbErrorMessage('connector.proposal.load', error), 500)
  }
  if (!data) return failed('Návrh nenalezen.', 404)
  const r = data as Omit<LoadedRow, 'draft'> & { offer_draft: unknown }
  if (r.status !== 'queued') return { ok: true, data: null, done: { deal_id: r.deal_id, account_id: r.account_id, status: r.status } }
  const draft = parseConnectorDraft(r.offer_draft)
  if (!draft || !r.offer_proposal_id) return failed('Návrh je poškozený — zamítni ho a nech Claude poslat nový.', 409)
  return { ok: true, data: { ...r, draft } }
}

const OPEN_RANK: Record<string, number> = { kvalifikace: 1, diagnostika: 2, rozsah_nabidka: 3, rozhodovani: 4, 'vyhráno': 5 }

async function closeRow(admin: Admin, row: LoadedRow, accountId: number, dealId: number, approverId: string): Promise<void> {
  const audited = createAuditedAdminClient({ actor: { type: 'user', id: approverId } })
  const { error } = await audited.from('mail_content_intake').update({
    status: 'proposed', wait_reason: null, offer_draft: null, account_id: accountId, deal_id: dealId,
    match_method: 'manual', decided_by: `user:${approverId}`, decided_at: new Date().toISOString(),
  }).eq('id', row.id).eq('status', 'queued')
  if (error) logError('connector.proposal.close', error, { row: row.id })
}

/**
 * Schválení návrhu člověkem (vedení/admin — ověřuje volající). Nový obchod,
 * nebo změna existujícího. Idempotentní: druhé schválení najde obchod podle
 * deal.source_pdf_path = mailOfferPath(id návrhu) (unikátní index 0070).
 */
export async function approveConnectorProposal(edits: ApproveEdits, approverId: string): Promise<WriteResult<ApproveOutcome>> {
  const admin = createAdminClient()
  const loaded = await loadPendingRow(admin, edits.row_id)
  if (!loaded.ok) return loaded
  if (loaded.data === null) {
    const done = (loaded as { done: { deal_id: number | null; account_id: number | null; status: string } }).done
    if (done.status === 'proposed' && done.deal_id != null && done.account_id != null) {
      return { ok: true, data: { dealId: done.deal_id, accountId: done.account_id, title: '', outcome: 'already', warnings: [] } }
    }
    return failed('Návrh už je vyřízený (zamítnutý nebo vypršel).', 409)
  }
  const row = loaded.data
  const d = row.draft
  const warnings: string[] = []

  // --- Změna existujícího obchodu (návrh změny, nebo „Aktualizovat existující")
  if (edits.mode === 'update' || d.mode === 'update') {
    const dealId = d.mode === 'update' ? d.deal_id : edits.target_deal_id
    if (!dealId) return failed('Vyber obchod, který se má aktualizovat.')
    const { data: found, error } = await admin.from('deal').select('id, account_id, title, stage').eq('id', dealId).maybeSingle()
    if (error) return failed(dbErrorMessage('connector.proposal.approve', error), 500)
    if (!found) return failed('Obchod k aktualizaci nenalezen.', 404)
    const deal = found as { id: number; account_id: number; title: string; stage: string }
    // Aktualizovat jde jen obchod klienta návrhu, nebo obchod, který návrh sám našel (duplicita).
    const listed = d.duplicates.some((x) => x.deal_id === deal.id)
    if (d.mode === 'create' && !listed && (d.account.id == null || deal.account_id !== d.account.id)) {
      return failed('Vybraný obchod nepatří ke klientovi návrhu.')
    }
    const input: UpdateDealInput = { deal_id: deal.id }
    if (d.mode === 'update') {
      if (edits.chg_amount != null) input.amount = edits.chg_amount
      if (edits.chg_cogs != null) input.cogs = edits.chg_cogs
      if (edits.chg_estimate_md != null) input.estimate_md = Math.round(edits.chg_estimate_md)
      if (edits.chg_stage) input.stage = edits.chg_stage as UpdateDealInput['stage']
      if (edits.chg_lost_reason) input.lost_reason = edits.chg_lost_reason
      if (edits.chg_expected_close) input.expected_close = edits.chg_expected_close
      if (edits.chg_next_step) input.next_step = edits.chg_next_step
      if (edits.chg_next_step_due) input.next_step_due = edits.chg_next_step_due
      if (edits.chg_note) input.note = edits.chg_note
      if (edits.chg_pillar && isPillar(edits.chg_pillar)) input.pillar = edits.chg_pillar
      if (edits.chg_phase) input.phase = edits.chg_phase
    } else {
      if (edits.amount != null) input.amount = edits.amount
      if (edits.cogs != null) input.cogs = edits.cogs
      if (edits.estimate_md != null) input.estimate_md = Math.round(edits.estimate_md)
      if (edits.expected_close) input.expected_close = edits.expected_close
      // Fáze jen dopředu (nikdy zpět z pozdější fáze kvůli starší nabídce).
      const target = edits.stage ? dealStageForProposal(edits.stage) : null
      const current = normalizeDealStage(deal.stage) ?? deal.stage
      if (target && (OPEN_RANK[target] ?? 0) > (OPEN_RANK[current] ?? 99)) input.stage = target
      if (edits.next_step && input.stage !== 'vyhráno') {
        input.next_step = edits.next_step
        if (edits.next_step_due) input.next_step_due = edits.next_step_due
      }
    }
    const res = await applyDealChanges(input, { type: 'user', id: approverId })
    if (!res.ok) return res
    await recordAudit('deal', deal.id, 'deal.connector_proposal_confirmed', null, {
      source: CONNECTOR_SOURCE, mode: 'update', proposal_id: row.offer_proposal_id, proposed_by: d.proposed_by,
      changed: res.data.changed, ...injectionAuditMeta(d.injection_flags),
    }, { type: 'user', id: approverId }, { evidenceId: row.evidence_id, infoState: 'human_confirmed' })
    await closeRow(admin, row, deal.account_id, deal.id, approverId)
    return { ok: true, data: { dealId: deal.id, accountId: deal.account_id, title: deal.title, outcome: 'updated', warnings } }
  }

  // --- Nový obchod
  const sourcePath = mailOfferPath(row.offer_proposal_id)
  const prior = await admin.from('deal').select('id, account_id, title').eq('source_pdf_path', sourcePath).limit(1)
  if (prior.error) return failed(dbErrorMessage('connector.proposal.approve', prior.error), 500)
  const already = ((prior.data ?? [])[0] as { id: number; account_id: number; title: string } | undefined) ?? null
  if (already) {
    await closeRow(admin, row, already.account_id, already.id, approverId)
    return { ok: true, data: { dealId: already.id, accountId: already.account_id, title: already.title, outcome: 'already', warnings } }
  }

  const title = edits.title ?? d.fields.title
  if (!title) return failed('Název zakázky je povinný.')
  const choice = edits.account_choice ?? (d.account.id != null ? `id:${d.account.id}` : undefined)
  if (!choice) return failed('Klient není jistý — vyber ho z kandidátů, nebo zvol „Nový klient".')
  const audited = createAuditedAdminClient({ actor: { type: 'user', id: approverId } })
  let accountId: number
  let accountOwner: string | null = null
  if (choice === 'new') {
    const name = edits.new_account_name ?? d.account.name
    if (!name) return failed('Vyplň název nového klienta.')
    const created = await resolveNewOfferAccount(audited, name, warnings)
    if (created.kind === 'error') return failed(created.error, 500)
    accountId = created.id
  } else {
    accountId = Number(choice.slice(3))
    const { data: acc, error } = await admin.from('account').select('id, owner_id').eq('id', accountId).maybeSingle()
    if (error) return failed(dbErrorMessage('connector.proposal.approve', error), 500)
    if (!acc) return failed('Vybraný klient v Cockpitu není.', 404)
    accountOwner = (acc as { owner_id: string | null }).owner_id
  }

  const pillar = edits.pillar ?? d.fields.pillar
  const phase = edits.phase ?? d.fields.phase
  if (pillar && !isPillar(pillar)) return failed('Neznámý pilíř.')
  if (phase && (!pillar || !phasesFor(pillar).some((p) => p.key === phase))) return failed('Fáze nepatří k vybranému pilíři.')

  const proposalStage = edits.stage ?? d.fields.stage ?? 'nabidka_odeslana'
  const stage = dealStageForProposal(proposalStage)
  const won = stage === 'vyhráno'
  const currency = edits.currency ?? d.fields.currency
  const amount = edits.amount ?? null
  let amounts
  try {
    amounts = await amountColumns(currency, amount, null)
  } catch (e) {
    logError('connector.proposal.fx', e)
    return failed(FX_FAILED, 503)
  }
  const line = edits.revenue_line ?? d.fields.revenue_line ?? DEFAULT_IMPORT_REVENUE_LINE
  const today = pragueToday()
  const nextStep = won ? null : (edits.next_step ?? null)
  const { data: deal, error: dealError } = await audited.from('deal').insert({
    account_id: accountId,
    title,
    revenue_line: line,
    revenue_category: categoryForLine[line],
    stage,
    probability_pct: defaultProbabilityForStage(stage),
    forecast_category: won ? 'closed' : 'pipeline',
    ...(won ? { won_at: today, closed_at: today } : {}),
    currency,
    ...amounts,
    cogs_one_time: edits.cogs ?? null,
    estimate_md: edits.estimate_md != null ? Math.round(edits.estimate_md) : null,
    pillar: pillar ?? null,
    phase: phase ?? null,
    expected_close: edits.expected_close ?? null,
    next_step: nextStep,
    next_step_due: nextStep ? (edits.next_step_due ?? null) : null,
    note: edits.note ?? null,
    owner_id: accountOwner ?? d.proposed_by ?? approverId,
    source_pdf_path: sourcePath,
  }).select('id').single()
  if (dealError) {
    if (dealError.code === '23505') {
      const winner = await admin.from('deal').select('id, account_id, title').eq('source_pdf_path', sourcePath).limit(1)
      const w = ((winner.data ?? [])[0] as { id: number; account_id: number; title: string } | undefined) ?? null
      if (w) {
        await closeRow(admin, row, w.account_id, w.id, approverId)
        return { ok: true, data: { dealId: w.id, accountId: w.account_id, title: w.title, outcome: 'already', warnings } }
      }
    }
    return failed(`Obchod se nepodařilo založit. ${dbErrorMessage('connector.proposal.deal', dealError)}`, 500)
  }
  const dealId = (deal as { id: number }).id

  // Kontakt (jen když ho člověk nechal zaškrtnutý; stejný člověk podruhé ne).
  let contactId: number | null = null
  const contactName = edits.contact_full_name
  if (edits.create_contact && contactName) {
    const { data: siblings } = await admin.from('contact').select('id, full_name, email').eq('account_id', accountId)
    const twin = findDuplicateContact((siblings ?? []) as { id: number; full_name: string | null; email: string | null }[], {
      full_name: contactName, email: edits.contact_email ?? null,
    })
    if (twin) {
      contactId = twin.id
    } else {
      const ins = await audited.from('contact').insert({
        account_id: accountId, partner_id: null, full_name: contactName, role: edits.contact_role ?? null,
        email: edits.contact_email ?? null, phone: edits.contact_phone ?? null, is_champion: false,
      }).select('id').single()
      if (ins.error) warnings.push('kontakt se nepodařilo založit (doplň ho ručně)')
      else contactId = (ins.data as { id: number }).id
    }
  }

  // Aktivita na kartě klienta: odkud obchod vznikl (text zdroje jen jako data).
  const s = d.source
  const from = s.kind === 'email' ? 'e-mailu' : s.kind === 'pdf' ? 'PDF' : s.kind === 'transcript' ? 'přepisu schůzky' : 'zdroje'
  const subject = `Založeno z ${from}: ${s.subject ?? s.label ?? title}`.slice(0, 300)
  const body = [
    `Obchod založen ze schváleného návrhu konektoru (Claude${d.proposed_by_name ? ` jménem ${d.proposed_by_name}` : ''}).`,
    s.sender ? `Odesílatel: ${s.sender}` : null,
    s.recipient ? `Příjemce: ${s.recipient}` : null,
    s.date ? `Datum: ${s.date}` : null,
    s.message_id ? `Outlook messageId: ${s.message_id}` : null,
    s.web_link ? `Odkaz: ${s.web_link}` : null,
    d.fields.amount_range ? `Cena je odhad ze rozpětí ${d.fields.amount_range.min}–${d.fields.amount_range.max} ${d.fields.currency}.` : null,
  ].filter(Boolean).join('\n')
  const act = await audited.from('sales_activity').insert({
    account_id: accountId, deal_id: dealId, contact_id: contactId, kind: s.kind === 'email' ? 'email' : 'note', outcome: 'completed',
    subject, body, occurred_at: toIsoOrNow(s.date), source: 'api', created_by: approverId,
  }).select('id').single()
  if (act.error) warnings.push('aktivitu „Založeno z e-mailu" se nepodařilo zapsat')

  const changedFields = (['title', 'stage', 'amount', 'cogs', 'estimate_md', 'currency', 'pillar', 'phase', 'expected_close', 'next_step', 'note'] as const)
    .filter((k) => {
      const human = k === 'stage' ? proposalStage : (edits as Record<string, unknown>)[k] ?? null
      const ai = (d.fields as Record<string, unknown>)[k] ?? null
      return human !== ai
    })
  await recordAudit('deal', dealId, 'deal.connector_proposal_confirmed', null, {
    source: CONNECTOR_SOURCE, mode: 'create', proposal_id: row.offer_proposal_id, proposed_by: d.proposed_by,
    batch_id: d.batch?.id ?? null, changed_fields: changedFields, stage, currency,
    account: choice === 'new' ? 'new' : 'existing', contact_id: contactId, ...injectionAuditMeta(d.injection_flags),
  }, { type: 'user', id: approverId }, { evidenceId: row.evidence_id, infoState: 'human_confirmed' })

  await closeRow(admin, row, accountId, dealId, approverId)
  return { ok: true, data: { dealId, accountId, title, outcome: 'created', warnings } }
}

/** Zamítnutí: návrh i text zdroje z řádku zmizí, zůstane stav a důvod (0101). */
export async function rejectConnectorProposal(rowId: number, note: string | null, approverId: string): Promise<WriteResult<{ id: number; reasonSaved: boolean }>> {
  const admin = createAdminClient()
  const loaded = await loadPendingRow(admin, rowId)
  if (!loaded.ok) return loaded
  if (loaded.data === null) return failed('Návrh už je vyřízený.', 409)
  const audited = createAuditedAdminClient({ actor: { type: 'user', id: approverId } })
  const patch = {
    status: 'discarded', wait_reason: null, subject: null, excerpt: null, attachment_names: [], offer_draft: null,
    decided_by: `user:${approverId}`, decided_at: new Date().toISOString(),
  }
  const reason = clip(note, PROPOSAL_TEXT_LIMITS.reason)
  let reasonSaved = reason != null
  let res = await audited.from('mail_content_intake').update(reason ? { ...patch, decision_note: reason } : patch)
    .eq('id', rowId).eq('status', 'queued').select('id')
  if (res.error && reason && isQueueMissing(res.error)) {
    // Bez migrace 0101 (sloupec decision_note) se zamítne bez uloženého důvodu.
    reasonSaved = false
    res = await audited.from('mail_content_intake').update(patch).eq('id', rowId).eq('status', 'queued').select('id')
  }
  if (res.error) return failed(dbErrorMessage('connector.proposal.reject', res.error), 500)
  if (!res.data || (res.data as unknown[]).length === 0) return failed('Návrh už je vyřízený.', 409)
  return { ok: true, data: { id: rowId, reasonSaved } }
}

/** Schválí v dávce jen návrhy bez varování (s varováním člověk po jednom). */
export async function approveConnectorBatch(batchId: string, approverId: string, blocks: (d: ConnectorDraft) => boolean): Promise<WriteResult<{ approved: number; skipped: number; failed: number }>> {
  const admin = createAdminClient()
  const { data, error } = await admin.from('mail_content_intake').select('id, offer_draft')
    .eq('source', CONNECTOR_SOURCE).eq('status', 'queued')
  if (error) {
    if (isQueueMissing(error)) return failed(PROPOSALS_PENDING_MESSAGE, 503)
    return failed(dbErrorMessage('connector.proposal.batch', error), 500)
  }
  let approved = 0
  let skipped = 0
  let failedCount = 0
  for (const r of (data ?? []) as { id: number; offer_draft: unknown }[]) {
    const d = parseConnectorDraft(r.offer_draft)
    if (!d || d.batch?.id !== batchId) continue
    if (blocks(d)) {
      skipped++
      continue
    }
    const res = await approveConnectorProposal(editsFromDraft(r.id, d), approverId)
    if (res.ok) approved++
    else failedCount++
  }
  return { ok: true, data: { approved, skipped, failed: failedCount } }
}

// ---------------------------------------------------------------------------
// Fronta pro UI (/rozhodnuti) — čte session klient (RLS: obchodní role + AAL2)

export type PendingConnectorProposal = {
  id: number
  createdAt: string
  draft: ConnectorDraft
  /** Aktuální stav obchodu u návrhu změny (pro porovnání). */
  deal: { id: number; title: string; stage: string; amount_czk: number | null; currency: string | null } | null
}

export async function listPendingConnectorProposals(db: Db): Promise<{ state: 'ok'; items: PendingConnectorProposal[] } | { state: 'missing_migration' } | { state: 'error' }> {
  const { data, error } = await db.from('mail_content_intake').select('id, created_at, offer_draft')
    .eq('source', CONNECTOR_SOURCE).eq('status', 'queued').order('created_at', { ascending: true }).limit(200)
  if (error) {
    if (isQueueMissing(error)) return { state: 'missing_migration' }
    logError('connector.proposals.ui', error)
    return { state: 'error' }
  }
  const rows = ((data ?? []) as { id: number; created_at: string; offer_draft: unknown }[])
    .map((r) => ({ id: r.id, createdAt: r.created_at, draft: parseConnectorDraft(r.offer_draft) }))
    .filter((r): r is { id: number; createdAt: string; draft: ConnectorDraft } => r.draft !== null)
  const dealIds = [...new Set(rows.flatMap((r) => (r.draft.mode === 'update' && r.draft.deal_id ? [r.draft.deal_id] : [])))]
  const deals = new Map<number, PendingConnectorProposal['deal']>()
  if (dealIds.length > 0) {
    const { data: ds } = await db.from('deal').select('id, title, stage, amount_one_time, currency').in('id', dealIds)
    for (const d of (ds ?? []) as { id: number; title: string; stage: string; amount_one_time: number | null; currency: string | null }[]) {
      deals.set(d.id, { id: d.id, title: d.title, stage: d.stage, amount_czk: d.amount_one_time == null ? null : Number(d.amount_one_time), currency: d.currency })
    }
  }
  return { state: 'ok', items: rows.map((r) => ({ ...r, deal: r.draft.deal_id ? deals.get(r.draft.deal_id) ?? null : null })) }
}

