// Portfolio dodávek: souhrn všech běžících dodávek pro vedení a obchodníka.
// Čisté funkce bez I/O (čtení dat je v domain/delivery/queries/portfolio.ts).
//
// Všechno, co se tu ukazuje, jde z dat; nic se nedopočítává „na oko":
//   po termínu   — termín dodávky (due_on) nebo termín neuzavřeného milníku
//                  je před dnešním pražským dnem;
//   blokované    — k dodávce visí otevřený úkol ve stavu „Blokováno";
//   čeká na klienta — aspoň jeden milník čeká na podklady (ceka_na_vstup)
//                  nebo na schválení klientem (ceka_na_schvaleni);
//   bez pohybu   — nic se nezměnilo aspoň STALE_DAYS dní. Pohyb = poslední
//                  úprava dodávky, milníku (i přijetí) nebo úkolu dodávky.
// Pořadí podle rizika je součet vah těchto signálů; důvody jsou vždy vidět.

import { DELIVERY_PHASES, deliveryPhaseLabel, engagementKindLabel } from '@/lib/domain'
import { daysBetweenPragueDays, pragueDayOf } from '@/lib/pragueDate'
import { impactDelta, formatDelta } from '@/domain/delivery/impact'
import { MILESTONE_STATUS_LABEL, isMilestoneStatus, type MilestoneStatus } from '@/domain/delivery/milestone'
import { WAITING_QUIET_DAYS } from '@/domain/delivery/waiting'

/** Od kolika dní bez pohybu je dodávka „bez pohybu". */
export const STALE_DAYS = 14

export type PortfolioEngagement = {
  id: number
  account_id: number
  account_name: string | null
  deal_id: number | null
  kind: string
  phase: string
  started_on: string | null
  due_on: string | null
  owner_id: string | null
  deputy_id: string | null
  updated_at: string | null
  reference_worthy: boolean
  /** Cíl a rozsah z předávacího balíčku (0054); undefined = sloupec chybí. */
  goal?: string | null
  scope?: string | null
  /** Čas předání do realizace; null = nepředáno, undefined = sloupec chybí. */
  handoff_completed_at?: string | null
}

export type PortfolioMilestone = {
  id: number
  engagement_id: number
  title: string
  owner_id: string | null
  deputy_id: string | null
  status: string
  due_on: string | null
  accepted_at: string | null
  updated_at: string | null
}

export type PortfolioTask = {
  engagement_id: number
  status: string
  updated_at: string | null
}

/** Přijatá verze nabídky (jen obchodní role ji smí číst). */
export type PortfolioOffer = { version: number; scope: string | null; decided_at: string | null }

export type PortfolioMeasure = {
  metric: string
  unit: string | null
  baseline: number | null
  actual: number | null
  observed_on: string
  id: number
}

export type PortfolioReferenceCard = { engagement_id: number; approved_public: boolean; consent_ok: boolean }

export type OwnerLoad = { load: number; capacity: number; overloaded: boolean }

export type PortfolioInput = {
  today: string
  engagements: readonly PortfolioEngagement[]
  /** null = milníky se nepodařilo načíst. */
  milestones: readonly PortfolioMilestone[] | null
  /** null = úkoly se nepodařilo načíst. */
  tasks: readonly PortfolioTask[] | null
  /** Přijatá nabídka podle id obchodu; null = obchodní role nesmí / nepodařilo se. */
  offers: ReadonlyMap<number, PortfolioOffer> | null
  dealTitles: ReadonlyMap<number, string>
  /** null = měření se nepodařilo načíst. */
  measures: readonly (PortfolioMeasure & { engagement_id: number })[] | null
  /** null = reference se nepodařilo načíst. */
  cards: readonly PortfolioReferenceCard[] | null
  /** Zatížení člověka v aktuálním týdnu; null = kapacity se nepodařilo načíst. */
  loads: ReadonlyMap<string, OwnerLoad> | null
  names: ReadonlyMap<string, string>
  /** Jak dlouho už milník čeká (id milníku → dní), z auditu; bez něj se bere updated_at. */
  waitingDays?: ReadonlyMap<number, number>
}

export type RiskState = 'late' | 'blocked' | 'waiting' | 'stale' | 'ok'

export const RISK_STATE_LABEL: Record<RiskState, string> = {
  late: 'Po termínu',
  blocked: 'Blokované',
  waiting: 'Čeká na klienta',
  stale: 'Bez pohybu',
  ok: 'V pořádku',
}

export type RiskReason = { key: 'late' | 'milestone_late' | 'blocked' | 'waiting' | 'stale' | 'no_owner' | 'overloaded'; text: string }

/** Otevřený (nepřijatý, neuzavřený) milník dodávky pro přehledy po milnících. */
export type PortfolioOpenMilestone = {
  id: number
  title: string
  status: string
  statusLabel: string
  dueOn: string | null
  /** Dní do termínu vůči dnešku (záporné = po termínu); null = bez termínu. */
  daysToDue: number | null
  ownerId: string | null
  ownerName: string | null
}

export type PortfolioItem = {
  id: number
  accountId: number
  accountName: string
  /** Navázaný obchod (id); částky k němu vidí jen obchodní role přes obchody. */
  dealId: number | null
  title: string
  kindLabel: string
  phase: string
  phaseLabel: string
  href: string
  milestonesHref: string
  ownerId: string | null
  ownerName: string | null
  deputyId: string | null
  deputyName: string | null
  /** Všichni, kdo se dodávky týkají: vlastník, zástupce, vlastníci a zástupci otevřených milníků. */
  involved: string[]
  promised: { source: 'offer' | 'handoff' | 'none'; text: string | null; caption: string }
  nextMilestone: { title: string; dueOn: string | null; daysToDue: number | null; statusLabel: string } | null
  /** Všechny otevřené milníky, podle termínu (bez termínu na konci); první = nextMilestone. */
  openMilestones: PortfolioOpenMilestone[]
  progress: { total: number; accepted: number; lastAcceptedOn: string | null }
  /** Předání do realizace (0054): hotové, nedokončené, nebo sloupec chybí. */
  handoff: 'done' | 'pending' | 'unknown'
  dueOn: string | null
  waits: { us: number; client: number; approval: number; blockedTasks: number }
  lastMove: { at: string | null; days: number | null }
  capacity: OwnerLoad | null
  impact: { metric: string; unit: string | null; baseline: number; actual: number; change: string } | null
  reference: 'consent' | 'pending' | 'none'
  flags: { late: boolean; blocked: boolean; waitingClient: boolean; stale: boolean }
  state: RiskState
  riskScore: number
  reasons: RiskReason[]
  leadership: string[]
}

export const TEXT_MAX = 180

/** „3. 10." z pražského dne YYYY-MM-DD. */
export function shortDay(day: string): string {
  return `${Number(day.slice(8, 10))}. ${Number(day.slice(5, 7))}.`
}

const clip = (s: string, max = TEXT_MAX): string => {
  const t = s.replace(/\s+/g, ' ').trim()
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t
}

function cz(n: number, one: string, few: string, many: string): string {
  return n === 1 ? one : n >= 2 && n <= 4 ? few : many
}

/** „1 den", „3 dny", „12 dní". */
export function daysText(n: number): string {
  return `${n} ${cz(n, 'den', 'dny', 'dní')}`
}

/** Pražský den z ISO okamžiku; neplatný vstup → null. */
function dayOf(iso: string | null | undefined): string | null {
  if (!iso) return null
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? null : pragueDayOf(d)
}

const OPEN_MILESTONE = (s: string) => s !== 'prijato' && s !== 'uzavreno'
const OUR_MILESTONE = (s: string) => s === 'pripraveno' || s === 'v_praci'

/** Poslední měření, které má výchozí stav i výsledek (nejnovější den, pak id). */
export function latestMeasured(measures: readonly PortfolioMeasure[]): PortfolioMeasure | null {
  const sorted = [...measures].sort((a, b) => b.observed_on.localeCompare(a.observed_on) || b.id - a.id)
  return sorted.find((m) => m.baseline !== null && m.actual !== null) ?? null
}

function promisedOf(e: PortfolioEngagement, offers: PortfolioInput['offers']): PortfolioItem['promised'] {
  const offer = e.deal_id !== null ? offers?.get(e.deal_id) : undefined
  if (offer && offer.scope && offer.scope.trim()) {
    const when = dayOf(offer.decided_at)
    return {
      source: 'offer',
      text: clip(offer.scope),
      caption: `Přijatá nabídka, verze ${offer.version}${when ? `, přijata ${shortDay(when)}` : ''}`,
    }
  }
  const handoff = e.scope?.trim() || e.goal?.trim() || null
  if (handoff) return { source: 'handoff', text: clip(handoff), caption: 'Z předávacího balíčku, přijatá nabídka není spárovaná' }
  return { source: 'none', text: null, caption: 'Zatím nezapsáno' }
}

export function buildPortfolio(input: PortfolioInput): PortfolioItem[] {
  const { today } = input
  const names = input.names
  const name = (id: string | null) => (id ? names.get(id) ?? 'Neznámý člen týmu' : null)
  const items: PortfolioItem[] = []

  for (const e of input.engagements) {
    if (e.phase === 'uzavreno') continue
    const ms = (input.milestones ?? []).filter((m) => m.engagement_id === e.id)
    const tasks = (input.tasks ?? []).filter((t) => t.engagement_id === e.id)
    const accountName = e.account_name ?? '—'
    const dealTitle = e.deal_id !== null ? input.dealTitles.get(e.deal_id) : undefined
    const title = dealTitle ?? engagementKindLabel(e.kind)

    // --- milníky a přijetí ---
    const accepted = ms.filter((m) => m.status === 'prijato' || m.status === 'uzavreno')
    const open = ms.filter((m) => OPEN_MILESTONE(m.status))
    const lastAcceptedOn = accepted.reduce<string | null>((best, m) => {
      const d = dayOf(m.accepted_at)
      return d && (best === null || d > best) ? d : best
    }, null)
    const openMilestones: PortfolioOpenMilestone[] = [...open]
      .sort((a, b) => {
        if (a.due_on && b.due_on) return a.due_on.localeCompare(b.due_on) || a.id - b.id
        if (a.due_on) return -1
        if (b.due_on) return 1
        return a.id - b.id
      })
      .map((m) => ({
        id: m.id,
        title: m.title,
        status: m.status,
        statusLabel: isMilestoneStatus(m.status) ? MILESTONE_STATUS_LABEL[m.status as MilestoneStatus] : m.status,
        dueOn: m.due_on,
        daysToDue: m.due_on ? daysBetweenPragueDays(today, m.due_on) : null,
        ownerId: m.owner_id,
        ownerName: name(m.owner_id),
      }))
    const nextRaw = openMilestones[0]
    const nextMilestone = nextRaw
      ? { title: nextRaw.title, dueOn: nextRaw.dueOn, daysToDue: nextRaw.daysToDue, statusLabel: nextRaw.statusLabel }
      : null

    // --- co čeká ---
    const waitingInput = open.filter((m) => m.status === 'ceka_na_vstup')
    const waitingApproval = open.filter((m) => m.status === 'ceka_na_schvaleni')
    const waitingClient = [...waitingInput, ...waitingApproval]
    const blockedTasks = tasks.filter((t) => t.status === 'blocked').length
    const ourTasks = tasks.filter((t) => t.status === 'todo' || t.status === 'in_progress').length
    const waits = {
      us: open.filter((m) => OUR_MILESTONE(m.status)).length + ourTasks,
      client: waitingInput.length,
      approval: waitingApproval.length,
      blockedTasks,
    }
    const waitDaysOf = (m: PortfolioMilestone): number => {
      const fromAudit = input.waitingDays?.get(m.id)
      if (fromAudit !== undefined) return fromAudit
      const d = dayOf(m.updated_at)
      return d ? Math.max(0, daysBetweenPragueDays(d, today)) : 0
    }
    const longestWait = waitingClient.reduce<{ m: PortfolioMilestone; days: number } | null>((best, m) => {
      const days = waitDaysOf(m)
      return best === null || days > best.days ? { m, days } : best
    }, null)
    const quietWait = longestWait !== null && longestWait.days >= WAITING_QUIET_DAYS ? longestWait : null

    // --- termíny ---
    const engagementLate = !!e.due_on && e.due_on < today
    const engagementDaysLate = engagementLate && e.due_on ? daysBetweenPragueDays(e.due_on, today) : 0
    const lateMilestones = open.filter((m) => !!m.due_on && (m.due_on as string) < today)
    const worstMilestone = lateMilestones.reduce<{ m: PortfolioMilestone; days: number } | null>((best, m) => {
      const days = daysBetweenPragueDays(m.due_on as string, today)
      return best === null || days > best.days ? { m, days } : best
    }, null)
    const late = engagementLate || worstMilestone !== null

    // --- poslední pohyb ---
    const stamps = [e.updated_at, ...ms.map((m) => m.updated_at), ...ms.map((m) => m.accepted_at), ...tasks.map((t) => t.updated_at)]
      .map(dayOf)
      .filter((d): d is string => d !== null)
    const lastDay = stamps.reduce<string | null>((best, d) => (best === null || d > best ? d : best), null)
    const lastDays = lastDay ? Math.max(0, daysBetweenPragueDays(lastDay, today)) : null
    const stale = lastDays !== null && lastDays >= STALE_DAYS

    // --- lidé a kapacita ---
    const involved = [...new Set([e.owner_id, e.deputy_id, ...open.flatMap((m) => [m.owner_id, m.deputy_id])].filter((v): v is string => !!v))]
    const capacity = e.owner_id && input.loads ? input.loads.get(e.owner_id) ?? null : null
    const overloaded = capacity?.overloaded ?? false

    // --- dopad a reference ---
    const measured = latestMeasured((input.measures ?? []).filter((m) => m.engagement_id === e.id))
    const impact = measured && measured.baseline !== null && measured.actual !== null
      ? {
          metric: measured.metric,
          unit: measured.unit,
          baseline: measured.baseline,
          actual: measured.actual,
          change: formatDelta(impactDelta(measured.baseline, measured.actual), measured.unit),
        }
      : null
    const card = (input.cards ?? []).filter((c) => c.engagement_id === e.id)
    const reference: PortfolioItem['reference'] = card.some((c) => c.approved_public && c.consent_ok)
      ? 'consent'
      : e.reference_worthy || card.length > 0
        ? 'pending'
        : 'none'

    // --- důvody a riziko ---
    const reasons: RiskReason[] = []
    let riskScore = 0
    if (engagementLate) {
      reasons.push({ key: 'late', text: `Po termínu o ${daysText(engagementDaysLate)}` })
      riskScore += 1000 + Math.min(engagementDaysLate, 999)
    } else if (worstMilestone) {
      reasons.push({ key: 'milestone_late', text: `Milník po termínu o ${daysText(worstMilestone.days)}` })
      riskScore += 900 + Math.min(worstMilestone.days, 99)
    }
    if (blockedTasks > 0) {
      reasons.push({ key: 'blocked', text: blockedTasks === 1 ? 'Blokovaný úkol' : `${blockedTasks} ${cz(blockedTasks, 'blokovaný úkol', 'blokované úkoly', 'blokovaných úkolů')}` })
      riskScore += 500 + 10 * blockedTasks
    }
    if (waitingClient.length > 0) {
      reasons.push({ key: 'waiting', text: 'Čeká na klienta' })
      riskScore += 100 + (quietWait ? 200 + Math.min(quietWait.days, 99) : 0)
    }
    if (stale && lastDays !== null) {
      reasons.push({ key: 'stale', text: `Bez pohybu ${daysText(lastDays)}` })
      riskScore += 200 + Math.min(lastDays, 99)
    }
    if (!e.owner_id) {
      reasons.push({ key: 'no_owner', text: 'Bez vlastníka' })
      riskScore += 150
    }
    if (overloaded) {
      reasons.push({ key: 'overloaded', text: 'Vlastník je přetížený' })
      riskScore += 120
    }

    const state: RiskState = late ? 'late' : blockedTasks > 0 ? 'blocked' : waitingClient.length > 0 ? 'waiting' : stale ? 'stale' : 'ok'

    // --- co musí udělat vedení (od nejdůležitějšího) ---
    const leadership: string[] = []
    if (!e.owner_id) leadership.push('Určit vlastníka dodávky.')
    if (engagementLate) leadership.push(`Rozhodnout o novém termínu předání (je o ${daysText(engagementDaysLate)} po termínu).`)
    else if (worstMilestone) leadership.push(`Zeptat se, jak je na tom milník „${worstMilestone.m.title}" (o ${daysText(worstMilestone.days)} po termínu).`)
    if (blockedTasks > 0) leadership.push(`Odblokovat práci: ${blockedTasks} ${cz(blockedTasks, 'blokovaný úkol', 'blokované úkoly', 'blokovaných úkolů')}.`)
    if (quietWait) leadership.push(`Ozvat se klientovi: „${quietWait.m.title}" čeká ${daysText(quietWait.days)}.`)
    if (e.owner_id && !e.deputy_id) leadership.push('Určit zástupce vlastníka.')
    if (overloaded && capacity) leadership.push(`Odlehčit vlastníkovi ${name(e.owner_id)}: tento týden ${capacity.load} h při kapacitě ${capacity.capacity} h.`)
    if (stale && lastDays !== null) leadership.push(`Zjistit stav: ${daysText(lastDays)} se nic nezměnilo.`)
    if (e.handoff_completed_at === null) leadership.push('Dokončit předání do realizace.')
    if (input.milestones !== null && ms.length === 0) leadership.push('Zapsat milníky dodávky.')

    items.push({
      id: e.id,
      accountId: e.account_id,
      accountName,
      dealId: e.deal_id,
      title,
      kindLabel: engagementKindLabel(e.kind),
      phase: e.phase,
      phaseLabel: deliveryPhaseLabel(e.phase),
      href: `/cockpit/clients/${e.account_id}/engagements/${e.id}/edit`,
      milestonesHref: `/cockpit/clients/${e.account_id}/engagements/${e.id}/edit?zalozka=milniky`,
      ownerId: e.owner_id,
      ownerName: name(e.owner_id),
      deputyId: e.deputy_id,
      deputyName: name(e.deputy_id),
      involved,
      promised: promisedOf(e, input.offers),
      nextMilestone,
      openMilestones,
      progress: { total: ms.length, accepted: accepted.length, lastAcceptedOn },
      handoff: e.handoff_completed_at === undefined ? 'unknown' : e.handoff_completed_at === null ? 'pending' : 'done',
      dueOn: e.due_on,
      waits,
      lastMove: { at: lastDay, days: lastDays },
      capacity,
      impact,
      reference,
      flags: { late, blocked: blockedTasks > 0, waitingClient: waitingClient.length > 0, stale },
      state,
      riskScore,
      reasons,
      leadership,
    })
  }

  return items.sort((a, b) => {
    if (b.riskScore !== a.riskScore) return b.riskScore - a.riskScore
    if (a.dueOn && b.dueOn && a.dueOn !== b.dueOn) return a.dueOn.localeCompare(b.dueOn)
    if (a.dueOn && !b.dueOn) return -1
    if (!a.dueOn && b.dueOn) return 1
    return a.accountName.localeCompare(b.accountName, 'cs') || a.id - b.id
  })
}

// ---------------------------------------------------------------------------
// Souhrn a filtry

export type PortfolioSummary = {
  active: number
  late: number
  waitingClient: number
  blocked: number
  stale: number
  /** Dodávky s doloženým dopadem (aspoň jedno měření před i po). */
  withImpact: number
  /** Dodávky s referencí a doloženým souhlasem klienta. */
  withReference: number
  /** Kolik dodávek je v kterém stavu (jeden stav na dodávku, podle důležitosti). */
  byState: Record<RiskState, number>
}

export function summarizePortfolio(items: readonly PortfolioItem[]): PortfolioSummary {
  const byState: Record<RiskState, number> = { late: 0, blocked: 0, waiting: 0, stale: 0, ok: 0 }
  for (const i of items) byState[i.state] += 1
  return {
    active: items.length,
    late: items.filter((i) => i.flags.late).length,
    waitingClient: items.filter((i) => i.flags.waitingClient).length,
    blocked: items.filter((i) => i.flags.blocked).length,
    stale: items.filter((i) => i.flags.stale).length,
    withImpact: items.filter((i) => i.impact !== null).length,
    withReference: items.filter((i) => i.reference === 'consent').length,
    byState,
  }
}

export const PORTFOLIO_SCOPES = ['vse', 'moje'] as const
export type PortfolioScope = (typeof PORTFOLIO_SCOPES)[number]

export const PORTFOLIO_FILTERS = ['po-terminu', 'ceka-na-klienta', 'blokovane', 'bez-pohybu'] as const
export type PortfolioFilter = (typeof PORTFOLIO_FILTERS)[number]

export const PORTFOLIO_FILTER_LABEL: Record<PortfolioFilter, string> = {
  'po-terminu': 'Po termínu',
  'ceka-na-klienta': 'Čeká na klienta',
  blokovane: 'Blokované',
  'bez-pohybu': 'Bez pohybu',
}

export function parsePortfolioScope(v: unknown): PortfolioScope {
  const s = Array.isArray(v) ? v[0] : v
  return s === 'moje' ? 'moje' : 'vse'
}

export function parsePortfolioFilter(v: unknown): PortfolioFilter | null {
  const s = Array.isArray(v) ? v[0] : v
  return (PORTFOLIO_FILTERS as readonly unknown[]).includes(s) ? (s as PortfolioFilter) : null
}

/** Moje = dodávky, kde je člověk vlastník, zástupce nebo vlastník otevřeného milníku. */
export function filterPortfolio(
  items: readonly PortfolioItem[],
  opts: { scope: PortfolioScope; meId: string | null; filter?: PortfolioFilter | null },
): PortfolioItem[] {
  let out = [...items]
  if (opts.scope === 'moje') out = out.filter((i) => !!opts.meId && i.involved.includes(opts.meId))
  switch (opts.filter) {
    case 'po-terminu': out = out.filter((i) => i.flags.late); break
    case 'ceka-na-klienta': out = out.filter((i) => i.flags.waitingClient); break
    case 'blokovane': out = out.filter((i) => i.flags.blocked); break
    case 'bez-pohybu': out = out.filter((i) => i.flags.stale); break
    default: break
  }
  return out
}

// ---------------------------------------------------------------------------
// Tvar pro API a MCP (nástroj get_deliveries): stejná pravidla jako
// /dodavky (souhrn z celého výběru, filtr stavu jen zúží seznam), bez odkazů
// do aplikace, bez kapacit a bez peněz.

export const DELIVERIES_PAGE_DEFAULT = 50
export const DELIVERIES_PAGE_MAX = 200

export type PortfolioApiQuery = {
  /** Jen dodávky, kde je člověk vlastník, zástupce nebo vlastník otevřeného milníku. */
  onlyMine?: boolean
  meId: string | null
  accountId?: number
  filter?: PortfolioFilter | null
  limit?: number
  offset?: number
}

export type PortfolioApiItem = {
  id: number
  account: { id: number; name: string }
  title: string
  kind: string
  deal_id: number | null
  phase: string
  phase_label: string
  owner: string | null
  deputy: string | null
  next_milestone: { title: string; due_on: string | null; days_to_due: number | null; status: string } | null
  due_on: string | null
  state: RiskState
  state_label: string
  flags: { late: boolean; blocked: boolean; waiting_for_client: boolean; stale: boolean }
  reasons: string[]
  milestones: { total: number; accepted: number }
  days_since_last_move: number | null
}

export type PortfolioApi = {
  summary: {
    active: number
    by_phase: { phase: string; label: string; count: number }[]
    late: number
    waiting_for_client: number
    blocked: number
    stale: number
    by_state: Record<RiskState, number>
  }
  items: PortfolioApiItem[]
  total: number
  next_offset: number | null
}

const PHASE_ORDER = DELIVERY_PHASES.map((p) => p.key)

function countByPhase(items: readonly PortfolioItem[]): PortfolioApi['summary']['by_phase'] {
  const counts = new Map<string, number>()
  for (const i of items) counts.set(i.phase, (counts.get(i.phase) ?? 0) + 1)
  const rank = (phase: string) => {
    const idx = PHASE_ORDER.indexOf(phase)
    return idx === -1 ? PHASE_ORDER.length : idx
  }
  return [...counts]
    .sort(([a], [b]) => rank(a) - rank(b) || a.localeCompare(b))
    .map(([phase, count]) => ({ phase, label: deliveryPhaseLabel(phase), count }))
}

function toApiItem(i: PortfolioItem): PortfolioApiItem {
  return {
    id: i.id,
    account: { id: i.accountId, name: i.accountName },
    title: i.title,
    kind: i.kindLabel,
    deal_id: i.dealId,
    phase: i.phase,
    phase_label: i.phaseLabel,
    owner: i.ownerName,
    deputy: i.deputyName,
    next_milestone: i.nextMilestone
      ? { title: i.nextMilestone.title, due_on: i.nextMilestone.dueOn, days_to_due: i.nextMilestone.daysToDue, status: i.nextMilestone.statusLabel }
      : null,
    due_on: i.dueOn,
    state: i.state,
    state_label: RISK_STATE_LABEL[i.state],
    flags: { late: i.flags.late, blocked: i.flags.blocked, waiting_for_client: i.flags.waitingClient, stale: i.flags.stale },
    reasons: i.reasons.map((r) => r.text),
    milestones: { total: i.progress.total, accepted: i.progress.accepted },
    days_since_last_move: i.lastMove.days,
  }
}

/** Souhrn a stránka dodávek pro API. Pořadí zůstává podle rizika (buildPortfolio). */
export function portfolioForApi(items: readonly PortfolioItem[], q: PortfolioApiQuery): PortfolioApi {
  let scoped = filterPortfolio(items, { scope: q.onlyMine ? 'moje' : 'vse', meId: q.meId })
  if (q.accountId !== undefined) scoped = scoped.filter((i) => i.accountId === q.accountId)
  const s = summarizePortfolio(scoped)
  const shown = filterPortfolio(scoped, { scope: 'vse', meId: null, filter: q.filter ?? null })
  const limit = q.limit ?? DELIVERIES_PAGE_DEFAULT
  const offset = q.offset ?? 0
  const next = offset + limit
  return {
    summary: {
      active: s.active,
      by_phase: countByPhase(scoped),
      late: s.late,
      waiting_for_client: s.waitingClient,
      blocked: s.blocked,
      stale: s.stale,
      by_state: s.byState,
    },
    items: shown.slice(offset, next).map(toApiItem),
    total: shown.length,
    next_offset: next < shown.length ? next : null,
  }
}
