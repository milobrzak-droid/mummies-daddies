// Pracovní případy v UI (Loop Core): šablony, české popisky, mapování chyb
// z RPC 0039 a pravidlo, kdo smí v inboxu vidět tlačítka Schválit/Zamítnout.
// Čisté funkce bez I/O — stejně jako workCase.ts a authority.ts.
import { canActorApprove, isLevel, nodeRoleFor, type LoopNodeRow } from './authority'
import { isCaseStatus, isNode, type CaseStatus, type Node, type StepStatus } from './workCase'
import type { CaseTemplate as TenantCaseTemplate } from './tenant'
import { addDaysToPragueDay, pragueDayOf } from '@/lib/pragueDate'
import { seesByznys } from '@/lib/domain'
import { COMPANY } from '@/config'

// --- Popisky --------------------------------------------------------------

// Popisky uzlů jsou konfigurace firmy (config/, kapitola 11).
export const NODE_LABELS: Readonly<Record<Node, string>> = COMPANY.nodeLabels

export const CASE_STATUS_LABELS: Record<CaseStatus, string> = {
  open: 'Otevřený',
  in_progress: 'Rozpracovaný',
  waiting: 'Čeká',
  done: 'Hotovo',
  cancelled: 'Zrušený',
}

export const STEP_STATUS_LABELS: Record<StepStatus, string> = {
  todo: 'K udělání',
  doing: 'Probíhá',
  blocked: 'Blokováno',
  done: 'Hotovo',
  skipped: 'Přeskočeno',
}

export const APPROVAL_STATUS_LABELS: Record<string, string> = {
  pending: 'Čeká',
  approved: 'Schváleno',
  rejected: 'Zamítnuto',
  expired: 'Vypršelo',
}

export const nodeLabel = (n: string): string => NODE_LABELS[n as Node] ?? n
export const caseStatusLabel = (s: string): string => CASE_STATUS_LABELS[s as CaseStatus] ?? s
export const stepStatusLabel = (s: string): string => STEP_STATUS_LABELS[s as StepStatus] ?? s
export const approvalStatusLabel = (s: string): string => APPROVAL_STATUS_LABELS[s] ?? s

// --- Filtr seznamu ---------------------------------------------------------

// 'active' = vše kromě done/cancelled (výchozí), 'all' = bez filtru stavu.
export type CaseStatusFilter = CaseStatus | 'active' | 'all'
export interface CaseFilter {
  node: Node | null
  status: CaseStatusFilter
}

export const ACTIVE_CASE_STATUSES: readonly CaseStatus[] = ['open', 'in_progress', 'waiting']

// Z query stringu; neznámé hodnoty tiše na výchozí (URL si může kdokoli upravit).
export function parseCaseFilter(sp: { node?: string | string[]; status?: string | string[] }): CaseFilter {
  const first = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)
  const node = first(sp.node)
  const status = first(sp.status)
  return {
    node: isNode(node) ? node : null,
    status: status === 'all' || status === 'active' || isCaseStatus(status) ? status : 'active',
  }
}

// Stavy pro .in('status', ...); null = bez omezení.
export function statusesForFilter(f: CaseStatusFilter): readonly CaseStatus[] | null {
  if (f === 'all') return null
  if (f === 'active') return ACTIVE_CASE_STATUSES
  return [f]
}

// --- Šablony --------------------------------------------------------------
//
// Šablona jen předvyplní kroky a otevřená rozhodnutí; případ je pak běžný
// případ. Seznam šablon je konfigurace firmy (config/, kapitola 11); další
// šablona = další položka tam, žádná změna schématu.

export type CaseTemplate = TenantCaseTemplate<Node>

export const CASE_TEMPLATES: readonly CaseTemplate[] = COMPANY.caseTemplates

export function findTemplate(id: string | null | undefined): CaseTemplate | null {
  if (!id) return null
  return CASE_TEMPLATES.find((t) => t.id === id) ?? null
}

// Řádky kroků pro insert do case_step; pozice od 1 v pořadí šablony.
export function templateStepRows(t: CaseTemplate, caseId: number) {
  return t.steps.map((title, i) => ({ case_id: caseId, position: i + 1, title, status: 'todo' as const }))
}

// Další pozice nového kroku (za poslední existující).
export function nextStepPosition(steps: readonly { position: number }[]): number {
  return steps.reduce((max, s) => Math.max(max, s.position), 0) + 1
}

// Možnosti rozhodnutí z textového pole: čárka nebo nový řádek, bez prázdných
// a bez duplicit, pořadí zachované.
export function parseOptions(raw: string): string[] {
  const out: string[] = []
  for (const part of raw.split(/[,\n]/)) {
    const v = part.trim()
    if (v && !out.includes(v)) out.push(v)
  }
  return out
}

// Konec pražského dne 'YYYY-MM-DD' jako okamžik (= půlnoc dne následujícího).
// Požadavek „platí do 30. 9." tak vyprší až po celém 30. 9. pražského času.
export function pragueDayEnd(day: string): Date {
  const next = addDaysToPragueDay(day, 1)
  for (const off of ['+02:00', '+01:00']) {
    const d = new Date(`${next}T00:00:00${off}`)
    if (pragueDayOf(d) === next && pragueDayOf(new Date(d.getTime() - 1)) === day) return d
  }
  return new Date(`${next}T00:00:00+01:00`)
}

// --- Aktér a výchozí vlastník -----------------------------------------------

// Aktér tak, jak ho razítkují RPC (loop_actor): 'user:<uuid>'.
export const actorOf = (userId: string): string => `user:${userId}`

// Čitelné jméno aktéra ('user:<uuid>' → jméno člena týmu, 'system:x' → systém).
export function actorName(actor: string | null | undefined, names: ReadonlyMap<string, string>): string {
  if (!actor) return '—'
  if (actor.startsWith('user:')) return names.get(actor.slice(5)) ?? 'neznámý uživatel'
  if (actor.startsWith('system:')) return `systém (${actor.slice(7)})`
  return actor
}

// Vlastník případu: zadaný, jinak vlastník uzlu z loop_node, jinak nikdo.
export function defaultLeadOwner(node: string, explicit: string | null, rows: readonly LoopNodeRow[]): string | null {
  if (explicit) return explicit
  return rows.find((r) => r.node === node)?.owner_id ?? null
}

// --- Kdo smí rozhodnout o schválení ----------------------------------------

export interface ApprovalViewer {
  id: string // team_member.id (uuid)
  teamRole: string | null
}

// Tlačítka Schválit/Zamítnout jen tomu, kdo: není žadatel (čtyři oči) a má
// pro uzel požadavku roli, která na úroveň stačí. case_node je snímek uzlu
// z žádosti (approval_request.node, 0057). Požadavek bez uzlu smí v SQL
// rozhodnout JEN vedeni (loop_approver_role_for_node) — ostatní nic, ani L1.
// Odeslání nabídky (0084) navíc jen obchodní role — nabídku jiná role nevidí
// (decide_approval to hlídá i v SQL). Stejné pravidlo platí pro „Odložit".
export function viewerCanDecide(
  req: { requested_by: string; requested_level: string; case_node?: string | null; action_type?: string | null },
  viewer: ApprovalViewer | null,
  rows: readonly LoopNodeRow[],
): boolean {
  if (!viewer?.id) return false
  if (req.requested_by === actorOf(viewer.id)) return false
  if (!isLevel(req.requested_level)) return false
  if (req.action_type === 'send_offer' && !seesByznys(viewer.teamRole)) return false
  if (!req.case_node) return viewer.teamRole === 'vedeni' && canActorApprove(req.requested_level, 'vedeni')
  const role = nodeRoleFor(viewer, req.case_node, rows)
  return canActorApprove(req.requested_level, role)
}

// --- Chyby z RPC 0039 → česká hláška ----------------------------------------
//
// RPC vyhazují RAISE EXCEPTION s českým textem a SQLSTATE; PostgREST je vrací
// jako { code, message }. Mapujeme podle textu (ten je stabilní v migraci)
// a kódu. null = neznámá chyba, volající ji zaloguje a vrátí obecnou hlášku.

export const MIGRATION_PENDING_MESSAGE = 'Pracovní případy čekají na migraci 0039.'

// 42501 bez známého textu = zamítnutí role/úrovně. 0039 ho z RPC nevrací
// (roli tam hlídá jen TS), migrace 0053 doplní kontrolu role v SQL.
export const APPROVAL_FORBIDDEN_MESSAGE = 'Nemáš oprávnění schválit tuto úroveň.'
export const DECISION_FORBIDDEN_MESSAGE = 'Nemáš oprávnění o tomto rozhodnutí rozhodnout.'

export function loopRpcErrorMessage(
  err: { code?: string | null; message?: string | null } | null | undefined,
  context: 'approval' | 'decision' = 'approval',
): string | null {
  if (!err) return null
  const msg = err.message ?? ''
  const code = err.code ?? ''
  if (/Vlastní požadavek/i.test(msg)) return 'Vlastní požadavek nemůžete schválit ani zamítnout (čtyři oči).'
  if (/už není čekající/i.test(msg)) return 'O požadavku už bylo rozhodnuto.'
  if (/vypršel/i.test(msg)) return 'Požadavek vypršel, už o něm nejde rozhodnout.'
  if (/Požadavek \d+ neexistuje/i.test(msg)) return 'Požadavek nebyl nalezen.'
  if (/Rozhodnutí \d+ neexistuje nebo už je rozhodnuté/i.test(msg)) return 'Rozhodnutí už je rozhodnuté nebo neexistuje.'
  if (/Chybí zvolená možnost/i.test(msg)) return 'Vyberte možnost.'
  // RPC 0053/0057 (decide_approval): úroveň mimo rozsah / chybí ano-zamítnout.
  if (/Neplatná úroveň/i.test(msg)) return 'Neplatná úroveň schválení (povolené jsou L1–L4).'
  if (/Chybí rozhodnutí/i.test(msg)) return 'Vyberte, zda požadavek schvalujete, nebo zamítáte.'
  if (/Platnost požadavku musí končit v budoucnu/i.test(msg)) return 'Platnost požadavku musí končit v budoucnu.'
  if (/AAL2/i.test(msg)) return 'Vyžadováno dvoufázové ověření.'
  if (/Nepřihlášený|Jen pro člena týmu/i.test(msg)) return 'Tuto akci může provést jen přihlášený člen týmu.'
  // Funkce/tabulka ještě neexistuje (migrace neběžela).
  if (code === 'PGRST202' || code === '42883' || code === '42P01' || code === 'PGRST205') return MIGRATION_PENDING_MESSAGE
  if (code === '42501') return context === 'decision' ? DECISION_FORBIDDEN_MESSAGE : APPROVAL_FORBIDDEN_MESSAGE
  if (code === '23514') return 'Neplatná hodnota.'
  return null
}
