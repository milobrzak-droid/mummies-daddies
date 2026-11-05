import { defaultProbabilityForStage, OPEN_DEAL_STAGE_KEYS } from '@/lib/domain'
import { normalizeDealStage, withLegacyDealStages } from '@/lib/dealStageLegacy'
import type { Deal, DealStage, SalesActivity, TeamMember } from '@/lib/types'
import { addDaysToPragueDay, pragueDayOf as pragueInstantDay, pragueToday } from '@/lib/pragueDate'

// Odvozeno z DEAL_STAGES (příznak `open`) v lib/domain.ts.
export const OPEN_DEAL_STAGES: DealStage[] = [...OPEN_DEAL_STAGE_KEYS]

// Pro filtr v DB (`.in('stage', OPEN_DEAL_STAGE_FILTER)`): otevřené fáze
// plus staré hodnoty, které se na ně převádějí (lib/dealStageLegacy.ts) —
// obchod, který ještě neprošel migrací 0050, tak nevypadne z hlídače,
// oslovování ani plánování schůzek.
export const OPEN_DEAL_STAGE_FILTER: string[] = withLegacyDealStages(OPEN_DEAL_STAGES)

export type SalesDealLike = Deal & {
  account: { id: number; name: string } | null
  owner: { id: string; full_name: string; email?: string } | null
  primary_contact: { id: number; full_name: string } | null
}

export type SalesActivityLike = SalesActivity & {
  account?: { id: number; name: string } | null
  deal?: { id: number; title: string } | null
  contact?: { id: number; full_name: string } | null
  author?: { id: string; full_name: string } | null
}

export type SalesLeaderboardRow = {
  ownerId: string | null
  ownerName: string
  openPipeline: number
  weightedPipeline: number
  wonThisMonth: number
  activities30d: number
  overdueNextSteps: number
}

export type SalesFocusReason = 'overdue' | 'missing_next_step' | 'closing_soon' | 'stale'

export type SalesFocusItem = {
  deal: SalesDealLike
  reason: SalesFocusReason
  label: string
  recommendation: string
  priority: number
}

export type SalesDashboard = {
  openPipeline: number
  weightedPipeline: number
  wonThisMonth: number
  closing30d: number
  conversionPct: number
  overdueDeals: SalesDealLike[]
  staleDeals: SalesDealLike[]
  focus: SalesFocusItem[]
  leaderboard: SalesLeaderboardRow[]
}

const money = (value: unknown) => Number(value) || 0

// Kalendářní den v Praze (YYYY-MM-DD). Měsíční součty se počítají podle
// pražského kalendáře, ne UTC (1. 9. 01:30 Praha = 31. 8. UTC patří do září).
// Čisté datum bereme tak, jak je; časové razítko převedeme na pražský den.
const pragueDayOf = (value: string | null | undefined): string => {
  if (!value) return ''
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value
  const d = new Date(value)
  return Number.isNaN(d.getTime()) ? value.slice(0, 10) : pragueInstantDay(d)
}

// Snese i starou hodnotu z DB (před migrací 0050).
export function isOpenDeal(stage: DealStage | string | null | undefined): boolean {
  return (OPEN_DEAL_STAGES as string[]).includes(normalizeDealStage(stage) ?? '')
}

// Ručně nastavená pravděpodobnost = vyplněná a jiná než výchozí hodnota
// fáze, ve které obchod právě je (updateDealStage ji při přetažení nechá).
export function hasManualProbability(deal: { stage?: string | null; probability_pct?: number | string | null }): boolean {
  if (deal.probability_pct == null || deal.probability_pct === '') return false
  return Number(deal.probability_pct) !== defaultProbabilityForStage(deal.stage)
}

export function weightedValue(deal: Pick<Deal, 'amount_one_time' | 'probability_pct' | 'stage'>): number {
  const probability = deal.probability_pct ?? defaultProbabilityForStage(deal.stage)
  return money(deal.amount_one_time) * probability / 100
}

export function buildSalesFocus(deals: SalesDealLike[], now = new Date()): SalesFocusItem[] {
  // next_step_due / expected_close jsou DATE → porovnávají se s pražským
  // dnem (mezi půlnocí a 1–2 h ráno by UTC dávalo včerejšek).
  const today = pragueToday(now)
  const soon = addDaysToPragueDay(today, 7)
  const staleDate = new Date(now)
  staleDate.setUTCDate(staleDate.getUTCDate() - 14)
  const staleBefore = staleDate.toISOString()

  return deals
    .filter((deal) => isOpenDeal(deal.stage))
    .map((deal): SalesFocusItem | null => {
      if (deal.next_step_due && deal.next_step_due < today) {
        return {
          deal,
          reason: 'overdue',
          label: 'Po termínu',
          recommendation: deal.next_step ? `Dokončit: ${deal.next_step}` : 'Domluvit další krok s klientem',
          priority: 400,
        }
      }
      if (!deal.next_step || !deal.next_step_due) {
        return {
          deal,
          reason: 'missing_next_step',
          label: 'Chybí plán',
          recommendation: 'Domluvit konkrétní další krok a termín',
          priority: 300,
        }
      }
      if (deal.expected_close && deal.expected_close >= today && deal.expected_close <= soon) {
        return {
          deal,
          reason: 'closing_soon',
          label: 'Uzavření do 7 dní',
          recommendation: `Potvrdit cestu k uzavření: ${deal.next_step}`,
          priority: 200,
        }
      }
      if ((deal.last_activity_at ?? deal.created_at) < staleBefore) {
        return {
          deal,
          reason: 'stale',
          label: '14 dní bez aktivity',
          recommendation: 'Obnovit kontakt a ověřit, zda obchod pokračuje',
          priority: 100,
        }
      }
      return null
    })
    .filter((item): item is SalesFocusItem => item !== null)
    .sort((a, b) =>
      b.priority - a.priority ||
      (a.deal.next_step_due ?? a.deal.expected_close ?? '9999').localeCompare(
        b.deal.next_step_due ?? b.deal.expected_close ?? '9999',
      ) ||
      money(b.deal.amount_one_time) - money(a.deal.amount_one_time),
    )
}

export function buildSalesDashboard(
  deals: SalesDealLike[],
  activities: SalesActivityLike[],
  members: Pick<TeamMember, 'id' | 'full_name' | 'role'>[],
  now = new Date(),
): SalesDashboard {
  const today = pragueToday(now)
  const monthStart = `${today.slice(0, 7)}-01`
  const in30Days = addDaysToPragueDay(today, 30)
  const staleBeforeDate = new Date(now)
  staleBeforeDate.setUTCDate(staleBeforeDate.getUTCDate() - 14)
  const staleBefore = staleBeforeDate.toISOString()
  const activity30dDate = new Date(now)
  activity30dDate.setUTCDate(activity30dDate.getUTCDate() - 30)
  const activity30d = activity30dDate.toISOString()

  const open = deals.filter((deal) => isOpenDeal(deal.stage))
  const wonThisMonthDeals = deals.filter((deal) =>
    deal.stage === 'vyhráno' && pragueDayOf(deal.won_at ?? deal.closed_at) >= monthStart,
  )
  const closedThisMonth = deals.filter((deal) =>
    (deal.stage === 'vyhráno' || deal.stage === 'prohráno') &&
    pragueDayOf(deal.closed_at ?? deal.won_at ?? deal.updated_at) >= monthStart,
  )

  const overdueDeals = open
    .filter((deal) => !!deal.next_step_due && deal.next_step_due < today)
    .sort((a, b) => (a.next_step_due ?? '').localeCompare(b.next_step_due ?? ''))

  const staleDeals = open
    .filter((deal) => (deal.last_activity_at ?? deal.created_at) < staleBefore)
    .sort((a, b) => (a.last_activity_at ?? a.created_at).localeCompare(b.last_activity_at ?? b.created_at))

  // Leaderboard ukazuje KAŽDÉHO vlastníka obchodu (rozhodnutí majitele 2026-09-28), ne jen
  // role obchodnik/vedeni. Členové s rolí obchodnik/vedeni se zobrazují vždy (i s nulami),
  // ostatní (např. projektak) se přidají jen tehdy, když vlastní aspoň jeden obchod — jinak
  // by leaderboard byl zahlcený lidmi bez obchodů.
  const salesRoleMembers = members.filter((member) => member.role === 'obchodnik' || member.role === 'vedeni')
  const ownerRowsById = new Map<string, string>(salesRoleMembers.map((member) => [member.id, member.full_name]))
  for (const dealItem of deals) {
    if (!dealItem.owner_id || ownerRowsById.has(dealItem.owner_id)) continue
    ownerRowsById.set(dealItem.owner_id, dealItem.owner?.full_name ?? dealItem.owner_id)
  }
  const ownerRows: { id: string | null; name: string }[] = [...ownerRowsById].map(([id, name]) => ({ id, name }))
  // Obchody bez vlastníka dostávají vlastní řádek "Nepřiřazeno" a POČÍTAJÍ SE do součtů
  // (nejsou vyloučené) — proto součet řádků leaderboardu vždy odpovídá celkovým číslům
  // v horní části dashboardu (openPipeline, weightedPipeline, wonThisMonth).
  if (deals.some((deal) => !deal.owner_id)) ownerRows.push({ id: null, name: 'Nepřiřazeno' })

  const leaderboard = ownerRows.map(({ id, name }) => {
    const owned = deals.filter((deal) => deal.owner_id === id)
    const ownedOpen = owned.filter((deal) => isOpenDeal(deal.stage))
    return {
      ownerId: id,
      ownerName: name,
      openPipeline: ownedOpen.reduce((sum, deal) => sum + money(deal.amount_one_time), 0),
      weightedPipeline: ownedOpen.reduce((sum, deal) => sum + weightedValue(deal), 0),
      wonThisMonth: owned
        .filter((deal) => deal.stage === 'vyhráno' && pragueDayOf(deal.won_at ?? deal.closed_at) >= monthStart)
        .reduce((sum, deal) => sum + money(deal.amount_one_time), 0),
      activities30d: activities.filter((activity) => activity.created_by === id && activity.occurred_at >= activity30d).length,
      overdueNextSteps: ownedOpen.filter((deal) => !!deal.next_step_due && deal.next_step_due < today).length,
    }
  }).sort((a, b) => b.wonThisMonth - a.wonThisMonth || b.weightedPipeline - a.weightedPipeline)

  return {
    openPipeline: open.reduce((sum, deal) => sum + money(deal.amount_one_time), 0),
    weightedPipeline: open.reduce((sum, deal) => sum + weightedValue(deal), 0),
    wonThisMonth: wonThisMonthDeals.reduce((sum, deal) => sum + money(deal.amount_one_time), 0),
    closing30d: open
      .filter((deal) => !!deal.expected_close && deal.expected_close >= today && deal.expected_close <= in30Days)
      .reduce((sum, deal) => sum + money(deal.amount_one_time), 0),
    conversionPct: closedThisMonth.length
      ? Math.round((wonThisMonthDeals.length / closedThisMonth.length) * 100)
      : 0,
    overdueDeals,
    staleDeals,
    focus: buildSalesFocus(deals, now),
    leaderboard,
  }
}
