import { createClient } from '@/lib/supabase/server'
import { isMissingColumn, isMissingRelation } from '@/core/loopQueries'
import { logError } from '@/lib/log'
import {
  overdueInvoices,
  paidKeys,
  withEffectiveDue,
  type Currency,
  type FinancialRecordRow,
} from '@/domain/finance/records'

// Nezaplacené vyfakturované záznamy po splatnosti (0090). Čte je stránka
// Finance (karta se sytou barvou) a provozní přehled (sekce Riziko). Splatnost
// se hlídá napříč obdobími – proto vlastní dotaz mimo filtr měsíců –, úhrady
// (potvrzené Přijato se stejným číslem dokladu a firmou) se čtou zvlášť. Před
// migrací 0090 sloupec neexistuje: výsledek je 'missing_migration', ne pád.

export type OverdueRecord = FinancialRecordRow & { account_name: string | null; daysLate: number }

export type OverdueResult =
  | { state: 'ok'; rows: OverdueRecord[] }
  | { state: 'missing_migration' }
  | { state: 'error' }

type Db = Awaited<ReturnType<typeof createClient>>
type Joined<T> = T | T[] | null
const one = <T,>(v: Joined<T>): T | null => (Array.isArray(v) ? v[0] ?? null : v)

const COLS =
  'id, account_id, deal_id, engagement_id, milestone_id, kind, amount, currency, period_month, status, source, evidence_id, external_ref, note, created_at, due_on'
// Splatnost z iDokladu (0092) je záložní: čte se, jen když chybí ruční due_on
// (0090) — viz effectiveDueOn. Před migrací 0092 se dotaz zopakuje bez ní.
const IDOKLAD_DUE_COL = 'idoklad_due_on'
const CHUNK = 100

export async function listOverdueInvoices(opts: {
  /** Pražský dnešek (YYYY-MM-DD). */
  today: string
  accountId?: number | null
  currency?: Currency | null
  /** Klient databáze (cron: service role); výchozí session přihlášeného. */
  db?: Db
}): Promise<OverdueResult> {
  const s = opts.db ?? (await createClient())
  const query = (withIdoklad: boolean) => {
    let q = s
      .from('financial_record')
      .select(`${withIdoklad ? `${COLS}, ${IDOKLAD_DUE_COL}` : COLS}, account:account_id(name)`)
      .eq('kind', 'invoiced')
      .eq('status', 'confirmed')
      .order('due_on', { ascending: true })
      .order('id', { ascending: true })
      .limit(2000)
    q = withIdoklad
      ? q.or(`due_on.lt.${opts.today},and(due_on.is.null,${IDOKLAD_DUE_COL}.lt.${opts.today})`)
      : q.lt('due_on', opts.today)
    if (opts.accountId) q = q.eq('account_id', opts.accountId)
    if (opts.currency) q = q.eq('currency', opts.currency)
    return q
  }
  let { data, error } = await query(true)
  if (isMissingColumn(error) || error?.code === 'PGRST204') ({ data, error } = await query(false))
  if (isMissingRelation(error) || isMissingColumn(error) || error?.code === 'PGRST204') return { state: 'missing_migration' }
  if (error) {
    logError('query.overdueInvoices', error)
    return { state: 'error' }
  }
  type Row = FinancialRecordRow & { account: Joined<{ name: string }> }
  const invoices = ((data ?? []) as unknown as Row[]).map(({ account, ...r }) => ({
    ...withEffectiveDue(r),
    account_name: one(account)?.name ?? null,
  }))
  if (invoices.length === 0) return { state: 'ok', rows: [] }

  // Úhrady ke Faktuře: potvrzené Přijato se stejným číslem dokladu (obě strany bez ohledu na měsíc).
  const refs = [...new Set(invoices.map((r) => r.external_ref).filter((v): v is string => !!v))]
  const received: Pick<FinancialRecordRow, 'account_id' | 'kind' | 'status' | 'external_ref'>[] = []
  for (let i = 0; i < refs.length; i += CHUNK) {
    const part = await s
      .from('financial_record')
      .select('account_id, kind, status, external_ref')
      .eq('kind', 'received')
      .eq('status', 'confirmed')
      .in('external_ref', refs.slice(i, i + CHUNK))
    if (part.error) {
      // Bez úhrad by karta křičela i u zaplacených faktur – radši přiznat, že to nevíme.
      logError('query.overdueInvoices.received', part.error)
      return { state: 'error' }
    }
    received.push(...((part.data ?? []) as typeof received))
  }
  return { state: 'ok', rows: overdueInvoices(invoices, paidKeys(received), opts.today) }
}
