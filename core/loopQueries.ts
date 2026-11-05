// Rozhodovací inbox (Loop Core, kapitola 7): čtení čekajících schválení
// a otevřených rozhodnutí. Jen SELECT přes uživatelského klienta (RLS
// 0039 dává týmu SELECT); zápis jde výhradně přes RPC decide_approval /
// resolve_decision — tady se nic nezapisuje.
//
// Tabulky jsou v migraci 0039_loop_core.sql, která ještě nemusí být
// aplikovaná. Chybějící relace (42P01 / PGRST205) proto není chyba, ale
// stav „čeká na migraci" — stránka ho vykreslí klidnou hláškou.
import { createClient } from '@/lib/supabase/server'
import { canCurrentUserSeeSales } from '@/lib/queries/access'
import { findDealPublic } from '@/lib/queries/dealPublic'
import type { LoopNodeRow } from './authority'
import type { ApprovalExecution } from './approvalActions'
import { statusesForFilter, type CaseFilter } from './workCaseFlow'

export type RawApproval = {
  id: number
  action_kind: string
  requested_level: string
  requested_by: string
  created_at: string
  expires_at: string | null
  case_title: string | null
  // Volitelné kvůli zpětné kompatibilitě tvaru; getDecisionInbox je plní.
  case_id?: number | null
  case_node?: string | null
  // Druh akce, cíl, parametry a odložení (0084); bez migrace chybí.
  action_type?: string | null
  target_table?: string | null
  target_id?: number | null
  params?: unknown
  snoozed_until?: string | null
  snoozed_by?: string | null
}

export type RawDecision = {
  id: number
  question: string
  options: unknown
  created_at: string
  case_title: string | null
  evidence_link: string | null
  // Volitelné kvůli zpětné kompatibilitě tvaru (odkaz „Otevřít případ").
  case_id?: number | null
}

export type ApprovalItem = RawApproval & { ageDays: number; expired: boolean }
export type DecisionItem = Omit<RawDecision, 'options'> & { options: string[]; ageDays: number }

export type InboxResult =
  | { state: 'missing_migration' }
  | { state: 'error'; message: string }
  | { state: 'ok'; approvals: ApprovalItem[]; decisions: DecisionItem[] }

const DAY_MS = 86_400_000

/** Chyba „tabulka neexistuje" z Postgresu (42P01) nebo PostgRESTu (PGRST205). */
export function isMissingRelation(err: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!err) return false
  if (err.code === '42P01' || err.code === 'PGRST205') return true
  return /relation .* does not exist|could not find the table/i.test(err.message ?? '')
}

/** Sloupec neexistuje (42703) — např. approval_request.node před migrací 0057. */
export function isMissingColumn(err: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!err) return false
  if (err.code === '42703') return true
  return /column .* does not exist/i.test(err.message ?? '')
}

// --- Snímek uzlu schvalovacího požadavku (0057) ----------------------------
//
// Od 0057 nese approval_request.node uzel případu z okamžiku žádosti
// a decide_approval rozhoduje podle něj (ne podle aktuálního uzlu případu,
// který se mohl mezitím změnit). Před 0057 sloupec neexistuje → spadneme
// na aktuální uzel případu (stejně jako tehdy SQL z 0053). Řádek bez uzlu
// (požadavek bez případu) = rozhoduje jen vedení.
export function approvalNodeOf(
  row: { node?: string | null },
  caseNode: string | null | undefined,
): string | null {
  if ('node' in row) return row.node ?? null
  return caseNode ?? null
}

// --- Chyby triggerů 0057 → česká hláška -------------------------------------
//
// Triggery work_case_guard / case_step_guard a request_approval vyhazují
// stabilní SQLSTATE (LP001–LP007, viz hlavička 0057_loop_core_hardening.sql).
// Mapujeme podle kódu, ne podle textu. test/loop-hardening.test.ts hlídá, že
// každý kód z migrace má tady hlášku.
export const LOOP_GUARD_MESSAGES: Readonly<Record<string, string>> = {
  LP001: 'Tento přechod stavu případu není povolený. Obnovte stránku.',
  LP002: 'Tento přechod stavu kroku není povolený. Obnovte stránku.',
  LP003: 'Případ zatím nejde uzavřít: všechny kroky musí být hotové nebo přeskočené a aspoň jeden hotový.',
  LP004: 'Případ je uzavřený, už se nemění.',
  LP005: 'Vlastníka, zástupce nebo uzel případu smí změnit jen vedení, vlastník případu nebo vlastník uzlu.',
  LP006: 'Autora případu nelze nastavit ani změnit.',
  LP007: 'Krok nelze přesunout do jiného případu.',
}

export function loopGuardErrorMessage(
  err: { code?: string | null; message?: string | null } | null | undefined,
): string | null {
  if (!err?.code) return null
  return LOOP_GUARD_MESSAGES[err.code] ?? null
}

function ageDays(iso: string, now: Date): number {
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return 0
  return Math.max(0, Math.floor((now.getTime() - t) / DAY_MS))
}

function byOldest(a: { created_at: string }, b: { created_at: string }): number {
  return Date.parse(a.created_at) - Date.parse(b.created_at)
}

/** Nejstarší nahoře; vypršelé (expires_at <= now) označené. */
export function shapeApprovals(rows: readonly RawApproval[], now: Date): ApprovalItem[] {
  return [...rows].sort(byOldest).map((r) => ({
    ...r,
    ageDays: ageDays(r.created_at, now),
    expired: r.expires_at != null && Date.parse(r.expires_at) <= now.getTime(),
  }))
}

/** Nejstarší nahoře; options normalizované na seznam textů. */
export function shapeDecisions(rows: readonly RawDecision[], now: Date): DecisionItem[] {
  return [...rows].sort(byOldest).map((r) => ({
    ...r,
    options: Array.isArray(r.options)
      ? r.options.map((o) => (typeof o === 'string' ? o : JSON.stringify(o)))
      : [],
    ageDays: ageDays(r.created_at, now),
  }))
}

type Joined<T> = T | T[] | null
const one = <T,>(v: Joined<T>): T | null => (Array.isArray(v) ? (v[0] ?? null) : v)

/** Sloupce druhu akce a odložení (0084); před migrací je dotaz vynechá. */
export const APPROVAL_ACTION_COLUMNS = ' action_type, target_table, target_id, params, snoozed_until, snoozed_by,'

/** Klient databáze; výchozí session přihlášeného (RLS). Provozní přehled pro cron předá service role. */
type Db = Awaited<ReturnType<typeof createClient>>

export async function getDecisionInbox(now: Date = new Date(), db?: Db): Promise<InboxResult> {
  const supabase = db ?? await createClient()
  const approvalsQuery = (cols: string) =>
    supabase
      .from('approval_request')
      .select(
        `id, case_id,${cols} action_kind, requested_level, requested_by, created_at, expires_at, work_case(title, node)`,
      )
      .eq('status', 'pending')
      .order('created_at', { ascending: true })
      .limit(200)
  const [arFull, dr] = await Promise.all([
    approvalsQuery(` node,${APPROVAL_ACTION_COLUMNS}`),
    supabase
      .from('decision')
      .select('id, question, options, created_at, case_id, work_case(title), evidence(web_link)')
      .is('decided_at', null)
      .order('created_at', { ascending: true })
      .limit(200),
  ])
  // Před 0084 chybí sloupce akce, před 0057 i approval_request.node → dotaz bez nich.
  let ar = arFull
  if (isMissingColumn(ar.error)) ar = await approvalsQuery(' node,')
  if (isMissingColumn(ar.error)) ar = await approvalsQuery('')
  if (isMissingRelation(ar.error) || isMissingRelation(dr.error)) return { state: 'missing_migration' }
  const err = ar.error ?? dr.error
  if (err) return { state: 'error', message: err.message }

  type A = Omit<RawApproval, 'case_title' | 'case_node'> & {
    node?: string | null
    work_case: Joined<{ title: string; node: string }>
  }
  type D = Omit<RawDecision, 'case_title' | 'evidence_link'> & {
    work_case: Joined<{ title: string }>
    evidence: Joined<{ web_link: string | null }>
  }
  const approvals = ((ar.data ?? []) as unknown as A[]).map((row) => {
    const { work_case, ...r } = row
    return {
      ...r,
      case_title: one(work_case)?.title ?? null,
      // Uzel, podle kterého rozhoduje SQL: snímek z žádosti (0057).
      case_node: approvalNodeOf(row, one(work_case)?.node),
    }
  })
  const decisions = ((dr.data ?? []) as unknown as D[]).map(({ work_case, evidence, ...r }) => ({
    ...r,
    case_title: one(work_case)?.title ?? null,
    evidence_link: one(evidence)?.web_link ?? null,
  }))
  return {
    state: 'ok',
    approvals: shapeApprovals(approvals, now),
    decisions: shapeDecisions(decisions, now),
  }
}

// ---------------------------------------------------------------------------
// Pracovní případy (/pripady). Stejně jako inbox: chybějící tabulky 0039 =
// stav 'missing_migration', ne výjimka.

type Loaded<T> = { state: 'missing_migration' } | { state: 'error'; message: string } | ({ state: 'ok' } & T)

/** Obsazení uzlů (loop_node) se stavem migrace. */
export async function getLoopNodesResult(): Promise<Loaded<{ nodes: LoopNodeRow[] }>> {
  const supabase = await createClient()
  const { data, error } = await supabase.from('loop_node').select('node, owner_id, deputy_id')
  if (isMissingRelation(error)) return { state: 'missing_migration' }
  if (error) return { state: 'error', message: error.message }
  return { state: 'ok', nodes: (data ?? []) as LoopNodeRow[] }
}

/** Obsazení uzlů; bez migrace nebo při chybě prázdné pole (→ nikdo není vlastník uzlu). */
export async function getLoopNodes(): Promise<LoopNodeRow[]> {
  const r = await getLoopNodesResult()
  return r.state === 'ok' ? r.nodes : []
}

/** Aktivní pravidla pravomoci (authority_policy) pro nápovědu ve formuláři. */
export async function getActivePolicies(): Promise<{ action_kind: string; level: string; active: boolean }[]> {
  const supabase = await createClient()
  const { data, error } = await supabase.from('authority_policy').select('action_kind, level, active').eq('active', true)
  if (error) return []
  return (data ?? []) as { action_kind: string; level: string; active: boolean }[]
}

export type WorkCaseListItem = {
  id: number
  title: string
  node: string
  status: string
  updated_at: string
  lead_owner_name: string | null
  account_id: number | null
  account_name: string | null
  steps_total: number
  steps_done: number
}

export type WorkCaseListResult = Loaded<{ cases: WorkCaseListItem[] }>

export async function listWorkCases(filter: CaseFilter): Promise<WorkCaseListResult> {
  const supabase = await createClient()
  let q = supabase
    .from('work_case')
    .select(
      'id, title, node, status, updated_at, account_id, lead_owner:team_member!work_case_lead_owner_id_fkey(full_name), account(name), case_step(status)',
    )
  if (filter.node) q = q.eq('node', filter.node)
  const statuses = statusesForFilter(filter.status)
  if (statuses) q = q.in('status', [...statuses])
  const { data, error } = await q.order('updated_at', { ascending: false }).limit(300)
  if (isMissingRelation(error)) return { state: 'missing_migration' }
  if (error) return { state: 'error', message: error.message }
  type Row = Omit<WorkCaseListItem, 'lead_owner_name' | 'account_name' | 'steps_total' | 'steps_done'> & {
    lead_owner: Joined<{ full_name: string | null }>
    account: Joined<{ name: string }>
    case_step: { status: string }[] | null
  }
  const cases = ((data ?? []) as unknown as Row[]).map(({ lead_owner, account, case_step, ...r }) => ({
    ...r,
    lead_owner_name: one(lead_owner)?.full_name ?? null,
    account_name: one(account)?.name ?? null,
    steps_total: case_step?.length ?? 0,
    steps_done: (case_step ?? []).filter((x) => x.status === 'done').length,
  }))
  return { state: 'ok', cases }
}

export type CaseStepRow = { id: number; position: number; title: string; status: string; due_at: string | null; created_at?: string }
export type CaseDecisionRow = {
  id: number
  question: string
  options: string[]
  chosen: string | null
  decided_by: string | null
  decided_at: string | null
  created_at: string
}
export type CaseApprovalRow = {
  id: number
  action_kind: string
  requested_level: string
  status: string
  requested_by: string
  decided_by: string | null
  decided_at: string | null
  expires_at: string | null
  decision_note: string | null
  created_at: string
  // 0084: druh akce a parametry; bez migrace chybí.
  action_type?: string | null
  params?: unknown
}
export type WorkCaseDetail = {
  id: number
  title: string
  node: string
  status: string
  created_at: string
  updated_at: string
  created_by: string | null
  lead_owner_id: string | null
  lead_owner_name: string | null
  /** Zástupce (jen id; jméno je v deputy_name). Chybí v datech starších než tahle verze dotazu. */
  deputy_id?: string | null
  deputy_name: string | null
  account_id: number | null
  account_name: string | null
  deal_id: number | null
  deal_title: string | null
  deal_account_id: number | null
}

export type WorkCaseDetailResult =
  | Loaded<{
      case: WorkCaseDetail
      steps: CaseStepRow[]
      decisions: CaseDecisionRow[]
      approvals: CaseApprovalRow[]
      /** Výsledky provedení žádostí případu (0084); bez migrace prázdné. */
      executions: ApprovalExecution[]
    }>
  | { state: 'not_found' }

/**
 * Detail případu. S `includeDeal` (obchodní role, volající ověří
 * canCurrentUserSeeSales) se obchod embeduje z tabulky deal. Ostatním
 * (projekťák, lektor, partner — od 0058 na deal nevidí) se název navázaného
 * obchodu doplní z rpc deal_public: jen název, žádné částky ani fáze.
 * Rozhodnutí: název obchodu u případu smí vidět každý člen týmu, protože
 * případ na něj odkazuje a dodávka bez něj ztrácí kontext; odkaz na detail
 * obchodu dostanou jen obchodní role (stránka). Když deal_public selže,
 * název je null a detail případu se načte dál.
 */
export async function getWorkCase(id: number, opts: { includeDeal?: boolean } = {}): Promise<WorkCaseDetailResult> {
  const supabase = await createClient()
  const caseApprovals = (cols: string) =>
    supabase
      .from('approval_request')
      .select(`id,${cols} action_kind, requested_level, status, requested_by, decided_by, decided_at, expires_at, decision_note, created_at`)
      .eq('case_id', id)
      .order('created_at', { ascending: false })
  const [cr, sr, dr, arFull] = await Promise.all([
    supabase
      .from('work_case')
      .select(
        'id, title, node, status, created_at, updated_at, created_by, lead_owner_id, deputy_id, account_id, deal_id, ' +
          'lead_owner:team_member!work_case_lead_owner_id_fkey(full_name), ' +
          'deputy:team_member!work_case_deputy_id_fkey(full_name), account(name)' +
          (opts.includeDeal ? ', deal(title, account_id)' : ''),
      )
      .eq('id', id)
      .maybeSingle(),
    supabase.from('case_step').select('id, position, title, status, due_at, created_at').eq('case_id', id).order('position').order('id'),
    supabase
      .from('decision')
      .select('id, question, options, chosen, decided_by, decided_at, created_at')
      .eq('case_id', id)
      .order('created_at', { ascending: true }),
    caseApprovals(' action_type, params,'),
  ])
  // Před 0084 sloupce akce chybí → bez nich (žádosti jsou pak jen záznam).
  const ar = isMissingColumn(arFull.error) ? await caseApprovals('') : arFull
  const errs = [cr.error, sr.error, dr.error, ar.error]
  if (errs.some(isMissingRelation)) return { state: 'missing_migration' }
  const err = errs.find(Boolean)
  if (err) return { state: 'error', message: err.message }
  if (!cr.data) return { state: 'not_found' }

  type C = Omit<WorkCaseDetail, 'lead_owner_name' | 'deputy_name' | 'account_name' | 'deal_title' | 'deal_account_id'> & {
    lead_owner: Joined<{ full_name: string | null }>
    deputy: Joined<{ full_name: string | null }>
    account: Joined<{ name: string }>
    deal?: Joined<{ title: string; account_id: number }>
  }
  const { lead_owner, deputy, account, deal = null, ...c } = cr.data as unknown as C
  let dealTitle = one(deal)?.title ?? null
  let dealAccountId = one(deal)?.account_id ?? null
  if (!opts.includeDeal && c.deal_id !== null) {
    const pub = await findDealPublic(supabase, c.account_id, c.deal_id)
    if (pub.ok && pub.row) {
      dealTitle = pub.row.title
      dealAccountId = pub.row.account_id
    }
  }
  type D = Omit<CaseDecisionRow, 'options'> & { options: unknown }
  const approvals = (ar.data ?? []) as unknown as CaseApprovalRow[]
  const executions = await getApprovalExecutions(approvals.filter((a) => a.action_type).map((a) => a.id))
  return {
    state: 'ok',
    case: {
      ...c,
      lead_owner_name: one(lead_owner)?.full_name ?? null,
      deputy_name: one(deputy)?.full_name ?? null,
      account_name: one(account)?.name ?? null,
      deal_title: dealTitle,
      deal_account_id: dealAccountId,
    },
    steps: (sr.data ?? []) as CaseStepRow[],
    decisions: ((dr.data ?? []) as unknown as D[]).map((d) => ({
      ...d,
      options: Array.isArray(d.options) ? d.options.map((o) => (typeof o === 'string' ? o : JSON.stringify(o))) : [],
    })),
    approvals,
    executions,
  }
}

const EXECUTION_COLUMNS = 'request_id, status, request_status, result, attempts, executed_by, executed_at'

/**
 * Výsledky provedení (approval_execution, 0084) pro dané žádosti. Bez migrace
 * nebo při chybě prázdné pole — stránka pak ukáže žádosti bez výsledku.
 */
export async function getApprovalExecutions(requestIds: readonly number[]): Promise<ApprovalExecution[]> {
  if (requestIds.length === 0) return []
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('approval_execution')
    .select(EXECUTION_COLUMNS)
    .in('request_id', [...requestIds])
  if (error) return []
  return (data ?? []) as ApprovalExecution[]
}

/**
 * Obchody pro výběr ve formuláři nového případu. Obchod je obchodní údaj:
 * kdo nevidí Byznys (canCurrentUserSeeSales), nedostane nic a na tabulku
 * deal se vůbec nesahá.
 */
export async function listCaseDealOptions(): Promise<{ id: number; title: string; account_id: number }[]> {
  if (!(await canCurrentUserSeeSales())) return []
  const s = await createClient()
  const { data, error } = await s.from('deal').select('id, title, account_id').order('title').limit(1000)
  if (error) throw error
  return (data ?? []) as { id: number; title: string; account_id: number }[]
}

// ---------------------------------------------------------------------------
// Návrhy případů (case_proposal, migrace 0067) — výstup schopností Loop Core
// (kapitola 11, core/agents/). Jen čtení; přijetí/zamítnutí jde přes RPC
// (core/actions/caseProposals.ts). Chybějící tabulka = 'missing_migration'.

export type CaseProposalItem = {
  id: number
  capability: string
  node: string
  title: string
  rationale: string
  method: string
  occurred_at: string
  created_at: string
  account_id: number | null
  account_name: string | null
  evidence_link: string | null
}

export type CaseProposalListResult = Loaded<{ proposals: CaseProposalItem[] }>

export async function listPendingProposals(): Promise<CaseProposalListResult> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('case_proposal')
    .select('id, capability, node, title, rationale, method, occurred_at, created_at, account_id, account(name), evidence(web_link)')
    .eq('status', 'pending')
    .order('created_at', { ascending: false })
    .limit(200)
  if (isMissingRelation(error)) return { state: 'missing_migration' }
  if (error) return { state: 'error', message: error.message }
  type Row = Omit<CaseProposalItem, 'account_name' | 'evidence_link'> & {
    account: Joined<{ name: string }>
    evidence: Joined<{ web_link: string | null }>
  }
  const proposals = ((data ?? []) as unknown as Row[]).map(({ account, evidence, ...r }) => ({
    ...r,
    account_name: one(account)?.name ?? null,
    evidence_link: one(evidence)?.web_link ?? null,
  }))
  return { state: 'ok', proposals }
}

/** Počet čekajících návrhů pro záložku; null = nejde zjistit (např. bez migrace 0067). */
export async function countPendingProposals(db?: Db): Promise<number | null> {
  const supabase = db ?? await createClient()
  const { count, error } = await supabase
    .from('case_proposal')
    .select('id', { count: 'exact', head: true })
    .eq('status', 'pending')
  if (error) return null
  return count ?? 0
}

export type CaseOrigin = {
  capability: string
  method: string
  rationale: string
  created_at: string
  evidence_link: string | null
}

/** Z jakého návrhu případ vznikl (detail případu); null = založený ručně nebo bez migrace 0067. */
export async function getCaseOrigin(caseId: number): Promise<CaseOrigin | null> {
  const supabase = await createClient()
  const { data, error } = await supabase
    .from('case_proposal')
    .select('capability, method, rationale, created_at, evidence(web_link)')
    .eq('work_case_id', caseId)
    .maybeSingle()
  if (error || !data) return null
  const { evidence, ...r } = data as unknown as Omit<CaseOrigin, 'evidence_link'> & {
    evidence: Joined<{ web_link: string | null }>
  }
  return { ...r, evidence_link: one(evidence)?.web_link ?? null }
}
