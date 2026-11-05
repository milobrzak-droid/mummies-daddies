// Pravomoc per činnost (L1–L4) a schvalovací požadavek (Loop Core,
// kapitola 7 cílové architektury). Čisté funkce bez I/O.
//
//   L1  čte a hlásí                     — nic nevytváří, schválení netřeba
//   L2  připraví ke schválení           — návrh, o kterém rozhodne člověk
//   L3  provede schválený vratný krok
//   L4  provádí ohraničený postup
//
// Pravidla činnost → úroveň žijí v tabulce authority_policy (0039) jako data:
// změna pravomoci = UPDATE řádku, žádný deploy. Hodnoty LEVELS a
// APPROVAL_STATUSES musí sedět s CHECKy v migraci (test to hlídá).

export const LEVELS = ['L1', 'L2', 'L3', 'L4'] as const
export type Level = (typeof LEVELS)[number]

export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'expired'] as const
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number]

// Činnost, pro kterou cílový dokument výslovně určuje výchozí L2.
export const EXTERNAL_COMMITMENT = 'external_commitment'

// Výchozí úroveň, když pro činnost není aktivní pravidlo. L2 — „neznámá
// situace snižuje pravomoc, nikoli naopak": bez pravidla systém nic sám
// neprovede, jen připraví ke schválení.
export const DEFAULT_LEVEL: Level = 'L2'

export const isLevel = (v: unknown): v is Level =>
  typeof v === 'string' && (LEVELS as readonly string[]).includes(v)

export const isApprovalStatus = (v: unknown): v is ApprovalStatus =>
  typeof v === 'string' && (APPROVAL_STATUSES as readonly string[]).includes(v)

export function levelRank(l: Level): number {
  return LEVELS.indexOf(l) + 1
}

export function minLevel(a: Level, b: Level): Level {
  return levelRank(a) <= levelRank(b) ? a : b
}

export interface AuthorityPolicy {
  action_kind: string
  level: string
  active: boolean
}

// Úroveň pravomoci pro činnost.
// - Bere jen aktivní pravidla s platnou úrovní (neplatná data = jako by
//   pravidlo nebylo → výchozí L2, ne výjimka ani vyšší pravomoc).
// - Víc aktivních pravidel pro jednu činnost DB nedovolí (částečný unikátní
//   index); kdyby přesto přišla (např. ruční data), vyhrává NEJNIŽŠÍ úroveň.
// - Bez pravidla: L2. Platí i pro external_commitment, tj. seed v migraci
//   a tahle funkce dávají tentýž výsledek i při smazaném seedu.
export function requiredLevel(policies: readonly AuthorityPolicy[], actionKind: string): Level {
  let found: Level | null = null
  for (const p of policies) {
    if (!p.active || p.action_kind !== actionKind || !isLevel(p.level)) continue
    found = found === null ? p.level : minLevel(found, p.level)
  }
  return found ?? DEFAULT_LEVEL
}

// Potřebuje činnost na dané úrovni lidské schválení, než se provede?
// L1 ne (jen čte a hlásí). L2 vždy. L3/L4 provádí krok v mezích pravidel,
// ale samotné udělení L3/L4 (změnu politiky) schvaluje člověk — viz
// canActorApprove.
export function needsApproval(level: Level): boolean {
  return level === 'L2'
}

// --- Schvalovací požadavek ---------------------------------------------

// pending → approved | rejected | expired. Vše ostatní konečné.
const APPROVAL_TRANSITIONS: Record<ApprovalStatus, readonly ApprovalStatus[]> = {
  pending: ['approved', 'rejected', 'expired'],
  approved: [],
  rejected: [],
  expired: [],
}

export function canTransitionApproval(from: ApprovalStatus, to: ApprovalStatus): boolean {
  return APPROVAL_TRANSITIONS[from].includes(to)
}

export function isTerminalApproval(s: ApprovalStatus): boolean {
  return APPROVAL_TRANSITIONS[s].length === 0
}

export interface ApprovalRequestState {
  status: ApprovalStatus
  requested_level: Level
  requested_by: string
  expires_at: Date | null
}

export type ApprovalOutcome =
  | { ok: true; status: ApprovalStatus }
  | { ok: false; reason: string }

// Rozhodnutí o požadavku. Pořadí kontrol:
// 1) konečný stav se nemění,
// 2) po expiraci už nejde schválit ani zamítnout → výsledek je expired,
// 3) čtyři oči: žadatel si sám nerozhoduje (odpovídá CHECKu v DB),
// 4) role musí na úroveň stačit (canActorApprove).
export function decideApproval(
  req: ApprovalRequestState,
  decision: 'approved' | 'rejected',
  actor: { id: string; role: string },
  now: Date,
): ApprovalOutcome {
  if (isTerminalApproval(req.status)) {
    return { ok: false, reason: `požadavek je už ${req.status}` }
  }
  if (req.expires_at !== null && now.getTime() >= req.expires_at.getTime()) {
    return { ok: true, status: 'expired' }
  }
  if (actor.id === req.requested_by) {
    return { ok: false, reason: 'žadatel nesmí rozhodovat o vlastním požadavku' }
  }
  if (!canActorApprove(req.requested_level, actor.role)) {
    return { ok: false, reason: `role ${actor.role} nesmí schvalovat ${req.requested_level}` }
  }
  return { ok: true, status: decision }
}

// Má čekající požadavek vypršet?
export function shouldExpire(req: Pick<ApprovalRequestState, 'status' | 'expires_at'>, now: Date): boolean {
  return req.status === 'pending' && req.expires_at !== null && now.getTime() >= req.expires_at.getTime()
}

// --- Model rolí pro schvalování -----------------------------------------
//
// ROZHODNUTO vlastníkem 2026-09-28 (už ne placeholder):
//
//   vedeni       — vedení firmy (team_member.role = 'vedeni'): L1–L4
//   node_owner   — vlastník uzlu (loop_node.owner_id): L1–L4
//   node_deputy  — zástupce uzlu (loop_node.deputy_id): L1–L2
//   member       — řadový člen: jen L1
//   system       — stroj/agent: nikdy nic (systém si sám neschvaluje)
//   cokoli jiného — nic (neznámá role snižuje pravomoc)
//
// Obsazení uzlů je data v tabulce loop_node (0039); k 2026-09-28 drží
// všechny čtyři uzly Viktor, zástupci prázdní. Roli aktéra pro konkrétní uzel
// odvozuje nodeRoleFor.
export const APPROVER_ROLES = ['vedeni', 'node_owner', 'node_deputy', 'member', 'system'] as const
export type ApproverRole = (typeof APPROVER_ROLES)[number]

const MAX_APPROVABLE: Record<ApproverRole, Level | null> = {
  vedeni: 'L4',
  node_owner: 'L4',
  node_deputy: 'L2',
  member: 'L1',
  system: null,
}

export function canActorApprove(level: Level, actorRole: string): boolean {
  if (!isLevel(level)) return false
  if (!(APPROVER_ROLES as readonly string[]).includes(actorRole)) return false
  const max = MAX_APPROVABLE[actorRole as ApproverRole]
  return max !== null && levelRank(level) <= levelRank(max)
}

// Řádek tabulky loop_node (0039).
export interface LoopNodeRow {
  node: string
  owner_id: string | null
  deputy_id: string | null
}

// Role člena týmu pro daný uzel. Čistá funkce nad dodanými řádky loop_node.
// Pořadí: vlastník uzlu → node_owner, zástupce → node_deputy, team role
// 'vedeni' → vedeni, jinak member. memberId je team_member.id (uuid, bez
// prefixu 'user:'). Prázdné memberId nikdy nesedí na NULL vlastníka.
// Víc řádků pro týž uzel DB nedovolí (PK); kdyby přišly, stačí shoda
// v kterémkoli z nich.
export function nodeRoleFor(
  member: { id: string; teamRole: string | null },
  node: string,
  rows: readonly LoopNodeRow[],
): ApproverRole {
  const nodeRows = member.id ? rows.filter((r) => r.node === node) : []
  if (nodeRows.some((r) => r.owner_id === member.id)) return 'node_owner'
  if (nodeRows.some((r) => r.deputy_id === member.id)) return 'node_deputy'
  if (member.teamRole === 'vedeni') return 'vedeni'
  return 'member'
}
