// Seznam klientů (/clients) po importu Obchodního radaru: ~663 firem, takže
// se stránkuje, filtruje a řadí v databázi. Tady jsou jen čisté funkce
// (žádné I/O) — čtení parametrů z URL, překlad filtrů na volání PostgRESTu,
// stav firmy a meze stránkování. I/O je v domain/crm/queries/accountList.ts.
// Testy: test/account-list.test.ts.

import { escapeLikePattern, likeContains, quoteOrValue } from '@/domain/crm/queries/search'
import { OPEN_DEAL_STAGES } from '@/domain/crm/sales'
import type { DealStage } from '@/lib/types'

export const ACCOUNT_PAGE_SIZE = 50
/** Strop čísla stránky z URL — ať `?page=1e9` nevyrobí nesmyslný offset. */
export const ACCOUNT_MAX_PAGE = 10_000
export const ACCOUNT_QUERY_MAX_LENGTH = 100
const FACET_VALUE_MAX_LENGTH = 200

/** Hodnota filtru „nevyplněno" (bez oboru / regionu / vlastníka). */
export const NONE_VALUE = '-'

/** Oddělovač oboru „Prefix – upřesnění" (pomlčka z importu radaru). */
export const INDUSTRY_SEPARATOR = ' – '

// Stav firmy. Tabulka account sloupec stavu nemá — odvozuje se z toho, co
// uživatel smí vidět (rozhodnutí 2026-09-28: obchody jen obchodní role):
//   aktivni  = má otevřený obchod (jen obchodní role),
//   klient   = nemá otevřený obchod, ale má vyhraný obchod (jen obchodní
//              role) nebo vyplněné „Klient od" (client_since),
//   prospekt = nic z toho.
// Stavy se nepřekrývají, součet = všechny firmy.
export const ACCOUNT_STATUSES = ['aktivni', 'klient', 'prospekt'] as const
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number]
export const ACCOUNT_STATUS_LABELS: Record<AccountStatus, string> = {
  aktivni: 'Aktivní',
  klient: 'Klient',
  prospekt: 'Prospekt',
}

export const ACCOUNT_SORTS = ['nazev', 'aktivita', 'pipeline'] as const
export type AccountSort = (typeof ACCOUNT_SORTS)[number]
export const ACCOUNT_SORT_LABELS: Record<AccountSort, string> = {
  nazev: 'Název',
  aktivita: 'Poslední aktivita',
  pipeline: 'Otevřené obchody',
}

export interface AccountListParams {
  q: string | null
  status: AccountStatus | null
  obor: string | null
  region: string | null
  owner: string | null
  bezIco: boolean
  sort: AccountSort
  page: number
}

export const DEFAULT_ACCOUNT_LIST_PARAMS: AccountListParams = {
  q: null, status: null, obor: null, region: null, owner: null, bezIco: false, sort: 'nazev', page: 1,
}

type RawParams = Record<string, string | string[] | undefined>

function first(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v
}

function cleanText(v: string | string[] | undefined, max: number): string | null {
  const s = first(v)
  if (typeof s !== 'string') return null
  // Řídicí znaky pryč (do URL se dají vložit, do dotazu nepatří).
  const t = s.replace(/[\u0000-\u001f\u007f]/g, ' ').trim()
  return t ? t.slice(0, max) : null
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** Číslo stránky z URL: celé číslo 1…ACCOUNT_MAX_PAGE, jinak 1 / strop. */
export function parsePage(v: string | string[] | undefined): number {
  const s = first(v)
  if (typeof s !== 'string' || !/^\d+$/.test(s.trim())) return 1
  const n = Number(s.trim())
  if (!Number.isSafeInteger(n) || n < 1) return 1
  return Math.min(n, ACCOUNT_MAX_PAGE)
}

/**
 * Parametry seznamu z URL. Neznámé nebo nepovolené hodnoty se tiše
 * zahodí (žádná chyba — URL si člověk mohl upravit ručně). Stav „aktivni"
 * a řazení podle pipeline jen pro obchodní role: ostatním by filtr nad
 * obchody, které nevidí, vracel nesmysl.
 */
export function parseAccountListParams(raw: RawParams, { canSeeSales }: { canSeeSales: boolean }): AccountListParams {
  const status = first(raw.stav)
  const sort = first(raw.sort)
  const owner = cleanText(raw.vlastnik, 64)
  const bezIco = first(raw.bez_ico)
  return {
    q: cleanText(raw.q, ACCOUNT_QUERY_MAX_LENGTH),
    status: (ACCOUNT_STATUSES as readonly string[]).includes(status ?? '') && (status !== 'aktivni' || canSeeSales)
      ? status as AccountStatus
      : null,
    obor: cleanText(raw.obor, FACET_VALUE_MAX_LENGTH),
    region: cleanText(raw.region, FACET_VALUE_MAX_LENGTH),
    owner: owner === NONE_VALUE || (owner && UUID_RE.test(owner)) ? owner : null,
    bezIco: bezIco === '1' || bezIco === 'on' || bezIco === 'true',
    sort: (ACCOUNT_SORTS as readonly string[]).includes(sort ?? '') && (sort !== 'pipeline' || canSeeSales)
      ? sort as AccountSort
      : 'nazev',
    page: parsePage(raw.page),
  }
}

/** Je aktivní nějaký filtr (mimo řazení a stránku)? */
export function hasActiveFilters(p: AccountListParams): boolean {
  return Boolean(p.q || p.status || p.obor || p.region || p.owner || p.bezIco)
}

/**
 * URL seznamu se zadanými parametry. Výchozí hodnoty se do URL nepíšou
 * (čistý odkaz „/clients"), stránka 1 taky ne.
 */
export function accountListHref(p: AccountListParams, overrides: Partial<AccountListParams> = {}): string {
  const m = { ...p, ...overrides }
  const sp = new URLSearchParams()
  if (m.q) sp.set('q', m.q)
  if (m.status) sp.set('stav', m.status)
  if (m.obor) sp.set('obor', m.obor)
  if (m.region) sp.set('region', m.region)
  if (m.owner) sp.set('vlastnik', m.owner)
  if (m.bezIco) sp.set('bez_ico', '1')
  if (m.sort !== 'nazev') sp.set('sort', m.sort)
  if (m.page > 1) sp.set('page', String(m.page))
  const qs = sp.toString()
  return qs ? `/cockpit/clients?${qs}` : '/cockpit/clients'
}

// ---------------------------------------------------------------- stránkování

export function pageCount(total: number, pageSize = ACCOUNT_PAGE_SIZE): number {
  return Math.max(1, Math.ceil(Math.max(0, total) / pageSize))
}

/** Rozsah řádků pro PostgREST `.range(from, to)` (včetně `to`). */
export function pageRange(page: number, pageSize = ACCOUNT_PAGE_SIZE): { from: number; to: number } {
  const p = Math.min(Math.max(1, Math.floor(page) || 1), ACCOUNT_MAX_PAGE)
  const from = (p - 1) * pageSize
  return { from, to: from + pageSize - 1 }
}

/** Stránka po ořezu na existující rozsah (prázdný výsledek = stránka 1). */
export function clampPage(page: number, total: number, pageSize = ACCOUNT_PAGE_SIZE): number {
  return Math.min(Math.max(1, page), pageCount(total, pageSize))
}

/**
 * Čísla stránek pro pager: první, poslední a okolí aktuální; mezery jako
 * null (vykreslí se „…"). Např. (7, 14) → [1, null, 6, 7, 8, null, 14].
 */
export function pagerItems(page: number, pages: number): (number | null)[] {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1)
  const set = new Set([1, pages, page - 1, page, page + 1].filter((n) => n >= 1 && n <= pages))
  const sorted = [...set].sort((a, b) => a - b)
  const out: (number | null)[] = []
  for (const n of sorted) {
    const prev = out[out.length - 1]
    if (typeof prev === 'number' && n - prev > 1) out.push(null)
    out.push(n)
  }
  return out
}

// ---------------------------------------------------------------- obory / fasety

/** Prefix oboru před „ – " (stejně jako split_part v v_account_list_facets). */
export function industryPrefix(industry: string | null | undefined): string | null {
  if (!industry) return null
  const prefix = industry.split(INDUSTRY_SEPARATOR)[0]
  return prefix ? prefix : null
}

export interface FacetOption { value: string; count: number }
export interface AccountFacets {
  industries: FacetOption[]
  regions: FacetOption[]
  total: number
  missingIco: number
}

const byValue = (a: FacetOption, b: FacetOption) => a.value.localeCompare(b.value, 'cs')

/** Řádky pohledu v_account_list_facets → fasety. */
export function facetsFromView(rows: { kind: string; value: string | null; n: number | string }[]): AccountFacets {
  const out: AccountFacets = { industries: [], regions: [], total: 0, missingIco: 0 }
  for (const r of rows) {
    const n = Number(r.n) || 0
    if (r.kind === 'industry' && r.value) out.industries.push({ value: r.value, count: n })
    else if (r.kind === 'region' && r.value) out.regions.push({ value: r.value, count: n })
    else if (r.kind === 'total') out.total = n
    else if (r.kind === 'missing_ico') out.missingIco = n
  }
  out.industries.sort(byValue)
  out.regions.sort(byValue)
  return out
}

/** Záloha bez 0068: stejné fasety spočítané v JS z úzkého výběru sloupců. */
export function facetsFromRows(rows: { industry: string | null; region: string | null; ico: string | null }[]): AccountFacets {
  const industries = new Map<string, number>()
  const regions = new Map<string, number>()
  let missingIco = 0
  for (const r of rows) {
    const prefix = industryPrefix(r.industry)
    if (prefix) industries.set(prefix, (industries.get(prefix) ?? 0) + 1)
    if (r.region) regions.set(r.region, (regions.get(r.region) ?? 0) + 1)
    if (!r.ico) missingIco += 1
  }
  const toList = (m: Map<string, number>) => [...m].map(([value, count]) => ({ value, count })).sort(byValue)
  return { industries: toList(industries), regions: toList(regions), total: rows.length, missingIco }
}

// ---------------------------------------------------------------- stav a pipeline

type DealForStatus = {
  account_id: number
  stage: DealStage | string
  amount_one_time?: number | string | null
  account?: { name: string } | null
}

export interface StatusSets {
  /** firmy s otevřeným obchodem */
  openIds: number[]
  /** firmy s vyhraným obchodem */
  wonIds: number[]
}

export const EMPTY_STATUS_SETS: StatusSets = { openIds: [], wonIds: [] }

export function deriveStatusSets(deals: DealForStatus[]): StatusSets {
  const open = new Set<number>()
  const won = new Set<number>()
  for (const d of deals) {
    if ((OPEN_DEAL_STAGES as string[]).includes(d.stage)) open.add(d.account_id)
    else if (d.stage === 'vyhráno') won.add(d.account_id)
  }
  const asc = (a: number, b: number) => a - b
  return { openIds: [...open].sort(asc), wonIds: [...won].sort(asc) }
}

export function accountStatus(
  a: { id: number; client_since: string | null },
  sets: StatusSets,
): AccountStatus {
  if (sets.openIds.includes(a.id)) return 'aktivni'
  if (a.client_since || sets.wonIds.includes(a.id)) return 'klient'
  return 'prospekt'
}

export interface PipelineRank { account_id: number; amount: number }

/**
 * Firmy s nenulovou otevřenou pipeline (součet amount_one_time otevřených
 * obchodů, stejně jako sloupec „Otevřené obchody"), od největší. Shoda
 * částky → podle názvu, pak id (deterministické stránkování).
 */
export function rankByOpenPipeline(deals: DealForStatus[]): PipelineRank[] {
  const sums = new Map<number, { amount: number; name: string }>()
  for (const d of deals) {
    if (!(OPEN_DEAL_STAGES as string[]).includes(d.stage)) continue
    const cur = sums.get(d.account_id) ?? { amount: 0, name: d.account?.name ?? '' }
    cur.amount += Number(d.amount_one_time ?? 0) || 0
    sums.set(d.account_id, cur)
  }
  return [...sums]
    .filter(([, v]) => v.amount > 0)
    .sort(([ia, a], [ib, b]) => b.amount - a.amount || a.name.localeCompare(b.name, 'cs') || ia - ib)
    .map(([account_id, v]) => ({ account_id, amount: v.amount }))
}

// ---------------------------------------------------------------- překlad na PostgREST

/**
 * Minimum z PostgREST builderu, které filtry potřebují. Strukturální typ,
 * aby šlo filtry testovat nad test/helpers/supabaseFake.ts.
 */
export interface FilterableQuery<Q> {
  or(filters: string): Q
  eq(column: string, value: string): Q
  is(column: string, value: null): Q
  in(column: string, values: readonly number[]): Q
  not(column: string, operator: string, value: unknown): Q
}

const idList = (ids: readonly number[]) => `(${ids.join(',')})`

/** `(name|ico) ILIKE %q%` — zástupné znaky z dotazu jsou escapované. */
export function accountSearchOrFilter(q: string): string {
  const quoted = quoteOrValue(likeContains(q))
  const parts = [`name.ilike.${quoted}`, `ico.ilike.${quoted}`]
  // IČO se často píše s mezerami („123 45 678") — v DB je bez nich.
  const digits = q.replace(/\s+/g, '')
  if (digits !== q && /^\d+$/.test(digits)) parts.push(`ico.ilike.${quoteOrValue(likeContains(digits))}`)
  return parts.join(',')
}

/** Obor: přesně prefix, nebo „prefix – cokoli". */
export function industryOrFilter(prefix: string): string {
  return [
    `industry.eq.${quoteOrValue(prefix)}`,
    `industry.like.${quoteOrValue(`${escapeLikePattern(prefix)}${INDUSTRY_SEPARATOR}%`)}`,
  ].join(',')
}

export const BLANK_ICO_FILTER = 'ico.is.null,ico.eq.""'

type FilterParams = Pick<AccountListParams, 'q' | 'status' | 'obor' | 'region' | 'owner' | 'bezIco'>

/**
 * Je výsledek jistě prázdný bez ptaní se databáze? (stav „aktivni" a žádný
 * otevřený obchod). Dotaz se pak vůbec neposílá.
 */
export function filtersMatchNothing(p: FilterParams, sets: StatusSets): boolean {
  return p.status === 'aktivni' && sets.openIds.length === 0
}

/**
 * Přeloží filtry na volání builderu. `empty: true` = viz filtersMatchNothing.
 */
export function applyAccountFilters<Q extends FilterableQuery<Q>>(
  query: Q,
  p: FilterParams,
  sets: StatusSets,
): { query: Q; empty: boolean } {
  if (filtersMatchNothing(p, sets)) return { query, empty: true }
  let q = query
  if (p.q) q = q.or(accountSearchOrFilter(p.q))

  if (p.status === 'aktivni') {
    q = q.in('id', sets.openIds)
  } else if (p.status === 'klient') {
    q = sets.wonIds.length > 0
      ? q.or(`client_since.not.is.null,id.in.${idList(sets.wonIds)}`)
      : q.not('client_since', 'is', null)
    if (sets.openIds.length > 0) q = q.not('id', 'in', idList(sets.openIds))
  } else if (p.status === 'prospekt') {
    q = q.is('client_since', null)
    const excluded = [...new Set([...sets.openIds, ...sets.wonIds])].sort((a, b) => a - b)
    if (excluded.length > 0) q = q.not('id', 'in', idList(excluded))
  }

  if (p.obor === NONE_VALUE) q = q.or('industry.is.null,industry.eq.""')
  else if (p.obor) q = q.or(industryOrFilter(p.obor))

  if (p.region === NONE_VALUE) q = q.or('region.is.null,region.eq.""')
  else if (p.region) q = q.eq('region', p.region)

  if (p.owner === NONE_VALUE) q = q.is('owner_id', null)
  else if (p.owner) q = q.eq('owner_id', p.owner)

  if (p.bezIco) q = q.or(BLANK_ICO_FILTER)

  return { query: q, empty: false }
}

/** Formát data poslední aktivity: novější z last_inbound_at / last_outbound_at. */
export function lastContactAt(a: { last_inbound_at: string | null; last_outbound_at: string | null }): string | null {
  const { last_inbound_at: i, last_outbound_at: o } = a
  if (!i) return o
  if (!o) return i
  return Date.parse(i) >= Date.parse(o) ? i : o
}

// ---------------------------------------------------------------- texty

/** Český plurál: 1 firma, 2–4 firmy, 0 a 5+ firem (včetně čísla). */
export function czCount(n: number, [one, few, many]: readonly [string, string, string]): string {
  const word = n === 1 ? one : n >= 2 && n <= 4 ? few : many
  return `${n.toLocaleString('cs-CZ')} ${word}`
}
