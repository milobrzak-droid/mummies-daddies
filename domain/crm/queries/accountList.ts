import { createClient } from '@/lib/supabase/server'
import { isMissingColumn, isMissingRelation } from '@/core/loopQueries'
import {
  ACCOUNT_PAGE_SIZE, applyAccountFilters, clampPage, facetsFromRows, facetsFromView, filtersMatchNothing,
  pageCount, pageRange,
  type AccountFacets, type AccountListParams, type FilterableQuery, type PipelineRank, type StatusSets,
} from '@/domain/crm/accountList'

// I/O vrstva seznamu klientů (/clients). Čistá logika je v
// domain/crm/accountList.ts. Počet dotazů na jedno vykreslení je pevný
// a nezávisí na počtu firem (test/account-list-io.test.ts to hlídá):
//   listAccountsPage:      1× stránka + počet (count=exact v témže dotazu),
//                          +1× jen při řazení podle pipeline
//   getAccountListSummary: 1× fasety a počty (v_account_list_facets, 0068)
//                          + 1× počet klientů (head)
// Vše přes RLS klienta uživatele (createClient), nikdy přes service roli.

// Jen sloupce, které tabulka zobrazuje — bez `*` (poznámky z radaru bývají
// dlouhé a seznam je nepotřebuje).
export const ACCOUNT_LIST_COLUMNS = [
  'id', 'name', 'ico', 'industry', 'region', 'client_since', 'owner_id',
  'last_inbound_at', 'last_outbound_at',
  'owner:team_member!account_owner_id_fkey(id, full_name)',
  'referred_by:partner!account_referred_by_partner_id_fkey(id, name)',
].join(', ')

export interface AccountListRow {
  id: number
  name: string
  ico: string | null
  industry: string | null
  region: string | null
  client_since: string | null
  owner_id: string | null
  last_inbound_at: string | null
  last_outbound_at: string | null
  owner: { id: string; full_name: string } | null
  referred_by: { id: number; name: string } | null
}

export interface AccountListResult {
  rows: AccountListRow[]
  /** počet firem odpovídajících filtru */
  total: number
  /** skutečně zobrazená stránka (po ořezu na rozsah) */
  page: number
  pageCount: number
  /** klidná upozornění (např. neaplikovaná migrace 0068) */
  notices: string[]
}

export const MIGRATION_0068_NOTICE =
  'Řazení podle poslední aktivity je zatím přibližné (podle našeho posledního e-mailu).'
export const FACETS_FALLBACK_NOTICE =
  'Počty ve filtrech se zatím počítají z celé tabulky, proto se můžou načítat pomaleji.'

type DbError = { code?: string; message?: string }
type Result = { data: unknown; error: DbError | null; count?: number | null }
type Supabase = Awaited<ReturnType<typeof createClient>>

function isOutOfRange(error: DbError | null): boolean {
  // PostgREST: offset za koncem výsledku s count=exact → 416 / PGRST103.
  return error?.code === 'PGRST103' || /range not satisfiable/i.test(error?.message ?? '')
}

function isMissingComputedColumn(error: DbError | null): boolean {
  return isMissingColumn(error) || error?.code === 'PGRST204' || error?.code === 'PGRST200'
}

type OrderOptions = { ascending?: boolean; nullsFirst?: boolean }

// Builder z postgrest-js je hluboce generický (typ výsledku se odvozuje ze
// select řetězce) a generické skládání filtrů nad ním končí na TS2589.
// Proto se hned po select() zúží na strukturální tvar, který filtry,
// řazení a stránkování potřebují — za běhu je to tentýž builder.
interface AccountQuery extends FilterableQuery<AccountQuery>, PromiseLike<Result> {
  order(column: string, options?: OrderOptions): AccountQuery
  range(from: number, to: number): AccountQuery
}

function accountQuery(s: Supabase, columns: string, options?: { count?: 'exact'; head?: boolean }): AccountQuery {
  return s.from('account').select(columns, options) as unknown as AccountQuery
}

type Order = 'nazev' | 'aktivita' | 'aktivita_fallback'

function applyOrder(query: AccountQuery, order: Order): AccountQuery {
  let q = query
  if (order === 'aktivita') {
    // last_contact_at(account) = GREATEST(last_inbound_at, last_outbound_at), 0068.
    q = q.order('last_contact_at', { ascending: false, nullsFirst: false })
  } else if (order === 'aktivita_fallback') {
    // Bez 0068 funkce chybí: přibližně podle indexu z 0030.
    q = q.order('last_outbound_at', { ascending: false, nullsFirst: false })
      .order('last_inbound_at', { ascending: false, nullsFirst: false })
  }
  return q.order('name').order('id')
}

function headCount(s: Supabase): AccountQuery {
  return accountQuery(s, 'id', { count: 'exact', head: true })
}

/**
 * Jedna stránka seznamu. `sets` = firmy s otevřeným/vyhraným obchodem
 * (jen obchodní role; ostatní dostanou prázdné množiny), `ranking` =
 * pořadí podle otevřené pipeline (jen pro sort=pipeline).
 */
export async function listAccountsPage(
  params: AccountListParams,
  sets: StatusSets,
  ranking: PipelineRank[] = [],
): Promise<AccountListResult> {
  if (filtersMatchNothing(params, sets)) return { rows: [], total: 0, page: 1, pageCount: 1, notices: [] }
  const s = await createClient()

  if (params.sort === 'pipeline' && ranking.length > 0) {
    return listByPipeline(s, params, sets, ranking)
  }

  const notices: string[] = []
  let order: Order = params.sort === 'aktivita' ? 'aktivita' : 'nazev'
  const fetchPage = async (page: number): Promise<Result> => {
    const { from, to } = pageRange(page)
    const { query } = applyAccountFilters(accountQuery(s, ACCOUNT_LIST_COLUMNS, { count: 'exact' }), params, sets)
    return await applyOrder(query, order).range(from, to)
  }

  let page = params.page
  let res = await fetchPage(page)
  if (res.error && order === 'aktivita' && isMissingComputedColumn(res.error)) {
    order = 'aktivita_fallback'
    notices.push(MIGRATION_0068_NOTICE)
    res = await fetchPage(page)
  }
  // Stránka za koncem (starý odkaz, mezitím ubylo firem) → poslední stránka.
  const noRows = !res.error && ((res.data as unknown[] | null) ?? []).length === 0
  if (page > 1 && (isOutOfRange(res.error) || noRows)) {
    const total = res.error ? await countMatching(s, params, sets) : (res.count ?? 0)
    const clamped = clampPage(page, total)
    if (clamped !== page) {
      page = clamped
      res = await fetchPage(page)
    }
  }
  if (res.error) throw res.error

  const rows = (res.data ?? []) as AccountListRow[]
  const total = res.count ?? pageRange(page).from + rows.length
  return { rows, total, page, pageCount: pageCount(total), notices }
}

async function countMatching(s: Supabase, params: AccountListParams, sets: StatusSets, excludeIds: number[] = []): Promise<number> {
  let { query } = applyAccountFilters(headCount(s), params, sets)
  if (excludeIds.length > 0) query = query.not('id', 'in', `(${excludeIds.join(',')})`)
  const { count, error } = await query
  if (error) throw error
  return count ?? 0
}

/**
 * Řazení podle otevřené pipeline. Částka není sloupec firmy (počítá se
 * z obchodů), takže: (A) firmy s pipeline, které projdou filtrem — jen
 * pár řádků, seřadí se podle `ranking` v paměti; (B) zbytek podle názvu,
 * stránkovaný v DB s offsetem posunutým o počet firem z A. Dva dotazy,
 * nezávisle na počtu firem.
 */
async function listByPipeline(
  s: Supabase,
  params: AccountListParams,
  sets: StatusSets,
  ranking: PipelineRank[],
): Promise<AccountListResult> {
  const rankedIds = ranking.map((r) => r.account_id)
  const position = new Map(rankedIds.map((id, i) => [id, i]))

  const aRes = await applyAccountFilters(accountQuery(s, ACCOUNT_LIST_COLUMNS), params, sets).query
    .in('id', rankedIds)
  if (aRes.error) throw aRes.error
  const ranked = ((aRes.data ?? []) as AccountListRow[])
    .sort((x, y) => (position.get(x.id) ?? 0) - (position.get(y.id) ?? 0))

  const fetchRest = async (page: number): Promise<Result> => {
    const { from, to } = pageRange(page)
    const restFrom = Math.max(0, from - ranked.length)
    const restTo = Math.max(restFrom, to - ranked.length)
    const b = applyAccountFilters(accountQuery(s, ACCOUNT_LIST_COLUMNS, { count: 'exact' }), params, sets).query
      .not('id', 'in', `(${rankedIds.join(',')})`)
    return await applyOrder(b, 'nazev').range(restFrom, restTo)
  }

  const bRes = await fetchRest(params.page)
  let restTotal: number
  if (bRes.error) {
    if (!isOutOfRange(bRes.error)) throw bRes.error
    restTotal = await countMatching(s, params, sets, rankedIds)
  } else {
    restTotal = bRes.count ?? ((bRes.data as unknown[] | null) ?? []).length
  }

  // Stránka za koncem (starý odkaz) → poslední stránka.
  const total = ranked.length + restTotal
  const page = clampPage(params.page, total)
  const { from } = pageRange(page)
  const fromRanked = ranked.slice(from, from + ACCOUNT_PAGE_SIZE)
  let restRows: AccountListRow[] = []
  if (fromRanked.length < ACCOUNT_PAGE_SIZE && from + fromRanked.length < total) {
    if (page === params.page && !bRes.error) {
      restRows = (bRes.data ?? []) as AccountListRow[]
    } else {
      const again = await fetchRest(page)
      if (again.error) throw again.error
      restRows = (again.data ?? []) as AccountListRow[]
    }
  }
  const rows = [...fromRanked, ...restRows].slice(0, ACCOUNT_PAGE_SIZE)
  return { rows, total, page, pageCount: pageCount(total), notices: [] }
}

export interface AccountListSummary {
  facets: AccountFacets
  /** firmy ve stavu „klient" (bez ohledu na ostatní filtry) */
  clientCount: number
  notices: string[]
}

/**
 * Fasety filtrů a počty do hlavičky. Dva souběžné dotazy: pohled z 0068
 * (obory, regiony, celkem, bez IČO) a head count klientů. Bez 0068 spadne
 * na úzký výběr tří sloupců a spočítá totéž v JS.
 */
export async function getAccountListSummary(sets: StatusSets): Promise<AccountListSummary> {
  const s = await createClient()
  const notices: string[] = []
  const clientQuery = applyAccountFilters(
    headCount(s),
    { q: null, status: 'klient', obor: null, region: null, owner: null, bezIco: false },
    sets,
  ).query

  const [view, clients]: [Result, Result] = await Promise.all([
    s.from('v_account_list_facets').select('kind, value, n'),
    clientQuery,
  ])
  if (clients.error) throw clients.error

  let facets: AccountFacets
  if (!view.error) {
    facets = facetsFromView((view.data ?? []) as { kind: string; value: string | null; n: number }[])
  } else if (isMissingRelation(view.error)) {
    const rows: Result = await s.from('account').select('industry, region, ico')
    if (rows.error) throw rows.error
    facets = facetsFromRows((rows.data ?? []) as { industry: string | null; region: string | null; ico: string | null }[])
    notices.push(FACETS_FALLBACK_NOTICE)
  } else {
    throw view.error
  }
  return { facets, clientCount: clients.count ?? 0, notices }
}
