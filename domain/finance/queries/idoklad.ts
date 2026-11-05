import { createClient } from '@/lib/supabase/server'
import { isMissingColumn, isMissingRelation } from '@/core/loopQueries'
import { getConnectorState } from '@/core/connectorState'
import { idokladCredentialsFromEnv, idokladMissingEnv, idokladSyncEnabledFromEnv } from '@/connectors/idoklad'
import { logError } from '@/lib/log'
import { IDOKLAD_CONNECTOR, syncDaysFromEnv, type DiscrepancyKind, type IdokladDocKind } from '@/domain/finance/idoklad'

// Čtení „Rozdílů k vyřešení" z iDokladu (0092) a stavu napojení. Tabulku vidí
// jen obchodní role (RLS sales_only); volající stránky to hlídají i v UI.
// Do aplikace 0092 vrací 'missing_migration' — stránka řekne, co chybí.

export type DiscrepancyRow = {
  id: number
  kind: DiscrepancyKind
  reason: string
  idoklad_kind: IdokladDocKind | null
  idoklad_id: number | null
  document_number: string | null
  account_id: number | null
  account_name: string | null
  record_id: number | null
  currency: string | null
  idoklad_amount: number | null
  record_amount: number | null
  first_seen_at: string
  last_seen_at: string
}

export type DiscrepanciesResult =
  | { state: 'ok'; rows: DiscrepancyRow[]; total: number }
  | { state: 'missing_migration' }
  | { state: 'error' }

const COLS = 'id, kind, reason, idoklad_kind, idoklad_id, document_number, account_id, record_id, currency, idoklad_amount, record_amount, first_seen_at, last_seen_at'

type Joined<T> = T | T[] | null
const one = <T,>(v: Joined<T>): T | null => (Array.isArray(v) ? v[0] ?? null : v)

/** Otevřené rozdíly, nejstarší první. */
export async function listOpenDiscrepancies(limit = 100): Promise<DiscrepanciesResult> {
  const s = await createClient()
  const { data, error, count } = await s
    .from('idoklad_discrepancy')
    .select(`${COLS}, account:account_id(name)`, { count: 'exact' })
    .eq('status', 'open')
    .order('first_seen_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(limit)
  if (isMissingRelation(error) || isMissingColumn(error)) return { state: 'missing_migration' }
  if (error) {
    logError('query.idokladDiscrepancies', error)
    return { state: 'error' }
  }
  type Row = Omit<DiscrepancyRow, 'account_name'> & { account: Joined<{ name: string }> }
  const rows = ((data ?? []) as unknown as Row[]).map(({ account, ...r }) => ({ ...r, account_name: one(account)?.name ?? null }))
  return { state: 'ok', rows, total: count ?? rows.length }
}

/** Kolik rozdílů čeká (pro provozní přehled); null = nejde zjistit. */
export async function countOpenDiscrepancies(db?: Awaited<ReturnType<typeof createClient>>): Promise<number | null> {
  const s = db ?? (await createClient())
  const { count, error } = await s.from('idoklad_discrepancy').select('id', { count: 'exact', head: true }).eq('status', 'open')
  if (error) {
    if (!isMissingRelation(error) && !isMissingColumn(error)) logError('query.idokladDiscrepancyCount', error)
    return null
  }
  return count ?? 0
}

export type IdokladStatus = {
  enabled: boolean
  /** Názvy chybějících proměnných prostředí (bez hodnot). */
  missing: string[]
  days: number
  lastSuccessAt: string | null
  lastError: string | null
  consecutiveErrors: number
}

/** Stav napojení: přepínač, chybějící tajemství, poslední úspěch a chyba (bez hodnot tajemství). */
export async function getIdokladStatus(env: Record<string, string | undefined> = process.env): Promise<IdokladStatus> {
  const enabled = idokladSyncEnabledFromEnv(env)
  const base: IdokladStatus = {
    enabled,
    missing: idokladCredentialsFromEnv(env) ? [] : idokladMissingEnv(env),
    days: syncDaysFromEnv(env),
    lastSuccessAt: null, lastError: null, consecutiveErrors: 0,
  }
  if (!enabled) return base
  try {
    const st = await getConnectorState(IDOKLAD_CONNECTOR)
    return { ...base, lastSuccessAt: st?.last_success_at ?? null, lastError: st?.last_error ?? null, consecutiveErrors: st?.consecutive_errors ?? 0 }
  } catch (e) {
    logError('query.idokladStatus', e)
    return base
  }
}
