import { createClient } from '@/lib/supabase/server'
import { normalizeDealRows } from '@/lib/dealStageLegacy'
import type { Deal, DeliveryPhase } from '@/lib/types'
import { pragueToday } from '@/lib/pragueDate'
import { listDealPublic, type DealPublicRow } from '@/lib/queries/dealPublic'
import { logError } from '@/lib/log'
import { engagementKindLabel } from '@/lib/domain'

// Všechny projekty napříč klienty — s klientem a kanálem — pro pilířový přehled.
export type ProjectRow = Deal & {
  account: { id: number; name: string } | null
  channel: { id: number; name: string } | null
}
export async function getAllProjects(): Promise<ProjectRow[]> {
  const s = await createClient()
  const { data, error } = await s.from('deal')
    .select('*, account:account!deal_account_id_fkey(id, name), channel:partner!deal_sourced_by_partner_fkey(id, name)')
    .order('created_at', { ascending: false })
  if (error) throw error
  return normalizeDealRows((data ?? []) as unknown as ProjectRow[])
}

// Projekty pro role bez obchodu (projekťák, lektor, partner). Od 0058 na
// tabulku deal nevidí, a ani nemají: přehled se skládá z dodávek
// (engagement) a z deal_public jen název navázaného obchodu a „vyhráno".
// Žádné částky, náklady, marže ani MD z obchodu.
export type DeliveryProjectRow = {
  id: number // engagement.id
  account: { id: number; name: string } | null
  kind: string
  phase: DeliveryPhase
  started_on: string | null
  due_on: string | null
  deal_id: number | null
  /** Název navázaného obchodu z deal_public; null = bez obchodu / nedostupný. */
  deal_title: string | null
  deal_is_won: boolean
}

export type EngagementListRow = {
  id: number; account_id: number; deal_id: number | null; kind: string
  phase: DeliveryPhase; started_on: string | null; due_on: string | null
  account: { name: string } | { name: string }[] | null
}

export function buildDeliveryProjects(rows: EngagementListRow[], deals: DealPublicRow[]): DeliveryProjectRow[] {
  const byId = new Map(deals.map((d) => [d.id, d]))
  return rows.map((e) => {
    const acc = Array.isArray(e.account) ? e.account[0] ?? null : e.account
    // Obchod se ukáže jen, když patří ke stejné firmě jako dodávka.
    const deal = e.deal_id !== null ? byId.get(e.deal_id) : undefined
    const linked = deal && deal.account_id === e.account_id ? deal : undefined
    return {
      id: e.id,
      account: acc ? { id: e.account_id, name: acc.name } : null,
      kind: e.kind,
      phase: e.phase,
      started_on: e.started_on,
      due_on: e.due_on,
      deal_id: e.deal_id,
      deal_title: linked?.title ?? null,
      deal_is_won: linked?.is_won ?? false,
    }
  })
}

/** Popisek projektu: název navázaného obchodu, jinak druh dodávky + firma. */
export function deliveryProjectTitle(p: DeliveryProjectRow): string {
  return p.deal_title ?? `${engagementKindLabel(p.kind)}${p.account ? ` · ${p.account.name}` : ''}`
}

/** Po termínu = neuzavřená dodávka s due_on před dneškem (pražský den). */
export function isDeliveryOverdue(p: DeliveryProjectRow, today: string): boolean {
  return p.phase !== 'uzavreno' && !!p.due_on && p.due_on < today
}

export async function getDeliveryProjects(): Promise<DeliveryProjectRow[]> {
  const s = await createClient()
  const [eng, deals] = await Promise.all([
    s.from('engagement')
      .select('id, account_id, deal_id, kind, phase, started_on, due_on, account(name)')
      .order('due_on', { ascending: true, nullsFirst: false }),
    listDealPublic(s, null),
  ])
  if (eng.error) throw eng.error
  // Názvy obchodů jsou jen popisek — když deal_public selže (např. chybí
  // AAL2), přehled dodávek se ukáže i bez nich.
  if (!deals.ok) logError('dashboard.deliveryProjects.dealPublic', deals.error)
  return buildDeliveryProjects((eng.data ?? []) as unknown as EngagementListRow[], deals.ok ? deals.rows : [])
}

export interface PipelineByLine {
  revenue_line: string; revenue_category: string; deals: number
  gross_one_time: string | null; client_paid: string | null
  subsidy_covered: string | null; weighted_pipeline: string | null
}
export interface PartnerAttribution {
  name: string; program: string; deals: number
  attributed_one_time: string | null; nnpsa_target_total: number | null
}
export interface AccountRollup {
  id: number; name: string; contracted_one_time: string | null
  running_mrr: string | null; at_risk_mrr: string | null
}
export interface DeliveryHealth {
  phase: string; engagements: number; with_post_audit: number; reference_worthy: number
}
export interface ReferencePipeline {
  name: string; adoption_delta_pp: string | null; trained_count: number | null
  time_saved_min_week: number | null; nnpsa: number | null
  approved_public: boolean | null; used_in_deals: number | null
}

export interface OverdueEngagement {
  id: number; account_id: number; account_name: string
  kind: string; phase: string; due_on: string | null
}

export async function getPipelineByLine(): Promise<PipelineByLine[]> {
  const s = await createClient()
  const { data, error } = await s.from('v_pipeline_by_line').select('*')
  if (error) throw error
  return data ?? []
}

// "Needs attention": engagements past their due date and not yet closed.
// Derived filter, no new table (per spec).
export async function getOverdueEngagements(): Promise<OverdueEngagement[]> {
  const s = await createClient()
  // due_on je DATE → pražský den (UTC by mezi půlnocí a 1–2 h ráno dávalo včerejšek).
  const today = pragueToday()
  const { data, error } = await s.from('engagement')
    .select('id, account_id, kind, phase, due_on, account(name)')
    .lt('due_on', today).neq('phase', 'uzavreno').order('due_on')
  if (error) throw error
  type Row = {
    id: number; account_id: number; kind: string; phase: string
    due_on: string | null; account: { name: string } | null
  }
  return ((data ?? []) as unknown as Row[]).map((e) => ({
    id: e.id, account_id: e.account_id, account_name: e.account?.name ?? '',
    kind: e.kind, phase: e.phase, due_on: e.due_on,
  }))
}
export async function getPartnerAttribution(): Promise<PartnerAttribution[]> {
  const s = await createClient()
  const { data, error } = await s.from('v_partner_attribution').select('*')
  if (error) throw error
  return data ?? []
}
export async function getAccountRollup(): Promise<AccountRollup[]> {
  const s = await createClient()
  // Jen firmy s nasmlouvanou částkou: pohled má řádek pro KAŽDOU firmu
  // (COALESCE → 0), po importu radaru ~663 řádků, z nichž /pipeline stejně
  // ukazuje jen nenulové.
  const { data, error } = await s.from('v_account_rollup')
    .select('*').neq('contracted_one_time', 0).order('contracted_one_time', { ascending: false })
  if (error) throw error
  return data ?? []
}
export async function getDeliveryHealth(): Promise<DeliveryHealth[]> {
  const s = await createClient()
  const { data, error } = await s.from('v_delivery_health').select('*')
  if (error) throw error
  return data ?? []
}
export async function getReferencePipeline(): Promise<ReferencePipeline[]> {
  const s = await createClient()
  const { data, error } = await s.from('v_reference_pipeline').select('*')
  if (error) throw error
  return data ?? []
}

export interface ContractedOverTime { month: string; amount: number }

// Chybějící pohled (migrace 0046 ještě nenasazená): Postgres 42P01,
// PostgREST PGRST205. Pak padáme na výpočet v JS — pořadí nasazení je jedno.
export function isMissingRelation(error: { code?: string } | null | undefined): boolean {
  return error?.code === '42P01' || error?.code === 'PGRST205'
}

export type WonDealRow = { won_at: string | null; amount_one_time: string | number | null }

// Vyhrané obchody po měsících (YYYY-MM) pro trendový graf.
// Sémantika shodná s v_contracted_over_time (0046):
//   * měsíc = won_at.slice(0, 7); won_at je DATE (bez času/zóny) → SQL
//     to_char(won_at, 'YYYY-MM'); žádný převod do Europe/Prague ani UTC.
//   * měna: amount_one_time je vždy v Kč (0016), žádný FX převod.
//   * řádky bez won_at se přeskakují; NULL/nečíselná částka = 0.
// Volající předává jen stage = 'vyhráno'.
export function bucketContractedByMonth(rows: WonDealRow[]): ContractedOverTime[] {
  const buckets = new Map<string, number>()
  for (const r of rows) {
    if (!r.won_at) continue
    const month = r.won_at.slice(0, 7)
    buckets.set(month, (buckets.get(month) ?? 0) + (Number(r.amount_one_time) || 0))
  }
  return [...buckets.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([month, amount]) => ({ month, amount }))
}

export async function getContractedOverTime(): Promise<ContractedOverTime[]> {
  const s = await createClient()
  const view = await s.from('v_contracted_over_time').select('month, amount').order('month')
  if (!view.error) {
    type V = { month: string; amount: string | number | null }
    return ((view.data ?? []) as unknown as V[]).map((r) => ({ month: r.month, amount: Number(r.amount) || 0 }))
  }
  if (!isMissingRelation(view.error)) throw view.error
  const { data, error } = await s.from('deal')
    .select('won_at, amount_one_time, stage')
    .eq('stage', 'vyhráno')
  if (error) throw error
  return bucketContractedByMonth((data ?? []) as unknown as WonDealRow[])
}

export interface ImpactSummary {
  proofRatePct: number
  engagementsTotal: number; withAudit: number
  trainedTotal: number; hoursPerWeek: number; roiTotal: number; referenceCount: number
}

// Surové součty — přesně to, co vrací v_impact_summary (0046). NULL = 0.
export interface ImpactTotals {
  engagementsTotal: number; withAudit: number; trainedTotal: number
  minutesPerWeek: number; roiTotal: number; referenceCount: number
}

export type EngagementImpactRow = {
  post_adoption_pct: string | number | null
  post_captured_on: string | null
  trained_count: number | null
  time_saved_min_week: number | null
  roi_czk_year: string | number | null
  reference_worthy: boolean
}

// JS obdoba v_impact_summary: with_audit = post_adoption_pct NEBO
// post_captured_on vyplněné; roi_czk_year je v Kč, bez FX.
export function sumImpact(rows: EngagementImpactRow[]): ImpactTotals {
  return {
    engagementsTotal: rows.length,
    withAudit: rows.filter((e) => e.post_adoption_pct != null || e.post_captured_on != null).length,
    trainedTotal: rows.reduce((n, e) => n + (Number(e.trained_count) || 0), 0),
    minutesPerWeek: rows.reduce((n, e) => n + (Number(e.time_saved_min_week) || 0), 0),
    roiTotal: rows.reduce((n, e) => n + (Number(e.roi_czk_year) || 0), 0),
    referenceCount: rows.filter((e) => e.reference_worthy).length,
  }
}

// Zaokrouhlení dělá vždy TS (pro pohled i fallback stejně).
export function deriveImpactSummary(t: ImpactTotals): ImpactSummary {
  return {
    proofRatePct: t.engagementsTotal ? Math.round((t.withAudit / t.engagementsTotal) * 100) : 0,
    engagementsTotal: t.engagementsTotal, withAudit: t.withAudit,
    trainedTotal: t.trainedTotal, hoursPerWeek: Math.round(t.minutesPerWeek / 60),
    roiTotal: t.roiTotal, referenceCount: t.referenceCount,
  }
}

export async function getImpactSummary(): Promise<ImpactSummary> {
  const s = await createClient()
  const view = await s.from('v_impact_summary').select('*').maybeSingle()
  if (!view.error) {
    const v = (view.data ?? {}) as Record<string, string | number | null>
    return deriveImpactSummary({
      engagementsTotal: Number(v.engagements_total) || 0, withAudit: Number(v.with_audit) || 0,
      trainedTotal: Number(v.trained_total) || 0, minutesPerWeek: Number(v.minutes_per_week) || 0,
      roiTotal: Number(v.roi_total) || 0, referenceCount: Number(v.reference_count) || 0,
    })
  }
  if (!isMissingRelation(view.error)) throw view.error
  const { data, error } = await s.from('engagement')
    .select('post_adoption_pct, post_captured_on, trained_count, time_saved_min_week, roi_czk_year, reference_worthy')
  if (error) throw error
  return deriveImpactSummary(sumImpact((data ?? []) as unknown as EngagementImpactRow[]))
}
