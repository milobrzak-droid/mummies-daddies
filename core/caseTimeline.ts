// Časová osa pracovního případu (Loop Core): co se v případu stalo a kdy —
// založení, přidané kroky, rozhodnutí, žádosti o schválení a jejich výsledek
// provedení (approval_execution, 0084). Čistá funkce bez I/O nad řádky, které
// už načetl getWorkCase; nic nového se neukládá. Nejnovější nahoře.
import {
  APPROVAL_ACTIONS,
  executionSummary,
  isApprovalActionType,
  nextStepParams,
  offerParams,
  type ApprovalExecution,
  type ExecutionTone,
} from './approvalActions'
import { actorName } from './workCaseFlow'

export type TimelineTone = ExecutionTone | 'info' | 'idle'

export type TimelineEvent = {
  key: string
  at: string
  title: string
  detail: string | null
  tone: TimelineTone
}

type Input = {
  created_at: string
  created_by: string | null
  steps: readonly { id: number; title: string; created_at?: string }[]
  decisions: readonly { id: number; question: string; chosen: string | null; decided_by: string | null; decided_at: string | null; created_at: string }[]
  approvals: readonly {
    id: number
    action_kind: string
    action_type?: string | null
    params?: unknown
    status: string
    requested_by: string
    decided_by: string | null
    decided_at: string | null
    decision_note: string | null
    created_at: string
  }[]
  executions: readonly ApprovalExecution[]
}

/** Kroky založené do minuty od případu jsou součást založení (šablona), ne samostatná událost. */
const SAME_MOMENT_MS = 60_000

// Při stejném čase: výsledek provedení nad rozhodnutím, rozhodnutí nad žádostí.
const ORDER: Record<string, number> = { execution: 4, decided: 3, requested: 2, decision: 1, step: 1, case: 0 }

export function buildCaseTimeline(
  input: Input,
  names: ReadonlyMap<string, string>,
  kindLabel: (kind: string) => string,
): TimelineEvent[] {
  const events: (TimelineEvent & { order: number })[] = []
  const caseAt = Date.parse(input.created_at)
  const initialSteps = input.steps.filter((s) => !s.created_at || Date.parse(s.created_at) - caseAt < SAME_MOMENT_MS).length
  events.push({
    key: 'case',
    at: input.created_at,
    title: 'Případ založen',
    detail: `${actorName(input.created_by, names)}${initialSteps ? ` · ${initialSteps} ${initialSteps === 1 ? 'krok' : initialSteps < 5 ? 'kroky' : 'kroků'}` : ''}`,
    tone: 'idle',
    order: ORDER.case,
  })

  for (const s of input.steps) {
    if (!s.created_at || Date.parse(s.created_at) - caseAt < SAME_MOMENT_MS) continue
    events.push({ key: `step-${s.id}`, at: s.created_at, title: `Přidán krok „${s.title}“`, detail: null, tone: 'info', order: ORDER.step })
  }

  for (const d of input.decisions) {
    if (d.decided_at && d.chosen !== null) {
      events.push({
        key: `decision-${d.id}`,
        at: d.decided_at,
        title: `Rozhodnuto: ${d.question} → ${d.chosen}`,
        detail: actorName(d.decided_by, names),
        tone: 'done',
        order: ORDER.decision,
      })
    }
  }

  const byRequest = new Map(input.executions.map((e) => [e.request_id, e]))
  for (const a of input.approvals) {
    const typed = isApprovalActionType(a.action_type)
    const label = typed ? APPROVAL_ACTIONS[a.action_type as keyof typeof APPROVAL_ACTIONS].label : kindLabel(a.action_kind)
    const step = a.action_type === 'confirm_next_step' ? nextStepParams(a.params) : null
    const offer = a.action_type === 'send_offer' ? offerParams(a.params) : null
    const what = step ? ` „${step.title}“` : offer ? ` (verze ${offer.version})` : ''
    events.push({
      key: `approval-${a.id}`,
      at: a.created_at,
      title: `Žádost o schválení: ${label}${what}`,
      detail: `žádá ${actorName(a.requested_by, names)}`,
      tone: 'wait',
      order: ORDER.requested,
    })
    if (a.decided_at && a.status !== 'pending') {
      const verb = a.status === 'approved' ? 'Schváleno' : a.status === 'rejected' ? 'Zamítnuto' : 'Vypršelo bez rozhodnutí'
      const note = a.decision_note ? ` · „${a.decision_note}“` : ''
      events.push({
        key: `decided-${a.id}`,
        at: a.decided_at,
        title: `${verb}: ${label}${what}`,
        detail: a.status === 'expired' ? null : `${actorName(a.decided_by, names)}${note}`,
        tone: a.status === 'approved' ? 'done' : a.status === 'rejected' ? 'fail' : 'idle',
        order: ORDER.decided,
      })
    }
    const ex = byRequest.get(a.id)
    if (ex) {
      const sum = executionSummary(ex, a, names)
      events.push({ key: `execution-${a.id}`, at: ex.executed_at, title: sum.label, detail: sum.text, tone: sum.tone, order: ORDER.execution })
    }
  }

  return events
    .sort((x, y) => Date.parse(y.at) - Date.parse(x.at) || y.order - x.order)
    .map((e) => ({ key: e.key, at: e.at, title: e.title, detail: e.detail, tone: e.tone }))
}
