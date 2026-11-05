// Příjem zápisů schůzek z diktátu (Wispr Flow) — zápis do databáze.
// Čistá rozhodovací logika (validace, párování na firmu, úkoly z textu) je
// v domain/crm/meetingIntake.ts; tady je jen I/O kolem ní.
//
// Tok POST /api/ingest/meeting-notes:
//   1. validace vstupu a očištění textu (žádný model, žádné vykonání textu),
//   2. řádek meeting_note_intake se stavem 'unmatched' — VŽDY jako první, aby
//      se zápis neztratil, ať se cokoli stane dál, a aby opakované odeslání
//      (dedupe_key) nic nezdvojilo,
//   3. párování na klienta (IČO, doména, alias, název) — radši nic než špatná
//      vazba,
//   4. spárovaný → aktivita druhu schůzka (sales_activity, source
//      'wispr_flow', external_id 'intake:<id>' = pojistka proti duplicitě)
//      + z úkolů v textu NÁVRH případu (case_proposal, ke schválení);
//      má-li klient ten den naplánovanou schůzku, zápis ji DOPLNÍ (outcome
//      completed) místo nové aktivity (domain/crm/plannedMeetingPairing.ts);
//      řádek intake se přepne na 'assigned' a text z něj zmizí,
//      nespárovaný zůstává ve frontě /schuzky/nesparovane.
//
// SOUKROMÍ: obsah zápisu se nikdy neloguje (logují se jen id, kódy chyb
// a názvy příznaků). Chyby z databáze se zapisují jen kódem — Postgres
// v detailu CHECK/NOT NULL chyby cituje celý řádek, tedy i text zápisu.
//
// Všechny zápisy jdou přes servisní klíč (RLS obchází), proto kontrola
// obchodní role vlastníka klíče (canSeeSales) je tady i v route, ne jen v DB.
import type { SupabaseClient } from '@supabase/supabase-js'
import { createAdminClient } from '@/lib/supabase/admin'
import { createAuditedAdminClient } from '@/core/auditDb'
import type { AuditActor } from '@/core/audit'
import { recordEvidence } from '@/core/evidence'
import type { InformationState } from '@/core/informationState'
import { detectInjectionMarkers, sanitizeUntrustedText, type InjectionFlag } from '@/core/untrusted'
import { CapabilityAbort, type CaseProposalOutput, type ProposalDraft } from '@/core/agents/template'
import { caseProposalSink, isProposalsMigrationMissing } from '@/core/agents/caseProposal'
import type { NormalizedEvent } from '@/core/connectors/contract'
import { COMPANY } from '@/config'
import type { MeetingNotesConfig } from '@/core/tenant'
import { logError, logWarn } from '@/lib/log'
import type { WriteResult } from '@/domain/crm/apiWrite'
import { pairNoteWithPlannedMeeting } from '@/domain/crm/plannedMeetingPairing'
import {
  MEETING_NOTE_ACTION_MAX,
  MEETING_NOTE_BODY_MAX,
  MEETING_NOTE_HINT_MAX,
  MEETING_NOTE_SOURCE,
  MEETING_NOTE_TITLE_MAX,
  buildStepsProposal,
  dedupeKeyFor,
  extractActionItems,
  matchNoteToAccount,
  meetingNoteInput,
  resolveOccurredAt,
  subjectFor,
  type MatchAccount,
  type MatchAlias,
  type MatchContact,
  type NoteMatchMethod,
} from '@/domain/crm/meetingIntake'

type Db = Pick<SupabaseClient, 'from'>

export const MEETING_INTAKE_CAPABILITY = 'meeting_note_steps'
export const MEETING_INTAKE_MIGRATION_PENDING = 'Příjem zápisů schůzek čeká na migraci 0078.'
export const SALES_ONLY_ERROR = 'sales_role_required'
export const ACCOUNT_NOT_FOUND_ERROR = 'Klient nenalezen.'
export const NOTE_ALREADY_HANDLED_ERROR = 'Zápis už je vyřízený. Obnov stránku.'
export const NOTE_NOT_FOUND_ERROR = 'Zápis nenalezen.'

export type IntakeStatus = 'unmatched' | 'assigned' | 'discarded'
/** Co se stalo s návrhem kroků. */
export type ProposalOutcome = 'created' | 'already_pending' | 'none' | 'unavailable'
/** Proč zápis čeká ve frontě (jen u 'unmatched'). */
export type UnmatchedReason = 'no_match' | 'ambiguous' | 'assign_failed'

export type IngestResult = {
  id: number
  status: IntakeStatus
  /** Stejný zápis už jednou přišel (klíč idempotence). */
  duplicate: boolean
  account_id: number | null
  match_method: string | null
  activity_id: number | null
  proposal: ProposalOutcome
  proposal_id: number | null
  /** Jen u status 'unmatched'. */
  reason?: UnmatchedReason
  injection_flags?: InjectionFlag[]
  /** Jen když zápis doplnil naplánovanou schůzku téhož dne (activity_id je ta schůzka). */
  paired_planned?: true
}

type Actor = { type: 'api_key' | 'user'; id: string | null }

function failed(error: string, status = 400): WriteResult<never> {
  return { ok: false, status, error }
}

// Do logu jen kód chyby — viz „SOUKROMÍ" výš.
function logDbError(scope: string, error: unknown, context: Record<string, unknown> = {}): void {
  const code = typeof error === 'object' && error !== null ? (error as { code?: unknown }).code : undefined
  logError(scope, 'chyba databáze', { code: typeof code === 'string' ? code : 'unknown', ...context })
}

function isMissingTable(error: unknown): boolean {
  return isProposalsMigrationMissing(error as { code?: string | null; message?: string | null } | null)
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23505'
}

const actorText = (a: Actor): string => (a.id ? `${a.type}:${a.id}` : a.type)
const auditActor = (a: Actor): AuditActor => ({ type: a.type, id: a.id })

// ---------------------------------------------------------------------------
// Data pro párování

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

/** Firmy, aliasy a kontakty pro `matchNoteToAccount` (přes servisní klíč). */
export async function loadMatchData(
  db: Db,
): Promise<{ accounts: MatchAccount[]; aliases: MatchAlias[]; contacts: MatchContact[] }> {
  const [accounts, aliases, contacts] = await Promise.all([
    fetchAll<MatchAccount>((from, to) => db.from('account').select('id, name, ico, web').order('id').range(from, to)),
    fetchAll<MatchAlias>((from, to) =>
      db.from('company_alias').select('account_id, alias_domain, alias_name').order('id').range(from, to)),
    fetchAll<MatchContact>((from, to) =>
      db.from('contact').select('account_id, email').not('email', 'is', null).not('account_id', 'is', null)
        .order('id').range(from, to)),
  ])
  return {
    accounts,
    aliases,
    contacts: contacts.filter((c) => typeof c.email === 'string' && c.email.includes('@')),
  }
}

// ---------------------------------------------------------------------------
// Přiřazení zápisu k firmě: aktivita + návrh kroků + uzavření řádku

export type IntakeForAssign = {
  id: number
  title: string | null
  body: string
  actions: readonly string[]
  occurred_at: string
}

type AssignOk = {
  activityId: number | null
  proposal: ProposalOutcome
  proposalId: number | null
  /** Zápis doplnil naplánovanou schůzku téhož dne (žádný nový řádek). */
  pairedPlanned: boolean
}

/**
 * Založí aktivitu (schůzka) a návrh kroků a řádek intake uzavře jako
 * 'assigned' (text z něj zmizí). Idempotentní: aktivita má
 * external_id 'intake:<id>', návrh source_key '<zdroj>|meeting.note|<id>' —
 * opakované volání (dvojklik, výpadek po zápisu aktivity) nic nezdvojí.
 */
export async function assignIntakeToAccount(args: {
  row: IntakeForAssign
  accountId: number
  method: NoteMatchMethod | 'manual'
  actor: Actor
  /** created_by aktivity: člověk, jehož klíč nebo session zápis provedl. */
  createdBy: string | null
  infoState: InformationState
  now?: Date
}): Promise<WriteResult<AssignOk>> {
  const { row, accountId, method, actor, createdBy, infoState } = args
  const now = args.now ?? new Date()
  const plain = createAdminClient()

  const { data: account, error: accountError } = await plain
    .from('account').select('id, name').eq('id', accountId).maybeSingle()
  if (accountError) {
    logDbError('meetingIntake.assign.account', accountError, { note: row.id })
    return failed('Klienta se nepodařilo načíst.', 500)
  }
  if (!account) return failed(ACCOUNT_NOT_FOUND_ERROR, 404)

  // Odkaz na zdroj: náš vlastní identifikátor (ne nic od odesílatele — evidence
  // je sdílený ukazatel, viz core/evidence.ts). Nese ho aktivita v auditu
  // a case_proposal.evidence_id (NOT NULL).
  const evidenceRef = { kind: 'meeting' as const, sourceId: `cockpit-intake:${row.id}`, webLink: null }
  const evidence = await recordEvidence(plain, evidenceRef, actorText(actor))
  const evidenceId = evidence.ok ? evidence.id : null

  const db = createAuditedAdminClient({ actor: auditActor(actor), evidenceId, infoState })

  // ---- aktivita: (a) už ji má tenhle zápis (opakovaný pokus), (b) klient má
  // ten den naplánovanou schůzku → zápis ji doplní (domain/crm/
  // plannedMeetingPairing.ts), (c) jinak nová. Klíč 'intake:<id>' nese v (b)
  // i (c) řádek aktivity, takže (a) ho při dalším pokusu najde.
  const externalId = `intake:${row.id}`
  const findExisting = async () => {
    const existing = await plain
      .from('sales_activity').select('id').eq('source', MEETING_NOTE_SOURCE).eq('external_id', externalId).maybeSingle()
    return (existing.data as { id: number } | null)?.id ?? null
  }
  let activityId: number | null = await findExisting()
  let pairedPlanned = false
  if (activityId == null) {
    const pairing = await pairNoteWithPlannedMeeting(plain, db, {
      target: { account_id: accountId, partner_id: null, contact_id: null },
      occurredAt: row.occurred_at,
      note: { title: row.title, text: row.body, source: MEETING_NOTE_SOURCE, externalId },
      now,
    })
    if (pairing.paired) {
      activityId = pairing.activityId
      pairedPlanned = true
    }
  }
  if (activityId == null) {
    const inserted = await db
      .from('sales_activity')
      .insert({
        account_id: accountId,
        kind: 'meeting',
        outcome: 'completed',
        subject: subjectFor(row.title, row.body),
        body: row.body,
        occurred_at: row.occurred_at,
        source: MEETING_NOTE_SOURCE,
        external_id: externalId,
        created_by: createdBy,
      })
      .select('id')
      .single()
    if (inserted.error) {
      if (!isUniqueViolation(inserted.error)) {
        logDbError('meetingIntake.assign.activity', inserted.error, { note: row.id })
        return failed('Aktivitu se nepodařilo založit.', 500)
      }
      // Už existuje (souběžný pokus) — použije se ta původní.
      activityId = await findExisting()
    } else {
      activityId = (inserted.data as { id: number }).id
    }
  }

  // ---- návrh kroků (jen když jsou v textu úkoly)
  const proposal = await proposeSteps(plain, {
    noteId: row.id,
    accountId,
    accountName: (account as { name: string }).name,
    occurredAt: row.occurred_at,
    actions: extractActionItems(row.body, row.actions),
  })

  // ---- uzavření řádku: text pryč, zůstávají jen metadata
  const closed = await db
    .from('meeting_note_intake')
    .update({
      status: 'assigned',
      account_id: accountId,
      match_method: method,
      activity_id: activityId,
      proposal_id: proposal.proposalId,
      title: null,
      body: null,
      client_hint: null,
      actions: [],
      decided_by: actorText(actor),
      decided_at: now.toISOString(),
    })
    .eq('id', row.id)
    .eq('status', 'unmatched')
    .select('id')
  if (closed.error) {
    // Aktivita už je založená; řádek zůstane ve frontě a ruční přiřazení
    // narazí na external_id (nezdvojí). Nic se neztratilo.
    logDbError('meetingIntake.assign.close', closed.error, { note: row.id })
    return failed('Zápis se nepodařilo uzavřít.', 500)
  }

  return { ok: true, data: { activityId, proposal: proposal.outcome, proposalId: proposal.proposalId, pairedPlanned } }
}

async function proposeSteps(
  db: Db,
  a: { noteId: number; accountId: number; accountName: string; occurredAt: string; actions: string[] },
): Promise<{ outcome: ProposalOutcome; proposalId: number | null }> {
  const cfg = COMPANY.capabilities.meetingNotes as MeetingNotesConfig | null | undefined
  if (!cfg || a.actions.length === 0) return { outcome: 'none', proposalId: null }
  const built = buildStepsProposal(a.actions, a.accountName, cfg.titleTemplate)
  if (!built) return { outcome: 'none', proposalId: null }

  const sourceKey = `${MEETING_NOTE_SOURCE}|meeting.note|${a.noteId}`
  const event: NormalizedEvent<null> = {
    source: MEETING_NOTE_SOURCE,
    type: 'meeting.note',
    external_id: String(a.noteId),
    occurred_at: a.occurredAt,
    subject: { kind: 'account', id: a.accountId },
    participants: [],
    evidence: { kind: 'meeting', sourceId: `cockpit-intake:${a.noteId}`, webLink: null },
    title: null,
    payload: null,
  }
  const draft: ProposalDraft<null, CaseProposalOutput> = {
    capability: MEETING_INTAKE_CAPABILITY,
    sourceKey,
    event,
    output: { title: built.title, rationale: built.rationale },
    reasons: [],
    method: 'rule',
    infoState: 'ai_suggestion',
    target: { node: cfg.node, accountId: a.accountId, steps: built.steps },
  }

  try {
    const result = await caseProposalSink<null, CaseProposalOutput>(db, {
      createdBy: `system:${MEETING_INTAKE_CAPABILITY}`,
    }).propose(draft)
    const { data } = await db
      .from('case_proposal').select('id').eq('capability', MEETING_INTAKE_CAPABILITY).eq('source_key', sourceKey).maybeSingle()
    const proposalId = (data as { id: number } | null)?.id ?? null
    if (result === 'created') return { outcome: 'created', proposalId }
    // 'duplicate': buď tenhle zápis už návrh má (opakovaný pokus), nebo firma
    // už má čekající návrh z jiného zápisu (nejvýš jeden čekající na firmu a uzel).
    return proposalId ? { outcome: 'created', proposalId } : { outcome: 'already_pending', proposalId: null }
  } catch (e) {
    if (e instanceof CapabilityAbort) {
      logWarn('meetingIntake.proposal', 'návrh kroků není dostupný', { note: a.noteId })
    } else {
      logError('meetingIntake.proposal', e instanceof Error ? e.name : 'chyba', { note: a.noteId })
    }
    return { outcome: 'unavailable', proposalId: null }
  }
}

// ---------------------------------------------------------------------------
// Příjem z API

type IntakeRowMeta = {
  id: number
  status: IntakeStatus
  account_id: number | null
  match_method: string | null
  activity_id: number | null
  proposal_id: number | null
}

const META_COLUMNS = 'id, status, account_id, match_method, activity_id, proposal_id'

function summarizeExisting(row: IntakeRowMeta): IngestResult {
  return {
    id: row.id,
    status: row.status,
    duplicate: true,
    account_id: row.account_id,
    match_method: row.match_method,
    activity_id: row.activity_id,
    proposal: row.proposal_id ? 'created' : 'none',
    proposal_id: row.proposal_id,
    ...(row.status === 'unmatched' ? { reason: 'no_match' as const } : {}),
  }
}

/**
 * Přijme zápis schůzky z diktátu (viz hlavička souboru). `createdBy` a
 * `canSeeSales` pocházejí z ověřeného API klíče (requireApiKey).
 * Nikdy nevyhazuje; obsah zápisu nevrací a neloguje.
 */
export async function ingestMeetingNote(
  raw: unknown,
  ctx: { createdBy: string | null; canSeeSales: boolean; now?: Date },
): Promise<WriteResult<IngestResult>> {
  if (!ctx.canSeeSales) return failed(SALES_ONLY_ERROR, 403)
  const now = ctx.now ?? new Date()

  const parsed = meetingNoteInput.safeParse(raw)
  if (!parsed.success) return failed(parsed.error.issues[0]?.message ?? 'Neplatný vstup.')
  const input = parsed.data

  // Očištění: neviditelné a řídicí znaky pryč (schovaný pokyn), konce řádků sjednocené.
  const text = sanitizeUntrustedText(input.text, MEETING_NOTE_BODY_MAX).text.trim()
  if (text.length === 0) return failed('text je povinný')
  const cleanOpt = (v: string | null, max: number): string | null => {
    if (v == null) return null
    const c = sanitizeUntrustedText(v, max).text.replace(/\s+/g, ' ').trim()
    return c.length > 0 ? c : null
  }
  const title = cleanOpt(input.title, MEETING_NOTE_TITLE_MAX)
  const clientHint = cleanOpt(input.client_hint, MEETING_NOTE_HINT_MAX)
  const actions = input.actions
    .map((a) => cleanOpt(a, MEETING_NOTE_ACTION_MAX))
    .filter((a): a is string => a != null)

  const when = resolveOccurredAt(input.occurred_at, now)
  if (!when.ok) return failed(when.error)

  // Příznaky možných pokynů pro AI: neblokují, jen se vrátí odesílateli a zaloguje
  // se jejich název (nikdy text). Nad původním vstupem, ještě před očištěním.
  const flags = detectInjectionMarkers(`${input.title ?? ''}\n${input.text}`)

  const actor: Actor = { type: 'api_key', id: ctx.createdBy }
  const dedupeKey = dedupeKeyFor(MEETING_NOTE_SOURCE, input.external_id, text, ctx.createdBy)
  const plain = createAdminClient()
  const db = createAuditedAdminClient({ actor: auditActor(actor) })

  // ---- 1) řádek fronty (vždy první — zápis se nesmí ztratit)
  const inserted = await db
    .from('meeting_note_intake')
    .insert({
      source: MEETING_NOTE_SOURCE,
      status: 'unmatched',
      dedupe_key: dedupeKey,
      title,
      body: text,
      client_hint: clientHint,
      actions,
      occurred_at: when.iso,
      created_by: ctx.createdBy,
    })
    .select('id')
    .single()
  if (inserted.error) {
    if (isMissingTable(inserted.error)) return failed(MEETING_INTAKE_MIGRATION_PENDING, 503)
    if (isUniqueViolation(inserted.error)) {
      const existing = await plain.from('meeting_note_intake').select(META_COLUMNS).eq('dedupe_key', dedupeKey).maybeSingle()
      if (existing.data) return { ok: true, data: summarizeExisting(existing.data as IntakeRowMeta) }
    }
    logDbError('meetingIntake.insert', inserted.error)
    return failed('Zápis se nepodařilo uložit.', 500)
  }
  const id = (inserted.data as { id: number }).id
  if (flags.length > 0) logWarn('meetingIntake', 'text zápisu nese příznaky možných pokynů pro AI', { flags, note: id })

  const base: IngestResult = {
    id,
    status: 'unmatched',
    duplicate: false,
    account_id: null,
    match_method: null,
    activity_id: null,
    proposal: 'none',
    proposal_id: null,
    ...(flags.length > 0 ? { injection_flags: flags } : {}),
  }
  const queued = (reason: UnmatchedReason): WriteResult<IngestResult> => ({ ok: true, data: { ...base, reason } })

  // ---- 2) párování
  let match
  try {
    const data = await loadMatchData(plain)
    match = matchNoteToAccount({ clientHint, title, text, ...data })
  } catch (e) {
    logDbError('meetingIntake.match', e, { note: id })
    return queued('no_match')
  }
  if (match.status === 'none') return queued('no_match')
  if (match.status === 'ambiguous') return queued('ambiguous')

  // ---- 3) aktivita + návrh kroků; při chybě zápis zůstává ve frontě
  const assigned = await assignIntakeToAccount({
    row: { id, title, body: text, actions, occurred_at: when.iso },
    accountId: match.accountId,
    method: match.method,
    actor,
    createdBy: ctx.createdBy,
    infoState: 'source_fact',
    now,
  })
  if (!assigned.ok) return queued('assign_failed')

  return {
    ok: true,
    data: {
      ...base,
      status: 'assigned',
      account_id: match.accountId,
      match_method: match.method,
      activity_id: assigned.data.activityId,
      proposal: assigned.data.proposal,
      proposal_id: assigned.data.proposalId,
      ...(assigned.data.pairedPlanned ? { paired_planned: true as const } : {}),
    },
  }
}

// ---------------------------------------------------------------------------
// Ruční rozhodnutí (fronta „Nespárované zápisy")

type QueueRow = {
  id: number
  status: IntakeStatus
  title: string | null
  body: string | null
  actions: unknown
  occurred_at: string
  created_by: string | null
}

async function loadQueueRow(db: Db, id: number): Promise<WriteResult<QueueRow>> {
  const { data, error } = await db
    .from('meeting_note_intake').select('id, status, title, body, actions, occurred_at, created_by').eq('id', id).maybeSingle()
  if (error) {
    if (isMissingTable(error)) return failed(MEETING_INTAKE_MIGRATION_PENDING, 503)
    logDbError('meetingIntake.load', error, { note: id })
    return failed('Zápis se nepodařilo načíst.', 500)
  }
  if (!data) return failed(NOTE_NOT_FOUND_ERROR, 404)
  const row = data as QueueRow
  if (row.status !== 'unmatched' || row.body == null) return failed(NOTE_ALREADY_HANDLED_ERROR, 409)
  return { ok: true, data: row }
}

const stringArray = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])

/**
 * Člověk přiřadí čekající zápis ke klientovi. Volá server akce PO
 * requireUser({ aal2: true }) a kontrole obchodní role.
 */
export async function assignQueuedNote(args: {
  noteId: number
  accountId: number
  userId: string
  now?: Date
}): Promise<WriteResult<AssignOk>> {
  const plain = createAdminClient()
  const loaded = await loadQueueRow(plain, args.noteId)
  if (!loaded.ok) return loaded
  const row = loaded.data
  return assignIntakeToAccount({
    row: {
      id: row.id,
      title: row.title,
      body: row.body as string,
      actions: stringArray(row.actions),
      occurred_at: row.occurred_at,
    },
    accountId: args.accountId,
    method: 'manual',
    actor: { type: 'user', id: args.userId },
    createdBy: args.userId,
    // Člověk přiřazení potvrdil — trigger u aktéra 'user' píše human_confirmed sám.
    infoState: 'human_confirmed',
    now: args.now,
  })
}

/** Člověk čekající zápis zahodí; text se smaže, zůstane jen řádek bez obsahu. */
export async function discardQueuedNote(args: {
  noteId: number
  userId: string
  now?: Date
}): Promise<WriteResult<{ id: number }>> {
  const plain = createAdminClient()
  const loaded = await loadQueueRow(plain, args.noteId)
  if (!loaded.ok) return loaded
  const actor: Actor = { type: 'user', id: args.userId }
  const db = createAuditedAdminClient({ actor: auditActor(actor) })
  const { data, error } = await db
    .from('meeting_note_intake')
    .update({
      status: 'discarded',
      title: null,
      body: null,
      client_hint: null,
      actions: [],
      decided_by: actorText(actor),
      decided_at: (args.now ?? new Date()).toISOString(),
    })
    .eq('id', args.noteId)
    .eq('status', 'unmatched')
    .select('id')
  if (error) {
    logDbError('meetingIntake.discard', error, { note: args.noteId })
    return failed('Zápis se nepodařilo zahodit.', 500)
  }
  if (!data || data.length === 0) return failed(NOTE_ALREADY_HANDLED_ERROR, 409)
  return { ok: true, data: { id: args.noteId } }
}
