// Čtení pro Portfolio dodávek (/dodavky a panel na Dnes). Skládá čisté funkce
// z domain/delivery/portfolio.ts nad skutečnými daty; bez peněz.
//
// Hlavní dotaz (běžící dodávky) je povinný: když selže, stránka to řekne.
// Vedlejší zdroje (milníky, úkoly, kapacity, měření, reference, nabídky)
// jen doplňují; když některý selže nebo čeká na migraci, portfolio se ukáže
// bez něj a stránka poctivě napíše, co chybí (`unavailable`).
//
// Oprávnění: všechno běží pod RLS přihlášeného. Přijatá nabídka (rozsah)
// je v tabulce pod pravidlem „jen obchodní role"; ostatním se vůbec
// nečte a rozsah se bere z předávacího balíčku dodávky.
//
// Výjimka jsou API/MCP a cron (provozní přehled e-mailem,
// domain/crm/queries/opsReport.ts): nemají přihlášeného, takže volající předá
// klienta se service role (`db`) a `asService`. Service role RLS obchází, takže
// za oprávnění ručí volající — přijatou nabídku dál čte jen s `canSeeSales`,
// názvy obchodů se čtou přímo z tabulky deal (jen id, firma, název; rpc
// deal_public (0058) volání bez přihlášeného uživatele odmítne) a částky se
// nečtou vůbec.
import { createClient } from '@/lib/supabase/server'
import { isMissingRelation } from '@/core/loopQueries'
import { listDealPublic } from '@/lib/queries/dealPublic'
import { logError } from '@/lib/log'
import { pragueToday } from '@/lib/pragueDate'
import {
  ALLOCATION_COLUMNS,
  isMissingColumnOrSchema,
  loadTeamCapacity,
} from '@/domain/delivery/queries/capacity'
import { getWaitingItems } from '@/domain/delivery/queries/waiting'
import { memberWeekLoads, weeksFrom, type AllocationLike } from '@/domain/delivery/capacity'
import { referenceConsentOk } from '@/domain/delivery/impact'
import {
  buildPortfolio,
  type OwnerLoad,
  type PortfolioEngagement,
  type PortfolioItem,
  type PortfolioMeasure,
  type PortfolioMilestone,
  type PortfolioOffer,
  type PortfolioReferenceCard,
  type PortfolioTask,
} from '@/domain/delivery/portfolio'

export type PortfolioSource = 'milníky' | 'úkoly' | 'kapacity' | 'měření' | 'reference' | 'nabídky' | 'názvy obchodů'

export type PortfolioResult =
  | { state: 'ok'; items: PortfolioItem[]; unavailable: PortfolioSource[] }
  | { state: 'error'; message: string }

type Row = Record<string, unknown>
type Db = Awaited<ReturnType<typeof createClient>>
const str = (v: unknown): string | null => (typeof v === 'string' ? v : null)

type DealTitles = { ok: true; rows: { id: number; account_id: number; title: string }[] } | { ok: false; error: unknown }

/** Service role: názvy obchodů přímo z tabulky deal (jen tři sloupce, žádné částky). */
async function dealTitlesAsService(s: Db): Promise<DealTitles> {
  const { data, error } = await s.from('deal').select('id, account_id, title')
  if (error) return { ok: false, error }
  return {
    ok: true,
    rows: ((data ?? []) as Row[]).map((r) => ({ id: Number(r.id), account_id: Number(r.account_id), title: String(r.title ?? '') })),
  }
}
const numOrNull = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v))
const one = <T,>(v: T | T[] | null | undefined): T | null => (Array.isArray(v) ? (v[0] ?? null) : (v ?? null))

function toEngagement(r: Row): PortfolioEngagement {
  const account = one(r.account as { name: string | null } | { name: string | null }[] | null)
  return {
    id: Number(r.id),
    account_id: Number(r.account_id),
    account_name: account?.name ?? null,
    deal_id: r.deal_id == null ? null : Number(r.deal_id),
    kind: String(r.kind ?? ''),
    phase: String(r.phase ?? ''),
    started_on: str(r.started_on),
    due_on: str(r.due_on),
    owner_id: str(r.owner_id),
    deputy_id: str(r.deputy_id),
    updated_at: str(r.updated_at),
    reference_worthy: r.reference_worthy === true,
    // Sloupce předávacího balíčku (0054): před migrací v řádku nejsou.
    goal: 'goal' in r ? str(r.goal) : undefined,
    scope: 'scope' in r ? str(r.scope) : undefined,
    handoff_completed_at: 'handoff_completed_at' in r ? str(r.handoff_completed_at) : undefined,
  }
}

/**
 * Běžící dodávky (ne uzavřené) s tím, co k nim patří, seřazené podle rizika.
 * `canSeeSales` rozhoduje jen o tom, zda se čte přijatá nabídka.
 * `db` + `asService`: cron se service role (viz hlavička souboru).
 */
export async function getDeliveryPortfolio(opts: { today?: string; canSeeSales: boolean; db?: Db; asService?: boolean }): Promise<PortfolioResult> {
  const today = opts.today ?? pragueToday()
  const s = opts.db ?? await createClient()

  // select('*'): sloupce z 0054 a 0061 (předání, vlastník) přijdou, až budou v DB.
  const eng = await s.from('engagement')
    .select('*, account(name)')
    .neq('phase', 'uzavreno')
    .order('due_on', { ascending: true, nullsFirst: false })
  if (eng.error) return { state: 'error', message: eng.error.message }
  const engagements = ((eng.data ?? []) as unknown as Row[]).map(toEngagement)
  if (engagements.length === 0) return { state: 'ok', items: [], unavailable: [] }

  const ids = engagements.map((e) => e.id)
  const dealIds = [...new Set(engagements.map((e) => e.deal_id).filter((v): v is number => v !== null))]
  const week = weeksFrom(today, 1)[0]
  const unavailable = new Set<PortfolioSource>()

  const [milestonesQ, tasksQ, allocationsQ, team, deals, offersQ, measuresQ, waiting] = await Promise.all([
    s.from('engagement_milestone')
      .select('id, engagement_id, title, owner_id, deputy_id, status, due_on, accepted_at, updated_at')
      .in('engagement_id', ids),
    s.from('task')
      .select('engagement_id, status, updated_at')
      .in('engagement_id', ids)
      .neq('status', 'done'),
    s.from('allocation')
      .select(ALLOCATION_COLUMNS)
      .or(`ends_on.is.null,ends_on.gte.${week.start}`),
    loadTeamCapacity(s),
    (opts.asService ? dealTitlesAsService(s) : listDealPublic(s, null)) as Promise<DealTitles>,
    opts.canSeeSales && dealIds.length > 0
      ? s.from('deal_scope_version')
          .select('deal_id, version, scope, decided_at')
          .eq('status', 'accepted')
          .in('deal_id', dealIds)
      : Promise.resolve(null),
    s.from('metric_observation')
      .select('id, engagement_id, metric, unit, baseline, actual, observed_on')
      .in('engagement_id', ids),
    getWaitingItems({ today, db: opts.db }).catch((e) => {
      logError('portfolio.waiting', e)
      return null
    }),
  ])

  // --- milníky ---
  let milestones: PortfolioMilestone[] | null = null
  if (milestonesQ.error) {
    unavailable.add('milníky')
    if (!isMissingRelation(milestonesQ.error)) logError('portfolio.milestones', milestonesQ.error)
  } else {
    milestones = ((milestonesQ.data ?? []) as unknown as Row[]).map((r) => ({
      id: Number(r.id),
      engagement_id: Number(r.engagement_id),
      title: String(r.title ?? ''),
      owner_id: str(r.owner_id),
      deputy_id: str(r.deputy_id),
      status: String(r.status ?? ''),
      due_on: str(r.due_on),
      accepted_at: str(r.accepted_at),
      updated_at: str(r.updated_at),
    }))
  }

  // --- úkoly ---
  let tasks: PortfolioTask[] | null = null
  if (tasksQ.error) {
    unavailable.add('úkoly')
    logError('portfolio.tasks', tasksQ.error)
  } else {
    tasks = ((tasksQ.data ?? []) as unknown as Row[]).map((r) => ({
      engagement_id: Number(r.engagement_id),
      status: String(r.status ?? ''),
      updated_at: str(r.updated_at),
    }))
  }

  // --- lidé a kapacita ---
  const names = new Map<string, string>()
  let loads: Map<string, OwnerLoad> | null = null
  if (!team.ok) {
    unavailable.add('kapacity')
    logError('portfolio.team', new Error(team.message))
  } else {
    for (const m of team.members) names.set(m.id, m.full_name)
    if (allocationsQ.error) {
      unavailable.add('kapacity')
      // Před 0062 tabulka allocation chybí: bez kapacit, ale bez hluku v logu.
      if (!isMissingRelation(allocationsQ.error) && !isMissingColumnOrSchema(allocationsQ.error)) logError('portfolio.allocations', allocationsQ.error)
    } else {
      const allocations = ((allocationsQ.data ?? []) as unknown as Row[]).map((r): AllocationLike => ({
        id: Number(r.id),
        member_id: String(r.member_id),
        hours_per_week: Number(r.hours_per_week),
        starts_on: String(r.starts_on),
        ends_on: str(r.ends_on),
        substitute_id: str(r.substitute_id),
      }))
      loads = new Map(team.members.map((m) => {
        const w = memberWeekLoads(m, allocations, [week])[0]
        return [m.id, { load: w.load, capacity: w.capacity, overloaded: w.overloaded }]
      }))
    }
  }

  // --- názvy obchodů (jen obchod téže firmy jako dodávka) ---
  const dealTitles = new Map<number, string>()
  if (!deals.ok) {
    unavailable.add('názvy obchodů')
    logError('portfolio.dealPublic', deals.error)
  } else {
    const byId = new Map(deals.rows.map((d) => [d.id, d]))
    for (const e of engagements) {
      const d = e.deal_id !== null ? byId.get(e.deal_id) : undefined
      if (d && d.account_id === e.account_id) dealTitles.set(d.id, d.title)
    }
  }

  // --- přijatá nabídka (jen obchodní role) ---
  let offers: Map<number, PortfolioOffer> | null = null
  if (opts.canSeeSales) {
    if (offersQ === null) {
      offers = new Map()
    } else if (offersQ.error) {
      unavailable.add('nabídky')
      if (!isMissingRelation(offersQ.error)) logError('portfolio.offers', offersQ.error)
    } else {
      offers = new Map(((offersQ.data ?? []) as unknown as Row[]).map((r) => [
        Number(r.deal_id),
        { version: Number(r.version), scope: str(r.scope), decided_at: str(r.decided_at) },
      ]))
    }
  }

  // --- měření dopadu ---
  let measures: (PortfolioMeasure & { engagement_id: number })[] | null = null
  if (measuresQ.error) {
    unavailable.add('měření')
    if (!isMissingRelation(measuresQ.error)) logError('portfolio.measures', measuresQ.error)
  } else {
    measures = ((measuresQ.data ?? []) as unknown as Row[]).map((r) => ({
      id: Number(r.id),
      engagement_id: Number(r.engagement_id),
      metric: String(r.metric ?? ''),
      unit: str(r.unit),
      baseline: numOrNull(r.baseline),
      actual: numOrNull(r.actual),
      observed_on: String(r.observed_on ?? ''),
    }))
  }

  // --- reference (souhlas doložený až od 0061) ---
  let cards: PortfolioReferenceCard[] | null = null
  const cardsFull = await s.from('reference_card')
    .select('engagement_id, approved_public, consent_evidence_id, consent_at')
    .in('engagement_id', ids)
  if (!cardsFull.error) {
    cards = ((cardsFull.data ?? []) as unknown as Row[]).map((r) => ({
      engagement_id: Number(r.engagement_id),
      approved_public: r.approved_public === true,
      consent_ok: referenceConsentOk({
        approved_public: r.approved_public === true,
        consent_evidence_id: numOrNull(r.consent_evidence_id),
        consent_at: str(r.consent_at),
      }),
    }))
  } else if (isMissingColumnOrSchema(cardsFull.error)) {
    const plain = await s.from('reference_card').select('engagement_id, approved_public').in('engagement_id', ids)
    if (!plain.error) {
      // Bez sloupců souhlasu se souhlas nedá doložit, proto ho nepočítáme.
      cards = ((plain.data ?? []) as unknown as Row[]).map((r) => ({
        engagement_id: Number(r.engagement_id),
        approved_public: r.approved_public === true,
        consent_ok: false,
      }))
    } else {
      unavailable.add('reference')
      logError('portfolio.cards', plain.error)
    }
  } else {
    unavailable.add('reference')
    if (!isMissingRelation(cardsFull.error)) logError('portfolio.cards', cardsFull.error)
  }

  // --- jak dlouho už se čeká na klienta (z auditu) ---
  const waitingDays = new Map<number, number>()
  if (waiting && waiting.state === 'ok') {
    for (const w of waiting.items) waitingDays.set(w.milestoneId, w.daysWaiting)
  }

  const items = buildPortfolio({
    today, engagements, milestones, tasks, offers, dealTitles, measures, cards, loads, names, waitingDays,
  })
  return { state: 'ok', items, unavailable: [...unavailable] }
}
