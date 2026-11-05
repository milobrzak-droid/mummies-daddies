// Pracovní případ a jeho kroky (Loop Core, kapitola 7 cílové architektury).
// Čisté funkce bez I/O — žádný import z lib/, domain/, connectors/, worker/;
// hodnoty konkrétní firmy jen z @/config.
//
// Hodnoty NODES / CASE_STATUSES / STEP_STATUSES musí sedět s CHECKy v migraci
// 0039_loop_core.sql. Test v test/work-case.test.ts čte migraci a hlídá to.
import { COMPANY } from '@/config'

// Vedoucí uzly (kompetence) jsou konfigurace firmy (config/, kapitola 11).
// Obsazení (vlastník, zástupce) je data v tabulce loop_node (0039) — tady
// jen identifikátory.
export const NODES = COMPANY.nodes
export type Node = (typeof NODES)[number]

export const CASE_STATUSES = ['open', 'in_progress', 'waiting', 'done', 'cancelled'] as const
export type CaseStatus = (typeof CASE_STATUSES)[number]

export const STEP_STATUSES = ['todo', 'doing', 'blocked', 'done', 'skipped'] as const
export type StepStatus = (typeof STEP_STATUSES)[number]

function member<T extends string>(list: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (list as readonly string[]).includes(value)
}

export const isNode = (v: unknown): v is Node => member(NODES, v)
export const isCaseStatus = (v: unknown): v is CaseStatus => member(CASE_STATUSES, v)
export const isStepStatus = (v: unknown): v is StepStatus => member(STEP_STATUSES, v)

// Přechody případu. Co tu není, je zakázané.
// - done a cancelled jsou konečné: znovuotevření = nový případ (historie
//   zůstane čitelná, odpovědnost se neztratí v přepsaném řádku).
// - open → done je zakázané: hotovo má projít prací (in_progress).
// - waiting = čeká na klienta/jiný uzel; vrací se do in_progress.
const CASE_TRANSITIONS: Record<CaseStatus, readonly CaseStatus[]> = {
  open: ['in_progress', 'waiting', 'cancelled'],
  in_progress: ['waiting', 'done', 'cancelled'],
  waiting: ['in_progress', 'cancelled'],
  done: [],
  cancelled: [],
}

// Přechody kroku. done a skipped jsou konečné; blocked se odblokuje do doing.
const STEP_TRANSITIONS: Record<StepStatus, readonly StepStatus[]> = {
  todo: ['doing', 'blocked', 'skipped'],
  doing: ['todo', 'blocked', 'done'],
  blocked: ['doing', 'skipped'],
  done: [],
  skipped: [],
}

export function canTransitionCase(from: CaseStatus, to: CaseStatus): boolean {
  return CASE_TRANSITIONS[from].includes(to)
}

export function canTransitionStep(from: StepStatus, to: StepStatus): boolean {
  return STEP_TRANSITIONS[from].includes(to)
}

export function nextCaseStatuses(from: CaseStatus): readonly CaseStatus[] {
  return CASE_TRANSITIONS[from]
}

export function nextStepStatuses(from: StepStatus): readonly StepStatus[] {
  return STEP_TRANSITIONS[from]
}

export function isTerminalCase(s: CaseStatus): boolean {
  return CASE_TRANSITIONS[s].length === 0
}

export function isTerminalStep(s: StepStatus): boolean {
  return STEP_TRANSITIONS[s].length === 0
}

export function assertCaseTransition(from: CaseStatus, to: CaseStatus): void {
  if (!canTransitionCase(from, to)) {
    throw new Error(`Nepovolený přechod případu: ${from} → ${to}`)
  }
}

export function assertStepTransition(from: StepStatus, to: StepStatus): void {
  if (!canTransitionStep(from, to)) {
    throw new Error(`Nepovolený přechod kroku: ${from} → ${to}`)
  }
}

// Důvody, proč případ nejde uzavřít jako done. Prázdné pole = lze.
// Případ je hotový, jen když: jde tam přechodem, všechny kroky jsou konečné
// (done/skipped) a aspoň jeden krok je done (případ, kde se všechno
// přeskočilo, není „hotový výsledek", ale zrušení).
export function caseCloseIssues(status: CaseStatus, steps: readonly { status: StepStatus }[]): string[] {
  const issues: string[] = []
  if (!canTransitionCase(status, 'done')) issues.push(`ze stavu ${status} nejde do done`)
  const open = steps.filter((s) => !isTerminalStep(s.status)).length
  if (open > 0) issues.push(`nedokončené kroky: ${open}`)
  if (steps.length > 0 && !steps.some((s) => s.status === 'done')) {
    issues.push('žádný krok není done')
  }
  return issues
}

export function canCloseCase(status: CaseStatus, steps: readonly { status: StepStatus }[]): boolean {
  return caseCloseIssues(status, steps).length === 0
}

// Vlastník a zástupce případu: oba volitelné (výchozí je vlastník uzlu z loop_node), ale nesmí to
// být tatáž osoba — odpovídá CHECKu work_case_deputy_differs.
export function ownershipIssues(leadOwnerId: string | null, deputyId: string | null): string[] {
  if (leadOwnerId !== null && deputyId !== null && leadOwnerId === deputyId) {
    return ['zástupce nesmí být vlastník']
  }
  return []
}
