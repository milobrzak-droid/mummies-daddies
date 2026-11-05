// Historie rozhodnutí pro stránku Ke schválení: naposledy vyřízené žádosti
// o schválení (schváleno, zamítnuto, vypršelo) a u typovaných žádostí (0084)
// i výsledek provedení. Jen čtení stejné tabulky jako inbox (approval_request)
// a approval_execution, stejná RLS; chyba nebo chybějící migrace = prázdná
// historie (případně bez výsledků), stránka kvůli ní nespadne.
import { createClient } from '@/lib/supabase/server'
import { getApprovalExecutions, isMissingColumn, isMissingRelation } from '@/core/loopQueries'
import type { ApprovalExecution } from '@/core/approvalActions'
import { logError } from '@/lib/log'

export type HistoryStatus = 'approved' | 'rejected' | 'expired'

export type HistoryItem = {
  id: number
  action_kind: string
  status: HistoryStatus
  decided_by: string | null
  decided_at: string
  case_id: number | null
  case_title: string | null
  // 0084: druh akce, parametry a výsledek provedení; bez migrace chybí.
  action_type?: string | null
  params?: unknown
  execution?: ApprovalExecution | null
}

type Joined<T> = T | T[] | null
const one = <T,>(v: Joined<T>): T | null => (Array.isArray(v) ? (v[0] ?? null) : v)

export async function getDecisionHistory(limit = 6): Promise<HistoryItem[]> {
  const s = await createClient()
  const query = (cols: string) =>
    s
      .from('approval_request')
      .select(`id, action_kind,${cols} status, decided_by, decided_at, case_id, work_case(title)`)
      .in('status', ['approved', 'rejected', 'expired'])
      .not('decided_at', 'is', null)
      .order('decided_at', { ascending: false })
      .limit(limit)
  let res = await query(' action_type, params,')
  if (isMissingColumn(res.error)) res = await query('')
  const { data, error } = res
  if (isMissingRelation(error)) return []
  if (error) {
    logError('query.decisionHistory', error)
    return []
  }
  type Row = Omit<HistoryItem, 'case_title' | 'execution'> & { work_case: Joined<{ title: string }> }
  const rows = ((data ?? []) as unknown as Row[]).map(({ work_case, ...r }) => ({ ...r, case_title: one(work_case)?.title ?? null }))
  const executions = await getApprovalExecutions(rows.filter((r) => r.action_type).map((r) => r.id))
  const byRequest = new Map(executions.map((e) => [e.request_id, e]))
  return rows.map((r) => ({ ...r, execution: byRequest.get(r.id) ?? null }))
}
