// Čtení pro provozní přehled (domain/crm/opsReport.ts). Jen volá EXISTUJÍCÍ
// dotazy — „Co se změnilo", portfolio dodávek, čekání na klienta, kapacity,
// Ke schválení, návrhy případů, zápisy schůzek a (jen obchodní role) faktury
// po splatnosti z Financí — a výsledek skládá čistou buildOpsReport. Vlastní
// dotaz na tabulky tu není.
//
// KLIENT: stránka Týden čte pod session přihlášeného (RLS). Cron (e-mail
// v pondělí a v pátek, domain/crm/digestDelivery.ts) session nemá — RLS by
// vrátilo prázdná data a přehled by tvrdil „nic nečeká" — proto předá klienta
// se service role (`db`, `asService`). Obě cesty skládají tentýž přehled.
//
// ODOLNOST: každý zdroj se načítá zvlášť. Chyba se zaloguje a přehled ji
// v dané sekci přizná (`unavailable`); ostatní sekce se ukážou dál.
import { createClient } from '@/lib/supabase/server'
import { countPendingProposals, getDecisionInbox, isMissingColumn, isMissingRelation, type InboxResult } from '@/core/loopQueries'
import { logError } from '@/lib/log'
import { pragueDayOf } from '@/lib/pragueDate'
import { weekWindow, type ChangeKind, type WeekChoice } from '@/domain/crm/changes'
import { buildOpsReport, type OpsFinanceDiff, type OpsReport, type OpsReportInput } from '@/domain/crm/opsReport'
import { loadChanges, type ChangesResult } from '@/domain/crm/queries/changes'
import { getMeetingIntakeStats } from '@/domain/crm/queries/meetingIntake'
import { weeksFrom } from '@/domain/delivery/capacity'
import { getCapacityOverview } from '@/domain/delivery/queries/capacity'
import { getDeliveryPortfolio, type PortfolioResult } from '@/domain/delivery/queries/portfolio'
import { getWaitingItems } from '@/domain/delivery/queries/waiting'
import { listOverdueInvoices } from '@/domain/finance/queries/overdue'
import { idokladSyncEnabledFromEnv } from '@/connectors/idoklad'
import { COMPANY } from '@/config'
import { isModuleOn } from '@/core/modules'
import { loadAgentOpsSummary } from '@/domain/crm/agentKpiQueries'
import { addDaysToPragueDay } from '@/lib/pragueDate'

type Db = Awaited<ReturnType<typeof createClient>>

/** Druhy změn, ze kterých přehled čerpá: obchody, poptávky z e-mailu, milníky, nové dodávky. */
export const OPS_CHANGE_KINDS: readonly ChangeKind[] = ['stage', 'intake', 'milestone', 'delivery']

export type OpsReportContext = {
  now: Date
  /** Pražský dnešek (YYYY-MM-DD); výchozí z `now`. */
  today?: string
  week: WeekChoice
  canSeeSales: boolean
  /** Týdenní přehled (Stav zdrojů, follow-upy, firmy k oslovení, blokované obchody); null = nenačteno. */
  digest: OpsReportInput['digest']
  /** Změny za týden, když je volající už má (stránka Týden); jinak se načtou jen potřebné druhy. */
  changes?: ChangesResult | null
  /** Klient databáze; výchozí session přihlášeného. */
  db?: Db
  /** Service role (cron): názvy obchodů u dodávek přímo z tabulky (viz queries/portfolio.ts). */
  asService?: boolean
}

const UNAVAILABLE = 'nedostupné'

async function settle<T>(scope: string, work: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await work()
  } catch (e) {
    logError(`opsReport.${scope}`, e)
    return fallback
  }
}

export async function loadOpsReport(ctx: OpsReportContext): Promise<OpsReport> {
  const today = ctx.today ?? pragueDayOf(ctx.now)
  const window = weekWindow(today, ctx.week)
  const s = ctx.db ?? await createClient()
  // Alokace platné od pondělí tohoto týdne (přetížení se hlídá tento a příští týden).
  const from = weeksFrom(today, 1)[0].start

  // Rozdíly z iDokladu jen se zapnutým čtením a jen obchodním rolím (tabulka je sales_only).
  const financeOn = ctx.canSeeSales && idokladSyncEnabledFromEnv(process.env)

  // Agent na poptávky (P5): jen se zapnutým modulem a jen obchodní role (tabulky jsou can_see_sales).
  const agentOn = ctx.canSeeSales && isModuleOn(COMPANY.modules, 'agent')
  const weekStart = pragueDayOf(window.since)
  const weekEnd = addDaysToPragueDay(pragueDayOf(window.until), -1)

  const [changes, portfolio, waiting, capacity, inbox, pendingProposals, unmatchedNotes, overdueInvoices, financeDiffs, agent] = await Promise.all([
    ctx.changes !== undefined
      ? Promise.resolve(ctx.changes)
      : settle<ChangesResult | null>('changes', () => loadChanges({
          window, meId: null, canSeeSales: ctx.canSeeSales, members: [], perSection: 100, kinds: OPS_CHANGE_KINDS, db: s,
        }), null),
    // Rozsah přijaté nabídky přehled nepotřebuje (a do e-mailu nepatří): portfolio
    // ho čte jen s canSeeSales, proto tu vždy false — nečte se vůbec.
    settle<PortfolioResult>('portfolio', () => getDeliveryPortfolio({ today, canSeeSales: false, db: s, asService: ctx.asService }),
      { state: 'error', message: UNAVAILABLE }),
    settle<OpsReportInput['waiting']>('waiting', () => getWaitingItems({ today, db: s }), { state: 'error', message: UNAVAILABLE }),
    settle<OpsReportInput['capacity']>('capacity', () => getCapacityOverview({ from, today, db: s }), { state: 'error', message: UNAVAILABLE }),
    settle<InboxResult>('inbox', () => getDecisionInbox(ctx.now, s), { state: 'error', message: UNAVAILABLE }),
    settle<number | null>('proposals', () => countPendingProposals(s), null),
    // Zápisy schůzek čte RLS jen obchodním rolím (0078); bez oprávnění se nedotazují.
    ctx.canSeeSales
      ? settle<number | null>('meetingNotes', async () => (await getMeetingIntakeStats(s, ctx.now))?.unmatched ?? null, null)
      : Promise.resolve(null),
    // Faktury po splatnosti (0090) čte RLS jen obchodním rolím; bez oprávnění se nedotazují.
    // Před migrací 0090 nebo při chybě: null = přehled přizná, že to neví.
    ctx.canSeeSales
      ? settle<OpsReportInput['overdueInvoices']>('overdueInvoices', async () => {
          const r = await listOverdueInvoices({ today, db: s })
          if (r.state !== 'ok') return null
          return r.rows.map((x) => ({
            id: x.id, accountId: x.account_id, accountName: x.account_name, externalRef: x.external_ref,
            dueOn: x.due_on ?? '', daysLate: x.daysLate,
          }))
        }, null)
      : Promise.resolve(undefined),
    financeOn
      ? settle<OpsReportInput['financeDiffs']>('financeDiffs', () => loadFinanceDiffs(s), { state: 'error' })
      : Promise.resolve(undefined),
    agentOn
      ? settle<OpsReportInput['agent']>('agent', async () => (await loadAgentOpsSummary({ db: s, from: weekStart, to: weekEnd })) ?? { state: 'off' }, null)
      : Promise.resolve(undefined),
  ])

  return buildOpsReport({
    today,
    generatedAt: ctx.now,
    window,
    week: ctx.week,
    canSeeSales: ctx.canSeeSales,
    changes,
    portfolio,
    waiting,
    capacity,
    inbox,
    pendingProposals,
    unmatchedNotes,
    overdueInvoices,
    financeDiffs,
    agent,
    digest: ctx.digest,
  })
}

/** Otevřené rozdíly z iDokladu (jen id, druh, číslo dokladu, firma a čas — bez částek). Bez migrace 0092 prázdný seznam. */
async function loadFinanceDiffs(s: Db): Promise<OpsReportInput['financeDiffs']> {
  const { data, error, count } = await s
    .from('idoklad_discrepancy')
    .select('id, kind, document_number, first_seen_at, account:account_id(name)', { count: 'exact' })
    .eq('status', 'open')
    .order('first_seen_at', { ascending: true })
    .limit(50)
  if (error) {
    if (isMissingRelation(error) || isMissingColumn(error)) return { state: 'ok', items: [], total: 0 }
    throw new Error(error.message)
  }
  type Row = { id: number; kind: OpsFinanceDiff['kind']; document_number: string | null; first_seen_at: string; account: { name: string } | { name: string }[] | null }
  const items = ((data ?? []) as unknown as Row[]).map((r) => ({
    id: r.id, kind: r.kind, document_number: r.document_number, first_seen_at: r.first_seen_at,
    account_name: (Array.isArray(r.account) ? r.account[0] : r.account)?.name ?? null,
  }))
  return { state: 'ok', items, total: count ?? items.length }
}
