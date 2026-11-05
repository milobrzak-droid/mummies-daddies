// Čtení pro „Navrhnout firmy podle segmentu" (domain/crm/targetSegments.ts).
//
// JEN ČTE. Z obchodů bere výhradně account_id a fázi — aby šlo poznat
// klienta a rozjednaný obchod a nenavrhovat je jako prospekty. Žádné
// částky a žádný zápis: oslovení z cílového seznamu obchod nikdy
// nezakládá (PLAN-PRESTAVBY kap. 4, test/target-segments.test.ts).
// Tabulky obchodů a předplatného vidí jen obchodní role (RLS 0058) —
// volající akce to proto ověřuje předem.
//
// PostgREST bez `.range()` ořízne odpověď na 1000 řádků; prospektů je
// ~660 a přibývají, proto se stránkuje (vzor domain/crm/gdprSweep.ts).
import { createClient } from '@/lib/supabase/server'
import { isMissingColumn, isMissingRelation } from '@/core/loopQueries'
import {
  accountRelationship,
  type SuggestCandidate,
} from '@/domain/crm/targetSegments'

const PAGE_SIZE = 1000
const ROW_CAP = 50_000

type DbError = { code?: string | null; message?: string | null }
type RangeQuery<T> = { range: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: DbError | null }> }

async function loadAll<T>(makeQuery: () => RangeQuery<T>): Promise<{ rows: T[]; error: DbError | null }> {
  const rows: T[] = []
  let offset = 0
  for (;;) {
    const { data, error } = await makeQuery().range(offset, offset + PAGE_SIZE - 1)
    if (error) return { rows, error }
    const page = data ?? []
    rows.push(...page)
    if (page.length < PAGE_SIZE || rows.length >= ROW_CAP) return { rows, error: null }
    offset += PAGE_SIZE
  }
}

type AccountRow = {
  id: number
  name: string
  industry: string | null
  region: string | null
  client_since: string | null
  is_reference: boolean | null
}

export type SegmentCandidates =
  | { state: 'missing_migration' }
  | { state: 'error'; error: DbError }
  | { state: 'ok'; accounts: SuggestCandidate[]; existingAccountIds: Set<number> }

/**
 * Firmy s odvozeným vztahem (prospekt / rozjednaný obchod / klient)
 * a id firem, které už v seznamu jsou (v jakémkoli stavu).
 */
export async function loadSegmentCandidates(listId: number): Promise<SegmentCandidates> {
  const s = await createClient()
  const [items, accounts, deals, engagements, subscriptions] = await Promise.all([
    loadAll<{ account_id: number }>(() =>
      s.from('target_list_item').select('account_id').eq('list_id', listId).order('id')),
    loadAll<AccountRow>(() =>
      s.from('account').select('id, name, industry, region, client_since, is_reference').order('id')),
    loadAll<{ account_id: number; stage: string | null }>(() =>
      s.from('deal').select('account_id, stage').order('id')),
    loadAll<{ account_id: number }>(() =>
      s.from('engagement').select('account_id').order('id')),
    loadAll<{ account_id: number }>(() =>
      s.from('subscription').select('account_id').is('ended_on', null).order('id')),
  ])
  const errors = [items, accounts, deals, engagements, subscriptions].map((r) => r.error)
  if (errors.some((e) => isMissingRelation(e) || isMissingColumn(e) || e?.code === 'PGRST204')) {
    return { state: 'missing_migration' }
  }
  const err = errors.find((e) => e !== null)
  if (err) return { state: 'error', error: err }

  const stages = new Map<number, (string | null)[]>()
  for (const d of deals.rows) {
    const list = stages.get(d.account_id) ?? []
    list.push(d.stage)
    stages.set(d.account_id, list)
  }
  const withEngagement = new Set(engagements.rows.map((e) => e.account_id))
  const withSubscription = new Set(subscriptions.rows.map((x) => x.account_id))

  return {
    state: 'ok',
    existingAccountIds: new Set(items.rows.map((i) => i.account_id)),
    accounts: accounts.rows.map((a) => ({
      id: a.id,
      name: a.name,
      industry: a.industry,
      region: a.region,
      status: accountRelationship({
        client_since: a.client_since,
        is_reference: a.is_reference,
        dealStages: stages.get(a.id) ?? [],
        hasEngagement: withEngagement.has(a.id),
        hasRunningSubscription: withSubscription.has(a.id),
      }),
    })),
  }
}
