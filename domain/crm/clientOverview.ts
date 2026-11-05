// Přehled klienta (/clients/[id]) — čisté funkce bez I/O. Z dat, která detail
// už načítá (obchody, dodávky, úkoly, aktivity), počítají shrnutí pro horní
// část stránky: další krok, tři velká čísla, „aktivní dny". Nic se nevymýšlí:
// co se ze skutečných dat spočítat nedá, se nevrací (null / prázdné).
// Testy: test/client-overview.test.ts.

import { isOpenDeal } from '@/domain/crm/sales'
import { dealStageLabel, deliveryPhaseLabel } from '@/lib/domain'
import { addDaysToPragueDay, daysBetweenPragueDays, pragueDayOf } from '@/lib/pragueDate'
import type { Deal, Engagement, Task } from '@/lib/types'

/** Slovo podle počtu: 1 den, 2–4 dny, 5+ dní. */
export function czPlural(n: number, forms: readonly [string, string, string]): string {
  const abs = Math.abs(n)
  if (abs === 1) return forms[0]
  if (abs >= 2 && abs <= 4) return forms[1]
  return forms[2]
}

const DAYS = ['den', 'dny', 'dní'] as const

/** Krátký popis termínu vůči dnešku: „dnes", „zítra", „za 3 dny", „po termínu o 2 dny". */
export function describeDue(due: string | null | undefined, today: string): string {
  if (!due) return 'bez termínu'
  const diff = daysBetweenPragueDays(today, due.slice(0, 10))
  if (diff === 0) return 'dnes'
  if (diff === 1) return 'zítra'
  if (diff > 1) return `za ${diff} ${czPlural(diff, DAYS)}`
  return `po termínu o ${-diff} ${czPlural(diff, DAYS)}`
}

export type NextStep = {
  title: string
  due: string | null
  /** odkud krok je: obchod (další krok obchodu) nebo úkol */
  source: 'deal' | 'task'
  /** k čemu se krok váže (název obchodu), pokud ho má */
  context: string | null
}

type DealForStep = Pick<Deal, 'stage' | 'title' | 'next_step' | 'next_step_due'>
type TaskForStep = Pick<Task, 'status' | 'title' | 'due_on'>

// Termín dřív = dřív na řadě; bez termínu až za všemi s termínem.
const byDue = (a: NextStep, b: NextStep) => {
  if (a.due && b.due) return a.due.localeCompare(b.due)
  if (a.due) return -1
  if (b.due) return 1
  return 0
}

/**
 * Nejbližší další krok firmy. Kandidáti: „další krok" otevřených obchodů
 * (jen s vyplněným textem) a otevřené úkoly. Vyhrává nejbližší termín;
 * krok s termínem má přednost před krokem bez termínu. Žádný kandidát → null
 * (stránka ukáže klidný prázdný stav, nic nedoplňuje).
 */
export function pickNextStep(deals: DealForStep[], tasks: TaskForStep[]): NextStep | null {
  const candidates: NextStep[] = []
  for (const d of deals) {
    if (!isOpenDeal(d.stage)) continue
    const text = d.next_step?.trim()
    if (!text) continue
    candidates.push({ title: text, due: d.next_step_due, source: 'deal', context: d.title })
  }
  for (const t of tasks) {
    if (t.status === 'done') continue
    candidates.push({ title: t.title, due: t.due_on, source: 'task', context: null })
  }
  candidates.sort(byDue)
  return candidates[0] ?? null
}

export type DealSummary = {
  total: number
  open: number
  won: number
  /** součet částek otevřených obchodů (Kč) */
  openAmount: number
  /** nejbližší otevřený obchod k řešení: nejvyšší fáze, pak nejvyšší částka */
  lead: { title: string; stageLabel: string } | null
}

export function summarizeDeals(deals: Pick<Deal, 'stage' | 'title' | 'amount_one_time'>[]): DealSummary {
  const open = deals.filter((d) => isOpenDeal(d.stage))
  const lead = [...open].sort((a, b) => Number(b.amount_one_time ?? 0) - Number(a.amount_one_time ?? 0))[0]
  return {
    total: deals.length,
    open: open.length,
    won: deals.filter((d) => d.stage === 'vyhráno').length,
    openAmount: open.reduce((s, d) => s + Number(d.amount_one_time ?? 0), 0),
    lead: lead ? { title: lead.title, stageLabel: dealStageLabel(lead.stage) } : null,
  }
}

export type EngagementSummary = {
  total: number
  running: number
  closed: number
  referenceWorthy: number
  /** nejnovější běžící dodávka a její fáze */
  current: { kind: string; phaseLabel: string } | null
}

export function summarizeEngagements(engagements: Pick<Engagement, 'kind' | 'phase' | 'reference_worthy'>[]): EngagementSummary {
  const running = engagements.filter((e) => e.phase !== 'uzavreno')
  const first = running[0] // dotaz řadí od nejnovější
  return {
    total: engagements.length,
    running: running.length,
    closed: engagements.length - running.length,
    referenceWorthy: engagements.filter((e) => e.reference_worthy).length,
    current: first ? { kind: first.kind, phaseLabel: deliveryPhaseLabel(first.phase) } : null,
  }
}

export type TaskSummary = {
  open: number
  overdue: number
  /** do 7 dní včetně dneška (bez těch po termínu) */
  thisWeek: number
  highPriority: number
  nearestDue: string | null
}

export function summarizeTasks(tasks: Pick<Task, 'status' | 'due_on' | 'priority'>[], today: string): TaskSummary {
  const open = tasks.filter((t) => t.status !== 'done')
  const soon = addDaysToPragueDay(today, 7)
  const dated = open.filter((t) => t.due_on).map((t) => t.due_on as string).sort()
  return {
    open: open.length,
    overdue: open.filter((t) => t.due_on && t.due_on < today).length,
    thisWeek: open.filter((t) => t.due_on && t.due_on >= today && t.due_on <= soon).length,
    highPriority: open.filter((t) => t.priority === 'high').length,
    nearestDue: dated.find((d) => d >= today) ?? dated[0] ?? null,
  }
}

export type ClientStatus = 'aktivni' | 'klient' | 'prospekt'

/**
 * Stav firmy stejně jako v seznamu (domain/crm/accountList.accountStatus):
 * otevřený obchod = aktivní; vyhraný obchod nebo „Klient od" = klient;
 * jinak prospekt. Obchody vidí jen obchodní role — ostatním `deals` chybí,
 * takže rozhoduje jen „Klient od".
 */
export function clientStatus(
  account: { client_since: string | null },
  deals: Pick<Deal, 'stage'>[],
): ClientStatus {
  if (deals.some((d) => isOpenDeal(d.stage))) return 'aktivni'
  if (account.client_since || deals.some((d) => d.stage === 'vyhráno')) return 'klient'
  return 'prospekt'
}

export const CLIENT_STATUS_TEXT: Record<ClientStatus, string> = {
  aktivni: 'Aktivní klient',
  klient: 'Klient',
  prospekt: 'Prospekt',
}

export const ACTIVE_DAYS_WEEKS = 14

export type ActiveDaysCell = { day: string; active: boolean; future: boolean }
export type ActiveDays = {
  /** po sloupcích (týdnech), v každém 7 dní Po–Ne; celkem weeks × 7 */
  cells: ActiveDaysCell[]
  /** počet dní s aspoň jednou aktivitou v zobrazeném období */
  activeCount: number
  weeks: number
}

/**
 * Tečková matice „aktivní dny": posledních `weeks` týdnů (pražský kalendář,
 * týden začíná pondělím), den je aktivní, pokud má aspoň jednu aktivitu.
 */
export function buildActiveDays(
  activities: { occurred_at: string }[],
  today: string,
  weeks = ACTIVE_DAYS_WEEKS,
): ActiveDays {
  const [y, m, d] = today.split('-').map(Number)
  const weekday = (new Date(Date.UTC(y, m - 1, d)).getUTCDay() + 6) % 7 // 0 = pondělí
  const start = addDaysToPragueDay(today, -weekday - (weeks - 1) * 7)
  const activeDays = new Set(activities.map((a) => pragueDayOf(a.occurred_at)))
  const cells: ActiveDaysCell[] = []
  let activeCount = 0
  for (let i = 0; i < weeks * 7; i++) {
    const day = addDaysToPragueDay(start, i)
    const future = day > today
    const active = !future && activeDays.has(day)
    if (active) activeCount++
    cells.push({ day, active, future })
  }
  return { cells, activeCount, weeks }
}
