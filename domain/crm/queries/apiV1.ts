import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/admin'
import { OPEN_DEAL_STAGE_FILTER, OPEN_DEAL_STAGES } from '@/domain/crm/sales'
import { normalizeDealRows, normalizeDealStage } from '@/lib/dealStageLegacy'
import type { Partner, PartnerWithVia } from '@/lib/types'
import { pragueLocalToUtc } from '@/lib/pragueDate'
import { APPROVAL_ACTIONS, isApprovalActionType, nextStepParams, offerParams } from '@/core/approvalActions'

// Data pro REST /api/v1/* a MCP nástroje (lib/mcpServer.ts). Čte servisní
// klient mimo RLS — kdo co smí, hlídají volající (requireApiKey, MCP role).
//
// Seznamy klientů a obchodů jsou VŽDY stránkované: bez `limit` přijde první
// stránka (API_PAGE_DEFAULT) a `next_offset`, nikdy tichý strop PostgRESTu
// (1000 řádků), který dřív bez varování uřízl zbytek. Sloupce jsou úzký výčet
// (ne `*`), ať do API a k modelu nejdou poznámky ani interní pole.

/** Výchozí a nejvyšší velikost stránky seznamů /api/v1 a MCP. */
export const API_PAGE_DEFAULT = 100
export const API_PAGE_MAX = 500
export const API_SEARCH_MIN = 2
export const API_SEARCH_MAX = 100
/** Stránka, po které se čte „všechno" (souhrn, partneři bez limitu). */
const FETCH_ALL_PAGE = 1000

export type Pagination = { limit?: number; offset?: number }
export type Page<T> = { items: T[]; next_offset: number | null; total?: number | null }

const intParam = z.coerce.number().int()
const boolParam = z.enum(['true', 'false', '1', '0']).transform((v) => v === 'true' || v === '1')

/** Partneři: stránkování volitelné (bez limit = všechno, bez stropu). */
export const paginationSchema = z
  .object({
    limit: intParam.min(1).max(API_PAGE_MAX).optional(),
    offset: intParam.min(0).optional(),
  })
  .strict()
  .refine((p) => p.offset === undefined || p.limit !== undefined, {
    message: 'offset requires limit',
    path: ['offset'],
  })

const searchParam = z.string().trim().min(API_SEARCH_MIN).max(API_SEARCH_MAX)

/** Klienti: limit (výchozí 100, max 500), offset, search, has_open_deal. */
export const accountListSchema = z.object({
  limit: intParam.min(1).max(API_PAGE_MAX).optional(),
  offset: intParam.min(0).optional(),
  search: searchParam.optional(),
  has_open_deal: boolParam.optional(),
}).strict()
export type AccountListParams = { limit?: number; offset?: number; search?: string; has_open_deal?: boolean }

/** Obchody: limit (výchozí 100, max 500), offset, search, account_id, only_open. */
export const dealListSchema = z.object({
  limit: intParam.min(1).max(API_PAGE_MAX).optional(),
  offset: intParam.min(0).optional(),
  search: searchParam.optional(),
  account_id: intParam.positive().optional(),
  only_open: boolParam.optional(),
}).strict()
export type DealListParams = { limit?: number; offset?: number; search?: string; account_id?: number; only_open?: boolean }

function paramsOf(params: URLSearchParams, keys: readonly string[]): Record<string, string> {
  const raw: Record<string, string> = {}
  for (const key of keys) {
    const v = params.get(key)
    if (v !== null) raw[key] = v
  }
  return raw
}

function parseWith<T>(schema: z.ZodType<T>, raw: Record<string, string>): { ok: true; value: T } | { ok: false; error: string } {
  const parsed = schema.safeParse(raw)
  if (!parsed.success) return { ok: false, error: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ') }
  return { ok: true, value: parsed.data }
}

export function parsePagination(params: URLSearchParams) {
  return parseWith<Pagination>(paginationSchema, paramsOf(params, ['limit', 'offset']))
}
export function parseAccountListParams(params: URLSearchParams) {
  return parseWith<AccountListParams>(accountListSchema, paramsOf(params, ['limit', 'offset', 'search', 'has_open_deal']))
}
export function parseDealListParams(params: URLSearchParams) {
  return parseWith<DealListParams>(dealListSchema, paramsOf(params, ['limit', 'offset', 'search', 'account_id', 'only_open']))
}

// ILIKE jako podřetězec: % _ \ se escapují; hodnota v .or() je v uvozovkách,
// ať čárka nebo závorka v hledaném textu nepřidá další podmínku filtru.
const likeContains = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`
const quoteOrValue = (v: string) => `"${v.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

type PagedResult = { data: unknown; error: unknown; count?: number | null }
type RangeQuery<Q> = { range: (from: number, to: number) => Q }

/** Jedna stránka: načte o řádek navíc, aby šlo poznat, zda existuje další. */
async function runPage<T, Q extends RangeQuery<Q> & PromiseLike<PagedResult>>(
  query: Q,
  limit: number,
  offset: number,
): Promise<Page<T>> {
  const { data, error, count } = await query.range(offset, offset + limit)
  if (error) throw error
  const rows = (data ?? []) as T[]
  const hasMore = rows.length > limit
  return {
    items: hasMore ? rows.slice(0, limit) : rows,
    next_offset: hasMore ? offset + limit : null,
    ...(typeof count === 'number' ? { total: count } : {}),
  }
}

/** Celý výsledek po stránkách (žádný tichý strop 1000 řádků). */
async function fetchAll<T>(page: (from: number, to: number) => PromiseLike<PagedResult>): Promise<T[]> {
  const out: T[] = []
  for (let from = 0; ; from += FETCH_ALL_PAGE) {
    const { data, error } = await page(from, from + FETCH_ALL_PAGE - 1)
    if (error) throw error
    const rows = (data ?? []) as T[]
    out.push(...rows)
    if (rows.length < FETCH_ALL_PAGE) return out
  }
}

// Řazení: původní primární klíč (name / created_at) zůstává kvůli
// stávajícím klientům, `id` jako tiebreaker dělá pořadí deterministické,
// takže offset stránkování nepřeskakuje ani neduplikuje řádky.

// ---------------------------------------------------------------------------
// Klienti

/** Úzký výčet sloupců klienta (bez poznámek a interních polí). */
export const API_ACCOUNT_COLUMNS = [
  'id', 'name', 'ico', 'industry', 'region', 'web', 'size_band', 'is_reference', 'client_since', 'created_at', 'updated_at',
  'owner:team_member!account_owner_id_fkey(id, full_name)',
  'referred_by:partner!account_referred_by_partner_id_fkey(id, name)',
].join(', ')

export type ApiAccount = {
  id: number; name: string; ico: string | null; industry: string | null; region: string | null; web: string | null
  size_band: string | null; is_reference: boolean; client_since: string | null; created_at: string; updated_at: string
  owner: { id: string; full_name: string } | null
  referred_by: { id: number; name: string } | null
}

export async function listAccountsPageForApi(p: AccountListParams = {}): Promise<Page<ApiAccount>> {
  const admin = createAdminClient()
  const limit = p.limit ?? API_PAGE_DEFAULT
  const offset = p.offset ?? 0
  // has_open_deal: vnořený filtr na obchody klienta v otevřené fázi.
  // true = inner join (jen klienti s otevřeným obchodem), false = anti-join
  // (vnořený seznam prázdný). Vnořené řádky se z výstupu odstraní.
  const openEmbed = p.has_open_deal === undefined
    ? ''
    : `, open_deals:deal!deal_account_id_fkey${p.has_open_deal ? '!inner' : ''}(id)`
  let q = admin.from('account').select(`${API_ACCOUNT_COLUMNS}${openEmbed}`, { count: 'exact' })
  if (p.has_open_deal !== undefined) {
    q = q.in('open_deals.stage', OPEN_DEAL_STAGE_FILTER)
    if (!p.has_open_deal) q = q.is('open_deals', null)
  }
  if (p.search) {
    const v = quoteOrValue(likeContains(p.search))
    q = q.or(`name.ilike.${v},ico.ilike.${v}`)
  }
  q = q.order('name').order('id')
  const page = await runPage<ApiAccount & { open_deals?: unknown }, typeof q>(q, limit, offset)
  return {
    ...page,
    items: page.items.map((row) => {
      if (!('open_deals' in row)) return row
      const { open_deals: _drop, ...rest } = row
      void _drop
      return rest
    }),
  }
}

// ---------------------------------------------------------------------------
// Obchody

/** Úzký výčet sloupců obchodu (bez poznámek, popisů problému a interních polí). */
export const API_DEAL_COLUMNS = [
  'id', 'account_id', 'title', 'stage', 'probability_pct', 'forecast_category', 'pillar', 'phase', 'revenue_line',
  'currency', 'amount_one_time', 'cogs_one_time', 'expected_mrr', 'estimate_md', 'expected_close', 'won_at', 'closed_at',
  'next_step', 'next_step_due', 'status_blocker', 'owner_id', 'last_activity_at', 'created_at', 'updated_at',
  'account:account!deal_account_id_fkey(id, name)',
  'channel:partner!deal_sourced_by_partner_fkey(id, name)',
].join(', ')

type Num = number | string | null
export type ApiDeal = {
  id: number; account_id: number; title: string; stage: string; probability_pct: number | null; forecast_category: string | null
  pillar: string | null; phase: string | null; revenue_line: string; currency: string
  amount_one_time: Num; cogs_one_time: Num; expected_mrr: Num; estimate_md: number | null
  expected_close: string | null; won_at: string | null; closed_at: string | null
  next_step: string | null; next_step_due: string | null; status_blocker: string | null; owner_id: string | null
  last_activity_at: string | null; created_at: string; updated_at: string
  account: { id: number; name: string } | null
  channel: { id: number; name: string } | null
}

export async function listDealsPageForApi(p: DealListParams = {}): Promise<Page<ApiDeal>> {
  const admin = createAdminClient()
  const limit = p.limit ?? API_PAGE_DEFAULT
  const offset = p.offset ?? 0
  let q = admin.from('deal').select(API_DEAL_COLUMNS, { count: 'exact' })
  if (p.account_id !== undefined) q = q.eq('account_id', p.account_id)
  if (p.only_open === true) q = q.in('stage', OPEN_DEAL_STAGE_FILTER)
  if (p.only_open === false) q = q.not('stage', 'in', `(${OPEN_DEAL_STAGE_FILTER.map((s) => quoteOrValue(s)).join(',')})`)
  if (p.search) q = q.ilike('title', likeContains(p.search))
  q = q.order('created_at', { ascending: false }).order('id')
  const page = await runPage<ApiDeal, typeof q>(q, limit, offset)
  return { ...page, items: normalizeDealRows(page.items) }
}

// ---------------------------------------------------------------------------
// Partneři (málo řádků: bez limitu všichni, ale po stránkách bez stropu)

export async function listPartnersPageForApi(p: Pagination = {}): Promise<Page<PartnerWithVia>> {
  const admin = createAdminClient()
  const base = () => admin.from('partner').select('*').order('name').order('id')
  const page: Page<Partner> = p.limit === undefined
    ? { items: await fetchAll<Partner>((from, to) => base().range(from, to)), next_offset: null }
    : await runPage<Partner, ReturnType<typeof base>>(base(), p.limit, p.offset ?? 0)
  const nameById = new Map(page.items.map((x) => [x.id, x.name]))
  // Na stránce nemusí být partner, přes kterého „via" vede — dohledej jména zvlášť.
  const missing = [...new Set(page.items.map((x) => x.via_partner_id).filter((id): id is NonNullable<typeof id> => !!id && !nameById.has(id)))]
  if (missing.length) {
    const { data, error } = await admin.from('partner').select('id, name').in('id', missing)
    if (error) throw error
    for (const r of (data ?? []) as { id: Partner['id']; name: string }[]) nameById.set(r.id, r.name)
  }
  return {
    next_offset: page.next_offset,
    items: page.items.map((x) => ({
      ...x,
      via: x.via_partner_id ? { id: x.via_partner_id, name: nameById.get(x.via_partner_id) ?? '' } : null,
    })),
  }
}

export async function listPartnersForApi(): Promise<PartnerWithVia[]> {
  return (await listPartnersPageForApi()).items
}

// ---------------------------------------------------------------------------
// Souhrn

/** Skupina by_phase pro obchody bez pilíře nebo fáze. */
export const UNASSIGNED_PHASE = 'nezařazeno'

export type ApiSummary = {
  /** Jen otevřené obchody (o co se ještě hraje). */
  pipeline_czk: number
  won_czk: number
  lost_czk: number
  /** Opakovaný příjem (expected_mrr): otevřené a vyhrané obchody zvlášť. */
  open_mrr_czk: number
  won_mrr_czk: number
  /** Náklady a marže JEN z otevřených obchodů se známým nákladem (cogs > 0). */
  total_cost_czk: number
  margin_czk: number
  margin_pct: number
  /** Z kolika otevřených obchodů se marže počítá a kolik náklad nemá vyplněný. */
  margin_deal_count: number
  deals_without_cost: number
  /** Odhad člověkodnů: otevřené a vyhrané zvlášť (prohrané se nepočítají). */
  total_md: number
  won_md: number
  /** Otevřené obchody (bez vyhraných, prohraných a odložených). */
  deal_count: number
  won_count: number
  lost_count: number
  postponed_count: number
  /** Otevřené obchody s blokerem. */
  blocked_count: number
  /** Jen otevřené obchody; bez pilíře nebo fáze ve skupině „nezařazeno". */
  by_phase: { pillar: string; phase: string; count: number; amount_czk: number }[]
}

export type SummaryDealRow = {
  stage: string | null
  amount_one_time: Num
  cogs_one_time: Num
  expected_mrr: Num
  estimate_md: Num
  status_blocker: string | null
  pillar: string | null
  phase: string | null
}

const SUMMARY_COLUMNS = 'stage, amount_one_time, cogs_one_time, expected_mrr, estimate_md, status_blocker, pillar, phase'

/** Čistá agregace (testovatelná bez DB). */
export function summarizeDealsForApi(deals: readonly SummaryDealRow[]): ApiSummary {
  const num = (v: unknown) => Number(v) || 0
  const sum = (list: readonly SummaryDealRow[], f: (d: SummaryDealRow) => number) => list.reduce((s, d) => s + f(d), 0)
  const stageOf = (d: SummaryDealRow) => normalizeDealStage(d.stage) ?? ''
  const open = deals.filter((d) => (OPEN_DEAL_STAGES as string[]).includes(stageOf(d)))
  const won = deals.filter((d) => stageOf(d) === 'vyhráno')
  const lost = deals.filter((d) => stageOf(d) === 'prohráno')
  const postponed = deals.filter((d) => stageOf(d) === 'odloženo')

  // Marže jen tam, kde je náklad známý: obchod s nulovým nákladem by jinak
  // vypadal jako 100% marže a celé číslo nadhodnotil.
  const withCost = open.filter((d) => num(d.cogs_one_time) > 0)
  const costRevenue = sum(withCost, (d) => num(d.amount_one_time))
  const total_cost_czk = sum(withCost, (d) => num(d.cogs_one_time))
  const margin_czk = costRevenue - total_cost_czk

  const byKey = new Map<string, { pillar: string; phase: string; count: number; amount_czk: number }>()
  for (const d of open) {
    const pillar = d.pillar || UNASSIGNED_PHASE
    const phase = d.pillar && d.phase ? d.phase : UNASSIGNED_PHASE
    const key = `${pillar}:${phase}`
    const row = byKey.get(key) ?? { pillar, phase, count: 0, amount_czk: 0 }
    row.count += 1
    row.amount_czk += num(d.amount_one_time)
    byKey.set(key, row)
  }

  return {
    pipeline_czk: sum(open, (d) => num(d.amount_one_time)),
    won_czk: sum(won, (d) => num(d.amount_one_time)),
    lost_czk: sum(lost, (d) => num(d.amount_one_time)),
    open_mrr_czk: sum(open, (d) => num(d.expected_mrr)),
    won_mrr_czk: sum(won, (d) => num(d.expected_mrr)),
    total_cost_czk,
    margin_czk,
    margin_pct: costRevenue ? Math.round((margin_czk / costRevenue) * 100) : 0,
    margin_deal_count: withCost.length,
    deals_without_cost: open.length - withCost.length,
    total_md: sum(open, (d) => num(d.estimate_md)),
    won_md: sum(won, (d) => num(d.estimate_md)),
    deal_count: open.length,
    won_count: won.length,
    lost_count: lost.length,
    postponed_count: postponed.length,
    blocked_count: open.filter((d) => !!d.status_blocker).length,
    by_phase: Array.from(byKey.values()),
  }
}

export async function getSummaryForApi(): Promise<ApiSummary> {
  const admin = createAdminClient()
  const deals = await fetchAll<SummaryDealRow>((from, to) =>
    admin.from('deal').select(SUMMARY_COLUMNS).order('id').range(from, to))
  return summarizeDealsForApi(deals)
}

// ---------------------------------------------------------------------------
// Záznamy z jednání (sales_activity — v DB jen pro obchodní role, 0020)

export const ACTIVITIES_PAGE_DEFAULT = 50
export const ACTIVITIES_PAGE_MAX = 200
/** Zápis z jednání může mít až 20 000 znaků; do seznamu jde jen začátek. */
export const ACTIVITY_BODY_PREVIEW = 2_000

const dayParam = z.string().trim().regex(/^\d{4}-\d{2}-\d{2}$/, 'since musí být datum YYYY-MM-DD')

/** Záznamy z jednání: limit (výchozí 50, max 200), offset, account_id, deal_id, since. */
export const activityListSchema = z.object({
  limit: intParam.min(1).max(ACTIVITIES_PAGE_MAX).optional(),
  offset: intParam.min(0).optional(),
  account_id: intParam.positive().optional(),
  deal_id: intParam.positive().optional(),
  since: dayParam.optional(),
}).strict()
export type ActivityListParams = { limit?: number; offset?: number; account_id?: number; deal_id?: number; since?: string }
export function parseActivityListParams(params: URLSearchParams) {
  return parseWith<ActivityListParams>(activityListSchema, paramsOf(params, ['limit', 'offset', 'account_id', 'deal_id', 'since']))
}

const API_ACTIVITY_COLUMNS =
  'id, account_id, partner_id, deal_id, contact_id, kind, outcome, subject, body, occurred_at, follow_up_on, source, created_by, created_at'

type ActivityRow = {
  id: number; account_id: number | null; partner_id: number | null; deal_id: number | null; contact_id: number | null
  kind: string; outcome: string; subject: string; body: string | null; occurred_at: string; follow_up_on: string | null
  source: string | null; created_by: string | null; created_at: string
}
export type ApiActivity = ActivityRow & {
  body_truncated: boolean
  account: { id: number; name: string } | null
  partner: { id: number; name: string } | null
}

/** Jména k id (jedním dotazem); chybějící řádek = bez jména. */
async function namesById(table: 'account' | 'partner', ids: (number | null)[]): Promise<Map<number, string>> {
  const unique = [...new Set(ids.filter((id): id is number => id != null))]
  const out = new Map<number, string>()
  if (unique.length === 0) return out
  const { data, error } = await createAdminClient().from(table).select('id, name').in('id', unique)
  if (error) throw error
  for (const r of (data ?? []) as { id: number; name: string }[]) out.set(r.id, r.name)
  return out
}

/** Začátek pražského dne `day` jako ISO okamžik (filtr „od data"). */
function pragueDayStartIso(day: string): string {
  return pragueLocalToUtc(`${day}T00:00`).toISOString()
}

export async function listActivitiesPageForApi(p: ActivityListParams = {}): Promise<Page<ApiActivity>> {
  const admin = createAdminClient()
  const limit = p.limit ?? ACTIVITIES_PAGE_DEFAULT
  const offset = p.offset ?? 0
  let q = admin.from('sales_activity').select(API_ACTIVITY_COLUMNS, { count: 'exact' })
  if (p.account_id !== undefined) q = q.eq('account_id', p.account_id)
  if (p.deal_id !== undefined) q = q.eq('deal_id', p.deal_id)
  if (p.since) q = q.gte('occurred_at', pragueDayStartIso(p.since))
  q = q.order('occurred_at', { ascending: false }).order('id', { ascending: false })
  const page = await runPage<ActivityRow, typeof q>(q, limit, offset)
  const [accounts, partners] = await Promise.all([
    namesById('account', page.items.map((r) => r.account_id)),
    namesById('partner', page.items.map((r) => r.partner_id)),
  ])
  return {
    ...page,
    items: page.items.map((r) => {
      const long = typeof r.body === 'string' && r.body.length > ACTIVITY_BODY_PREVIEW
      return {
        ...r,
        body: long ? (r.body as string).slice(0, ACTIVITY_BODY_PREVIEW) : r.body,
        body_truncated: long,
        account: r.account_id != null ? { id: r.account_id, name: accounts.get(r.account_id) ?? '' } : null,
        partner: r.partner_id != null ? { id: r.partner_id, name: partners.get(r.partner_id) ?? '' } : null,
      }
    }),
  }
}

// ---------------------------------------------------------------------------
// Úkoly

export const TASKS_PAGE_DEFAULT = 50
export const TASKS_PAGE_MAX = 200

/** Úkoly: limit, offset, only_mine (výchozí true), only_open (výchozí true). */
export const taskListSchema = z.object({
  limit: intParam.min(1).max(TASKS_PAGE_MAX).optional(),
  offset: intParam.min(0).optional(),
  only_mine: boolParam.optional(),
  only_open: boolParam.optional(),
}).strict()
export type TaskListParams = { limit?: number; offset?: number; only_mine?: boolean; only_open?: boolean }
export function parseTaskListParams(params: URLSearchParams) {
  return parseWith<TaskListParams>(taskListSchema, paramsOf(params, ['limit', 'offset', 'only_mine', 'only_open']))
}

const API_TASK_COLUMNS =
  'id, title, description, status, priority, assignee_id, created_by, due_on, account_id, deal_id, created_at, updated_at'

type TaskRow = {
  id: number; title: string; description: string | null; status: string; priority: string
  assignee_id: string | null; created_by: string | null; due_on: string | null
  account_id: number | null; deal_id: number | null; created_at: string; updated_at: string
}
export type ApiTask = TaskRow & { account: { id: number; name: string } | null }

/**
 * Úkoly: výchozí jen moje (řešitel = vlastník klíče) a jen otevřené (bez
 * hotových), seřazené podle termínu (bez termínu na konci). Vazbu na obchod
 * (deal_id) vidí jen obchodní role; ostatním se vrací null.
 */
export async function listTasksPageForApi(
  p: TaskListParams & { meId: string | null; canSeeSales: boolean },
): Promise<Page<ApiTask>> {
  const onlyMine = p.only_mine ?? true
  const onlyOpen = p.only_open ?? true
  const limit = p.limit ?? TASKS_PAGE_DEFAULT
  const offset = p.offset ?? 0
  // „Moje" bez vlastníka klíče = nikdo; prázdná stránka místo všech úkolů.
  if (onlyMine && !p.meId) return { items: [], next_offset: null, total: 0 }
  let q = createAdminClient().from('task').select(API_TASK_COLUMNS, { count: 'exact' })
  if (onlyMine) q = q.eq('assignee_id', p.meId as string)
  if (onlyOpen) q = q.neq('status', 'done')
  q = q.order('due_on', { ascending: true, nullsFirst: false }).order('id')
  const page = await runPage<TaskRow, typeof q>(q, limit, offset)
  const accounts = await namesById('account', page.items.map((r) => r.account_id))
  return {
    ...page,
    items: page.items.map((r) => ({
      ...r,
      deal_id: p.canSeeSales ? r.deal_id : null,
      account: r.account_id != null ? { id: r.account_id, name: accounts.get(r.account_id) ?? '' } : null,
    })),
  }
}

// ---------------------------------------------------------------------------
// Čekající žádosti o schválení (jen čtení; rozhoduje se v Cockpitu)

export const APPROVALS_PAGE_DEFAULT = 50
export const APPROVALS_PAGE_MAX = 200
/** Čekajících žádostí je málo; čte se nejvýš tolik a stránkuje se v paměti. */
const APPROVALS_FETCH_MAX = 1_000

export const approvalListSchema = z.object({
  limit: intParam.min(1).max(APPROVALS_PAGE_MAX).optional(),
  offset: intParam.min(0).optional(),
}).strict()
export function parseApprovalListParams(params: URLSearchParams) {
  return parseWith<Pagination>(approvalListSchema, paramsOf(params, ['limit', 'offset']))
}

type ApprovalRow = {
  id: number; case_id: number | null; action_kind: string; requested_level: string; requested_by: string
  created_at: string; expires_at: string | null
  node?: string | null; action_type?: string | null; target_table?: string | null; target_id?: number | null
  params?: unknown; snoozed_until?: string | null
}
export type ApiApproval = {
  id: number; case_id: number | null; case_title: string | null
  action_kind: string; action_type: string | null; action_label: string | null
  requested_level: string; requested_by: string; node: string | null
  created_at: string; expires_at: string | null; expired: boolean; snoozed_until: string | null
  /** Jen u známých druhů akce a jen bezpečná pole (viz core/approvalActions.ts). */
  params: Record<string, unknown> | null
}
export type ApprovalsPage = Page<ApiApproval> & { unavailable?: true }

const APPROVAL_BASE_COLUMNS = 'id, case_id, action_kind, requested_level, requested_by, created_at, expires_at'
const APPROVAL_NODE_COLUMN = ', node'
const APPROVAL_ACTION_COLUMNS_API = ', action_type, target_table, target_id, params, snoozed_until'

const isMissingColumnErr = (e: { code?: string } | null | undefined) => e?.code === '42703' || e?.code === 'PGRST204'
const isMissingTableErr = (e: { code?: string } | null | undefined) => e?.code === '42P01' || e?.code === 'PGRST205'

function approvalParams(row: ApprovalRow): Record<string, unknown> | null {
  if (row.action_type === 'send_offer') {
    const p = offerParams(row.params)
    return p ? { deal_id: p.deal_id, version_id: p.version_id, version: p.version } : null
  }
  if (row.action_type === 'confirm_next_step') {
    const p = nextStepParams(row.params)
    return p ? { title: p.title, assignee_id: p.assignee_id, due_on: p.due_on } : null
  }
  return null
}

/**
 * Čekající žádosti o schválení, nejstarší první. Žádost o odeslání nabídky
 * (send_offer) nese obchodní údaj (0084), proto ji vidí jen obchodní role.
 * Před migracemi 0057/0084 chybí sloupce uzlu a akce — dotaz se zopakuje bez
 * nich; bez tabulky (0039) prázdná stránka s `unavailable`.
 */
export async function listApprovalsPageForApi(
  p: Pagination & { canSeeSales: boolean; now?: Date },
): Promise<ApprovalsPage> {
  const admin = createAdminClient()
  const limit = p.limit ?? APPROVALS_PAGE_DEFAULT
  const offset = p.offset ?? 0
  const now = (p.now ?? new Date()).getTime()
  const query = (cols: string) => admin.from('approval_request').select(cols)
    .eq('status', 'pending').order('created_at', { ascending: true }).order('id').range(0, APPROVALS_FETCH_MAX - 1)
  let res = await query(APPROVAL_BASE_COLUMNS + APPROVAL_NODE_COLUMN + APPROVAL_ACTION_COLUMNS_API)
  if (isMissingColumnErr(res.error)) res = await query(APPROVAL_BASE_COLUMNS + APPROVAL_NODE_COLUMN)
  if (isMissingColumnErr(res.error)) res = await query(APPROVAL_BASE_COLUMNS)
  if (isMissingTableErr(res.error)) return { items: [], next_offset: null, total: 0, unavailable: true }
  if (res.error) throw res.error

  const visible = ((res.data ?? []) as unknown as ApprovalRow[])
    .filter((r) => p.canSeeSales || (r.action_type !== 'send_offer' && r.target_table !== 'deal_scope_version'))
  const slice = visible.slice(offset, offset + limit)

  const caseIds = [...new Set(slice.map((r) => r.case_id).filter((id): id is number => id != null))]
  const titles = new Map<number, string>()
  if (caseIds.length > 0) {
    const { data, error } = await admin.from('work_case').select('id, title').in('id', caseIds)
    if (error) throw error
    for (const r of (data ?? []) as { id: number; title: string }[]) titles.set(r.id, r.title)
  }

  return {
    total: visible.length,
    next_offset: offset + limit < visible.length ? offset + limit : null,
    items: slice.map((r) => ({
      id: r.id,
      case_id: r.case_id,
      case_title: r.case_id != null ? (titles.get(r.case_id) ?? null) : null,
      action_kind: r.action_kind,
      action_type: r.action_type ?? null,
      action_label: isApprovalActionType(r.action_type) ? APPROVAL_ACTIONS[r.action_type].label : null,
      requested_level: r.requested_level,
      requested_by: r.requested_by,
      node: r.node ?? null,
      created_at: r.created_at,
      expires_at: r.expires_at,
      expired: r.expires_at != null && Date.parse(r.expires_at) <= now,
      snoozed_until: r.snoozed_until ?? null,
      params: approvalParams(r),
    })),
  }
}
