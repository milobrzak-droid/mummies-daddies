// Historie dávek hromadného importu (migrace 0098) pro stránku /import/zakazky.
// Jen čtení přes klienta s právy přihlášeného člověka (RLS: tým, AAL2, obchodní
// role). Tabulky jsou v migraci 0098, která ještě nemusí být aplikovaná:
// chybějící relace (42P01 / PGRST205) není chyba, ale stav „čeká na migraci“.
import { createClient } from '@/lib/supabase/server'
import { logError } from '@/lib/log'
import { isImportMissing } from '@/domain/crm/bulkImport'

export type ImportBatchSummary = {
  id: number
  kind: 'pdf' | 'csv'
  label: string | null
  status: 'open' | 'partial' | 'reverted'
  createdAt: string
  createdByName: string | null
  revertedAt: string | null
  /** Kolik zakázek dávka dnes drží (po vrácení ubývá). */
  deals: number
  accountsCreated: number
}

export type ImportBatchesResult =
  | { state: 'ok'; batches: ImportBatchSummary[] }
  | { state: 'missing_migration' }
  | { state: 'error' }

const ITEM_PAGE = 1000

export async function listImportBatches(limit = 20): Promise<ImportBatchesResult> {
  const s = await createClient()
  const { data, error } = await s
    .from('import_batch')
    .select('id, kind, label, status, created_by, created_at, reverted_at')
    .order('id', { ascending: false })
    .limit(limit)
  if (isImportMissing(error)) return { state: 'missing_migration' }
  if (error) {
    logError('query.importBatches', error)
    return { state: 'error' }
  }
  const rows = (data ?? []) as {
    id: number; kind: 'pdf' | 'csv'; label: string | null; status: 'open' | 'partial' | 'reverted'
    created_by: string | null; created_at: string; reverted_at: string | null
  }[]
  if (rows.length === 0) return { state: 'ok', batches: [] }

  const ids = rows.map((r) => r.id)
  // Položky dávek po stránkách (žádný pevný strop typu .limit(20000), za
  // kterým by počty potichu nesouhlasily); pořadí podle id kvůli stabilitě.
  type Item = { batch_id: number; entity_table: string; entity_id: number }
  const items: Item[] = []
  for (let from = 0; ; from += ITEM_PAGE) {
    const page = await s.from('import_batch_item').select('batch_id, entity_table, entity_id')
      .in('batch_id', ids).in('entity_table', ['deal', 'account']).order('id').range(from, from + ITEM_PAGE - 1)
    if (page.error) {
      logError('query.importBatchItems', page.error)
      return { state: 'error' }
    }
    const chunk = (page.data ?? []) as Item[]
    items.push(...chunk)
    if (chunk.length < ITEM_PAGE) break
  }
  const deals = new Map<number, Set<number>>()
  const accounts = new Map<number, number>()
  for (const it of items) {
    if (it.entity_table === 'deal') deals.set(it.batch_id, (deals.get(it.batch_id) ?? new Set()).add(it.entity_id))
    else accounts.set(it.batch_id, (accounts.get(it.batch_id) ?? 0) + 1)
  }

  const memberIds = [...new Set(rows.map((r) => r.created_by).filter((v): v is string => !!v))]
  const names = new Map<string, string | null>()
  if (memberIds.length > 0) {
    const { data: members } = await s.from('team_member').select('id, full_name').in('id', memberIds)
    for (const m of (members ?? []) as { id: string; full_name: string | null }[]) names.set(m.id, m.full_name)
  }

  return {
    state: 'ok',
    batches: rows.map((r) => ({
      id: r.id, kind: r.kind, label: r.label, status: r.status, createdAt: r.created_at,
      createdByName: r.created_by ? (names.get(r.created_by) ?? null) : null,
      revertedAt: r.reverted_at,
      deals: deals.get(r.id)?.size ?? 0,
      accountsCreated: accounts.get(r.id) ?? 0,
    })),
  }
}
