// Schválení napojené na konkrétní akci (Loop Core, migrace 0084; revize stavu
// 29. 9. 2026, P1.5). Čisté funkce bez I/O: druhy akcí a jejich jediný povolený
// přechod, věty „co se stane po schválení / zamítnutí", výsledek provedení
// (completed / failed / needs_attention), odložení a překlad chyb RPC.
//
// Provádí databáze (approval_execute ve stejné transakci jako rozhodnutí);
// tady se jen čte a popisuje. Hodnoty firmy (uzel, hranice, názvy úkolů) jsou
// v config/ (COMPANY.approvalActions); SQL má jejich kopii ve funkci
// approval_action_settings — test/approval-executor-0084.test.ts je porovnává.
import { COMPANY } from '@/config'
import type { ApprovalActionsConfig } from './tenant'

export const APPROVAL_ACTION_MIGRATION = '0084'
export const APPROVAL_ACTION_PENDING_MESSAGE = 'Schválení s provedením čeká na migraci 0084.'

export const APPROVAL_ACTION_TYPES = ['confirm_next_step', 'send_offer'] as const
export type ApprovalActionType = (typeof APPROVAL_ACTION_TYPES)[number]

export const isApprovalActionType = (v: unknown): v is ApprovalActionType =>
  typeof v === 'string' && (APPROVAL_ACTION_TYPES as readonly string[]).includes(v)

/**
 * Cíl a jediný povolený přechod podle druhu akce. MUSÍ sedět s CHECK
 * approval_request_action_target v 0084 (test to hlídá).
 *   external = nevratná akce mimo Cockpit: executor ji NEPROVÁDÍ, jen připraví
 *   úkol pro člověka.
 */
export const APPROVAL_ACTIONS: Readonly<Record<ApprovalActionType, {
  label: string
  targetTable: 'work_case' | 'deal_scope_version'
  transition: string
  external: boolean
}>> = {
  confirm_next_step: {
    label: 'Potvrdit další krok',
    targetTable: 'work_case',
    transition: 'active>next_step_confirmed',
    external: false,
  },
  send_offer: {
    label: 'Odeslat nabídku klientovi',
    targetTable: 'deal_scope_version',
    transition: 'draft>send_approved',
    external: true,
  },
}

export const EXECUTION_STATUSES = ['completed', 'failed', 'needs_attention'] as const
export type ExecutionStatus = (typeof EXECUTION_STATUSES)[number]
export const EXECUTION_REQUEST_STATUSES = ['approved', 'rejected', 'expired'] as const
export type ExecutionRequestStatus = (typeof EXECUTION_REQUEST_STATUSES)[number]

/** Kódy v approval_execution.result.reason (0084) a jejich věta pro lidi. */
export const EXECUTION_REASON_TEXT: Readonly<Record<string, string>> = {
  case_missing: 'případ už neexistuje',
  case_closed: 'případ je uzavřený',
  params_changed: 'parametry žádosti nesedí s otiskem',
  assignee_inactive: 'řešitel už není aktivním členem týmu',
  version_missing: 'verze nabídky už neexistuje',
  version_not_draft: 'verze už není koncept',
  version_already_approved: 'verze už je schválená jinou žádostí',
  version_changed: 'obsah verze se od žádosti změnil',
  returned_to_owner: 'vráceno vlastníkovi s úkolem',
}

/** Kolikrát se neúspěšné provedení zkusí (denní úloha; shodně s expire_due_approvals v 0084). */
export const MAX_EXECUTION_ATTEMPTS = 3

export function approvalActionsConfig(): ApprovalActionsConfig | null {
  return (COMPANY as { approvalActions?: ApprovalActionsConfig | null }).approvalActions ?? null
}

/** Nastavení ve tvaru SQL kopie (approval_action_settings v 0084): snake_case. */
export function approvalSettingsJson(cfg: ApprovalActionsConfig) {
  return {
    confirm_next_step: { validity_days: cfg.confirmNextStep.validityDays },
    send_offer: {
      node: cfg.sendOffer.node,
      require_approval_from_czk: cfg.sendOffer.requireApprovalFromCzk,
      validity_days: cfg.sendOffer.validityDays,
      task_title: cfg.sendOffer.task.title,
      task_working_days: cfg.sendOffer.task.workingDays,
    },
    return_task: { working_days: cfg.returnTask.workingDays },
  }
}

// --- Parametry žádosti -------------------------------------------------------

export type NextStepParams = { title: string; assignee_id: string; due_on: string; decision_id: number | null }
export type OfferParams = { deal_id: number; version_id: number; version: number }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const posInt = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null)

export function nextStepParams(params: unknown): NextStepParams | null {
  if (!isObj(params)) return null
  const { title, assignee_id, due_on, decision_id } = params
  if (typeof title !== 'string' || typeof assignee_id !== 'string' || typeof due_on !== 'string') return null
  return { title, assignee_id, due_on, decision_id: posInt(decision_id) }
}

export function offerParams(params: unknown): OfferParams | null {
  if (!isObj(params)) return null
  const deal_id = posInt(params.deal_id)
  const version_id = posInt(params.version_id)
  const version = posInt(params.version)
  return deal_id && version_id && version ? { deal_id, version_id, version } : null
}

// --- Věty pro kartu -----------------------------------------------------------

/** 'YYYY-MM-DD' → '3. 10. 2026' (bez závislosti na časovém pásmu serveru). */
export function fmtDay(day: string | null | undefined): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(day ?? '')
  return m ? `${Number(m[3])}. ${Number(m[2])}. ${m[1]}` : '—'
}

const nameOf = (id: unknown, names: ReadonlyMap<string, string>): string =>
  (typeof id === 'string' && names.get(id)) || 'nepřiřazeno'

const workingDays = (n: number) => (n === 1 ? '1 pracovního dne' : `${n} pracovních dnů`)

export type ApprovalActionRef = { action_type?: string | null; params?: unknown }

/** Název žádosti pro lidi: druh akce, jinak čitelná činnost. */
export function approvalTitle(req: ApprovalActionRef & { action_kind?: string | null }, kindLabel: (k: string) => string): string {
  if (isApprovalActionType(req.action_type)) return APPROVAL_ACTIONS[req.action_type].label
  return kindLabel(req.action_kind ?? '')
}

/**
 * Co se stane po schválení a co po zamítnutí nebo vypršení. Žádost bez druhu
 * akce je jen záznam — to se říká rovnou.
 */
export function approvalConsequences(
  req: ApprovalActionRef,
  names: ReadonlyMap<string, string>,
  cfg: ApprovalActionsConfig | null = approvalActionsConfig(),
): { onApprove: string; onReject: string | null } {
  if (req.action_type === 'confirm_next_step') {
    const p = nextStepParams(req.params)
    return {
      onApprove: p
        ? `Po schválení se v případu založí krok „${p.title}“ a úkol s termínem ${fmtDay(p.due_on)} · řeší ${nameOf(p.assignee_id, names)}.`
        : 'Po schválení se v případu založí krok a úkol s termínem.',
      onReject: 'Když žádost zamítneš nebo vyprší, dostane vlastník případu úkol rozhodnout, jak dál.',
    }
  }
  if (req.action_type === 'send_offer') {
    const p = offerParams(req.params)
    const title = cfg?.sendOffer.task.title ?? APPROVAL_ACTIONS.send_offer.label
    const days = cfg ? ` do ${workingDays(cfg.sendOffer.task.workingDays)}` : ''
    return {
      onApprove: `Po schválení Cockpit nic neodešle: ${p ? `verze ${p.version}` : 'verze'} nabídky se označí jako schválená k odeslání a vlastník obchodu dostane úkol „${title}“${days}. Odesílá člověk.`,
      onReject: 'Když žádost zamítneš nebo vyprší, verze zůstane konceptem a vlastník obchodu dostane úkol ji upravit, nebo požádat znovu.',
    }
  }
  return { onApprove: 'Po schválení se nic samo neprovede, jen se zapíše, kdo co povolil.', onReject: null }
}

// --- Výsledek provedení ---------------------------------------------------------

export type ApprovalExecution = {
  request_id: number
  status: string
  request_status: string
  result: unknown
  attempts: number
  executed_by: string
  executed_at: string
}

export type ExecutionTone = 'done' | 'wait' | 'fail'

export type ExecutionSummary = { tone: ExecutionTone; label: string; text: string; canRetry: boolean }

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null)

/** Výsledek provedení pro lidi (karta, historie, časová osa případu). */
export function executionSummary(
  exec: ApprovalExecution,
  req: ApprovalActionRef,
  names: ReadonlyMap<string, string>,
  cfg: ApprovalActionsConfig | null = approvalActionsConfig(),
): ExecutionSummary {
  const r = isObj(exec.result) ? exec.result : {}
  const reason = str(r.reason)
  const who = nameOf(r.assignee_id, names)
  const due = str(r.due_on)
  if (exec.status === 'failed') {
    const code = str(r.sqlstate) ?? '?'
    const retry = exec.attempts < MAX_EXECUTION_ATTEMPTS
    return {
      tone: 'fail',
      label: 'Provedení selhalo',
      text: `Nic se nezapsalo (chyba ${code}, pokus ${exec.attempts} z ${MAX_EXECUTION_ATTEMPTS}).${retry ? ' Denní kontrola to zkusí znovu, nebo zkus hned.' : ' Další pokusy už automaticky nebudou.'}`,
      canRetry: true,
    }
  }
  if (exec.status === 'needs_attention') {
    return {
      tone: 'wait',
      label: 'Vyžaduje pozornost',
      text: `Schválená akce se neprovedla: ${EXECUTION_REASON_TEXT[reason ?? ''] ?? 'cíl se mezitím změnil'}. Úkol ke kontrole · řeší ${who}.`,
      canRetry: false,
    }
  }
  // completed
  if (exec.request_status === 'approved' && req.action_type === 'confirm_next_step') {
    const p = nextStepParams(req.params)
    return {
      tone: 'done',
      label: 'Provedeno',
      text: `Založen krok${p ? ` „${p.title}“` : ''} a úkol · řeší ${who}${due ? ` · do ${fmtDay(due)}` : ''}.`,
      canRetry: false,
    }
  }
  if (exec.request_status === 'approved' && req.action_type === 'send_offer') {
    const version = num(r.version) ?? offerParams(req.params)?.version ?? null
    const title = cfg?.sendOffer.task.title ?? APPROVAL_ACTIONS.send_offer.label
    return {
      tone: 'done',
      label: 'Schváleno k odeslání',
      text: `Verze${version ? ` ${version}` : ''} je schválená k odeslání; Cockpit nic neodeslal. Úkol „${title}“ · řeší ${who}${due ? ` · do ${fmtDay(due)}` : ''}.`,
      canRetry: false,
    }
  }
  if (reason === 'case_closed') {
    return { tone: 'done', label: 'Bez dalšího kroku', text: 'Případ je uzavřený, nic dalšího se nezakládalo.', canRetry: false }
  }
  if (reason === 'version_missing') {
    return { tone: 'done', label: 'Bez dalšího kroku', text: 'Verze nabídky už neexistuje, nic dalšího se nezakládalo.', canRetry: false }
  }
  return {
    tone: 'done',
    label: 'Vráceno vlastníkovi',
    text: `Úkol rozhodnout, jak dál · řeší ${who}.`,
    canRetry: false,
  }
}

// --- Odložení („Odložit do…" na serveru) -------------------------------------------

export const SNOOZE_CHOICES = { zitra: 1, tyden: 7 } as const
export type SnoozeChoice = keyof typeof SNOOZE_CHOICES | 'vratit'

const DAY_MS = 86_400_000

/**
 * Okamžik odložení podle volby; nejvýš minutu před koncem platnosti žádosti
 * (DB odložení za konec platnosti odmítne). null = „Vrátit" nebo už nejde
 * (žádost vyprší dřív než za hodinu).
 */
export function snoozeUntil(choice: SnoozeChoice, now: Date, expiresAt: string | null): Date | null {
  if (choice === 'vratit') return null
  const wanted = new Date(now.getTime() + SNOOZE_CHOICES[choice] * DAY_MS)
  if (!expiresAt) return wanted
  const limit = new Date(Date.parse(expiresAt) - 60_000)
  if (limit.getTime() - now.getTime() < 3_600_000) return null
  return wanted.getTime() > limit.getTime() ? limit : wanted
}

/** Je žádost právě odložená? */
export function isSnoozed(req: { snoozed_until?: string | null }, now: Date): boolean {
  return !!req.snoozed_until && Date.parse(req.snoozed_until) > now.getTime()
}

// --- Chyby RPC 0084 → česká věta ---------------------------------------------------

const RPC_MESSAGES: readonly [RegExp, string][] = [
  [/Neznámý druh akce/i, 'Neznámý druh akce.'],
  [/Chybí cíl žádosti/i, 'Chybí, čeho se žádost týká.'],
  [/Název kroku musí mít/i, 'Název kroku musí mít 1 až 300 znaků.'],
  [/Neplatné parametry kroku/i, 'Neplatné údaje kroku. Obnovte stránku.'],
  [/Řešitel kroku musí být aktivní člen týmu/i, 'Řešitel kroku musí být aktivní člen týmu.'],
  [/Termín kroku musí být/i, 'Termín kroku musí být od dneška nejvýš za rok.'],
  [/Rozhodnutí nepatří k tomuto případu/i, 'Vybrané rozhodnutí nepatří k tomuto případu.'],
  [/Platnost požadavku může být nejvýš/i, 'Platnost žádosti může být nejvýš 90 dní.'],
  [/Odeslání nabídky ke schválení posílá jen obchodní role/i, 'O schválení odeslání nabídky žádá jen člen s přístupem k obchodu.'],
  [/Odeslání nabídky schvaluje jen obchodní role/i, 'Odeslání nabídky schvaluje jen člen s přístupem k obchodu.'],
  [/Schválit k odeslání jde jen koncept/i, 'Schválit k odeslání jde jen koncept nabídky.'],
  [/už je schválená k odeslání/i, 'Tahle verze už je schválená k odeslání.'],
  [/Žádost o schválení této verze už čeká/i, 'Žádost o schválení této verze už čeká na rozhodnutí.'],
  [/Odložit smí jen/i, 'Odložit smí jen ten, kdo o žádosti může rozhodnout.'],
  [/Odložit jde jen do budoucna/i, 'Odložit jde jen do budoucna.'],
  [/Odložit jde nejvýš o 30 dní/i, 'Odložit jde nejvýš o 30 dní.'],
  [/Odložit jde nejvýš do konce platnosti/i, 'Odložit jde nejvýš do konce platnosti žádosti.'],
  [/Provedení není co opakovat/i, 'Tady není co opakovat — provedení už proběhlo.'],
  [/Zopakovat provedení smí/i, 'Zopakovat provedení smí žadatel, schvalovatel nebo vedení.'],
  [/approval_request_typed_kind/i, 'Tahle činnost se žádá vlastním formulářem (Potvrdit další krok / Odeslat nabídku).'],
]

/** Chyba z RPC 0084 → česká věta; null = neznámá (volající zkusí obecné mapování). */
export function approvalActionErrorMessage(err: { code?: string | null; message?: string | null } | null | undefined): string | null {
  if (!err) return null
  const msg = err.message ?? ''
  for (const [re, text] of RPC_MESSAGES) if (re.test(msg)) return text
  // Funkce z 0084 ještě neexistuje (PostgREST PGRST202, Postgres 42883).
  if ((err.code === 'PGRST202' || err.code === '42883') && /request_action_approval|snooze_approval|retry_approval_execution|expire_due_approvals/.test(msg)) {
    return APPROVAL_ACTION_PENDING_MESSAGE
  }
  return null
}
