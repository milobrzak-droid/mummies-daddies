import { createClient } from '@/lib/supabase/server'
import { isMissingColumn, isMissingRelation } from '@/core/loopQueries'
import { logError } from '@/lib/log'
import { withEffectiveDue, type FinanceFilters, type FinancialRecordRow } from '@/domain/finance/records'

// Čtení finančních záznamů (0063). Tabulku vidí jen obchodní role (RLS
// sales_only); volající stránky to hlídají i v UI. Do aplikace 0063 vrací
// 'missing_migration' — stránky ukážou klidnou hlášku místo pádu.

export type RecordsResult =
  | { state: 'ok'; records: (FinancialRecordRow & { account_name: string | null })[] }
  | { state: 'missing_migration' }
  | { state: 'error' }

const BASE_COLS =
  'id, account_id, deal_id, engagement_id, milestone_id, kind, amount, currency, period_month, status, source, evidence_id, external_ref, note, created_at'
// Splatnost (0090) a doklad v iDokladu se splatností (0092). Před migrací
// sloupce chybí — čtení se pak zopakuje s méně sloupci (viz COLUMN_LADDER).
export const DUE_COL = 'due_on'
const IDOKLAD_COLS = 'idoklad_kind, idoklad_id, idoklad_due_on'
// Od nejúplnějšího výběru po základní: 0090 + 0092, jen 0090, jen 0092, žádná.
const COLUMN_LADDER = [
  `${BASE_COLS}, ${DUE_COL}, ${IDOKLAD_COLS}`,
  `${BASE_COLS}, ${DUE_COL}`,
  `${BASE_COLS}, ${IDOKLAD_COLS}`,
  BASE_COLS,
] as const

type Joined<T> = T | T[] | null
const one = <T,>(v: Joined<T>): T | null => (Array.isArray(v) ? v[0] ?? null : v)

export async function listFinancialRecords(f: FinanceFilters): Promise<RecordsResult> {
  const s = await createClient()
  const query = (cols: string) => {
    let q = s
      .from('financial_record')
      .select(`${cols}, account:account_id(name)`)
      .gte('period_month', `${f.from}-01`)
      .lte('period_month', `${f.to}-01`)
      .order('period_month', { ascending: false })
      .order('id', { ascending: false })
      .limit(2000)
    if (f.accountId) q = q.eq('account_id', f.accountId)
    if (f.currency) q = q.eq('currency', f.currency)
    return q
  }
  let { data, error } = await query(COLUMN_LADDER[0])
  for (let i = 1; isMissingColumn(error) && i < COLUMN_LADDER.length; i++) ({ data, error } = await query(COLUMN_LADDER[i]))
  if (isMissingRelation(error)) return { state: 'missing_migration' }
  if (error) {
    logError('query.financialRecords', error)
    return { state: 'error' }
  }
  type Row = FinancialRecordRow & { account: Joined<{ name: string }> }
  return {
    state: 'ok',
    records: ((data ?? []) as unknown as Row[]).map(({ account, ...r }) => ({
      ...withEffectiveDue(r),
      account_name: one(account)?.name ?? null,
    })),
  }
}

export async function listAccountFinancialRecords(accountId: number): Promise<RecordsResult> {
  const s = await createClient()
  const query = (cols: string) =>
    s.from('financial_record').select(cols).eq('account_id', accountId).neq('status', 'cancelled').limit(2000)
  let { data, error } = await query(COLUMN_LADDER[0])
  for (let i = 1; isMissingColumn(error) && i < COLUMN_LADDER.length; i++) ({ data, error } = await query(COLUMN_LADDER[i]))
  if (isMissingRelation(error)) return { state: 'missing_migration' }
  if (error) {
    logError('query.financialRecords', error)
    return { state: 'error' }
  }
  return { state: 'ok', records: ((data ?? []) as unknown as FinancialRecordRow[]).map((r) => ({ ...withEffectiveDue(r), account_name: null })) }
}

/** Milníky dodávky, které už mají nezrušený podklad k fakturaci. */
export async function getInvoicedMilestoneIds(
  engagementId: number,
): Promise<{ state: 'ok'; ids: number[] } | { state: 'missing_migration' } | { state: 'error' }> {
  const s = await createClient()
  const { data, error } = await s
    .from('financial_record')
    .select('milestone_id')
    .eq('engagement_id', engagementId)
    .eq('kind', 'invoiced')
    .neq('status', 'cancelled')
  if (isMissingRelation(error)) return { state: 'missing_migration' }
  if (error) {
    logError('query.financialRecords', error)
    return { state: 'error' }
  }
  const ids = ((data ?? []) as { milestone_id: number | null }[])
    .map((r) => r.milestone_id)
    .filter((v): v is number => v !== null)
  return { state: 'ok', ids }
}

/** Firmy do výběru ve formuláři. */
export async function listAccountOptions(): Promise<{ id: number; name: string }[]> {
  const s = await createClient()
  const { data, error } = await s.from('account').select('id, name').order('name').limit(2000)
  if (error) {
    logError('query.financialRecords.accounts', error)
    return []
  }
  return (data ?? []) as { id: number; name: string }[]
}
