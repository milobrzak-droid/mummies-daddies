// Týdenní přehled pro vedení (PDF a Excel): pipeline podle fáze, nové
// leady, nabídky, vyhrané a prohrané obchody s důvody. Čistá funkce nad
// obchody a verzemi nabídek, které vrátí RLS přihlášenému uživateli; data
// načte domain/crm/queries/exports.ts. Plánované odesílání e-mailem řeší
// jiný balík — tady se jen sestaví dokument.
import { dealStageLabel, pillarLabel } from '@/lib/domain'
import { pragueDayOf } from '@/lib/pragueDate'
import { formatCzkText, formatDayText, toExportTable, type ExportColumn, type ExportDocument, type ExportTable } from '@/lib/export/table'
import { OPEN_DEAL_STAGES, weightedValue, type SalesDealLike } from '@/domain/crm/sales'
import { SCOPE_VERSION_STATUS_LABEL } from '@/domain/crm/scopeVersion'
import { dealSourceLabel, exportDocument, lostReasonText, type OfferExportRow } from '@/domain/crm/exports'
import { isoWeek } from '@/domain/crm/today'

export type WeekRange = {
  /** Začátek týdne (včetně), okamžik. */
  since: Date
  /** Konec týdne (bez), okamžik. */
  until: Date
  /** Popis do hlavičky („za týden 45: po 3. 11. až ne 9. 11."). */
  label: string
}

export type WeeklyLeadershipReport = {
  range: WeekRange
  generatedAt: Date
  summary: { label: string; value: string }[]
  byStage: { stage: string; label: string; count: number; amount: number; weighted: number }[]
  newLeads: SalesDealLike[]
  offers: OfferExportRow[]
  won: SalesDealLike[]
  lost: SalesDealLike[]
}

const amount = (d: Pick<SalesDealLike, 'amount_one_time'>) => Number(d.amount_one_time ?? 0) || 0
const sum = (deals: readonly SalesDealLike[]) => deals.reduce((s, d) => s + amount(d), 0)

/** Okamžik (ISO) v týdnu? */
function inRange(ts: string | null | undefined, r: WeekRange): boolean {
  if (!ts) return false
  const t = new Date(ts).getTime()
  return Number.isFinite(t) && t >= r.since.getTime() && t < r.until.getTime()
}

/** Kalendářní den (YYYY-MM-DD) v týdnu (pražské dny). */
function dayInRange(day: string | null | undefined, r: WeekRange): boolean {
  if (!day) return false
  const d = day.slice(0, 10)
  return d >= pragueDayOf(r.since) && d < pragueDayOf(r.until)
}

/** Den uzavření obchodu: won_at u výhry, jinak closed_at. */
function closedDay(d: SalesDealLike): string | null {
  return (d.stage === 'vyhráno' ? d.won_at ?? d.closed_at : d.closed_at) ?? null
}

export function buildWeeklyLeadershipReport(input: {
  deals: readonly SalesDealLike[]
  offers: readonly OfferExportRow[]
  range: WeekRange
  generatedAt: Date
}): WeeklyLeadershipReport {
  const { deals, offers, range } = input
  const open = deals.filter((d) => OPEN_DEAL_STAGES.includes(d.stage))
  const byStage = OPEN_DEAL_STAGES.map((stage) => {
    const inStage = open.filter((d) => d.stage === stage)
    return {
      stage,
      label: dealStageLabel(stage),
      count: inStage.length,
      amount: sum(inStage),
      weighted: inStage.reduce((s, d) => s + weightedValue(d), 0),
    }
  })
  const byDate = <T,>(key: (x: T) => string | null | undefined) => (a: T, b: T) => (key(a) ?? '').localeCompare(key(b) ?? '')
  const newLeads = deals.filter((d) => inRange(d.created_at, range)).sort(byDate((d) => d.created_at))
  const weekOffers = offers.filter((o) => inRange(o.sent_at, range) || (!o.sent_at && inRange(o.created_at, range)))
    .sort(byDate((o) => o.sent_at ?? o.created_at))
  const won = deals.filter((d) => d.stage === 'vyhráno' && dayInRange(closedDay(d), range)).sort(byDate(closedDay))
  const lost = deals.filter((d) => d.stage === 'prohráno' && dayInRange(closedDay(d), range)).sort(byDate(closedDay))

  const sentOffers = weekOffers.filter((o) => o.sent_at)
  const offerSum = sentOffers.reduce((s, o) => s + (o.currency === 'CZK' ? Number(o.amount_one_time) || 0 : 0), 0)
  const decided = won.length + lost.length
  const summary = [
    { label: 'Otevřená pipeline', value: `${open.length} obchodů · ${formatCzkText(sum(open))} (vážená ${formatCzkText(byStage.reduce((s, r) => s + r.weighted, 0))})` },
    { label: 'Nové leady', value: `${newLeads.length} · ${formatCzkText(sum(newLeads))}` },
    { label: 'Odeslané nabídky', value: `${sentOffers.length} · ${formatCzkText(offerSum)}` },
    { label: 'Vyhráno', value: `${won.length} · ${formatCzkText(sum(won))}` },
    { label: 'Prohráno', value: `${lost.length} · ${formatCzkText(sum(lost))}` },
    { label: 'Úspěšnost uzavřených', value: decided === 0 ? '— (nic se neuzavřelo)' : `${Math.round((won.length / decided) * 100)} %` },
  ]
  return { range, generatedAt: input.generatedAt, summary, byStage, newLeads, offers: weekOffers, won, lost }
}

// --- Dokument pro export ---------------------------------------------------------

const LEAD_COLUMNS: ExportColumn<SalesDealLike>[] = [
  { header: 'Založeno', type: 'date', value: (d) => d.created_at },
  { header: 'Klient', value: (d) => d.account?.name ?? '' },
  { header: 'Obchod', value: (d) => d.title },
  { header: 'Segment', value: (d) => (d.pillar ? pillarLabel(d.pillar) : '') },
  { header: 'Fáze', value: (d) => dealStageLabel(d.stage) },
  { header: 'Hodnota', type: 'czk', total: true, value: (d) => d.amount_one_time },
  { header: 'Vlastník', value: (d) => d.owner?.full_name ?? '' },
  { header: 'Zdroj', value: (d) => dealSourceLabel(d) },
]

const OFFER_WEEK_COLUMNS: ExportColumn<OfferExportRow>[] = [
  { header: 'Odesláno', type: 'date', value: (o) => o.sent_at ?? '' },
  { header: 'Klient', value: (o) => o.deal?.account?.name ?? '' },
  { header: 'Obchod', value: (o) => o.deal?.title ?? '' },
  { header: 'Verze', type: 'number', value: (o) => o.version },
  { header: 'Stav', value: (o) => SCOPE_VERSION_STATUS_LABEL[o.status] ?? o.status },
  // Bez součtu: verze téhož obchodu by se sečetly dvakrát.
  { header: 'Částka (Kč)', type: 'czk', value: (o) => (o.currency === 'CZK' ? o.amount_one_time : null) },
]

const closedColumns = (reasonHeader: string): ExportColumn<SalesDealLike>[] => [
  { header: 'Uzavřeno', type: 'date', value: (d) => closedDay(d) },
  { header: 'Klient', value: (d) => d.account?.name ?? '' },
  { header: 'Obchod', value: (d) => d.title },
  { header: 'Hodnota', type: 'czk', total: true, value: (d) => d.amount_one_time },
  { header: 'Vlastník', value: (d) => d.owner?.full_name ?? '' },
  { header: reasonHeader, value: (d) => lostReasonText(d.lost_reason) },
]

type StageRow = WeeklyLeadershipReport['byStage'][number]
const STAGE_COLUMNS: ExportColumn<StageRow>[] = [
  { header: 'Fáze', value: (r) => r.label },
  { header: 'Počet obchodů', type: 'number', total: true, value: (r) => r.count },
  { header: 'Hodnota', type: 'czk', total: true, value: (r) => r.amount },
  { header: 'Vážená hodnota', type: 'czk', total: true, value: (r) => r.weighted },
]

const SUMMARY_COLUMNS: ExportColumn<{ label: string; value: string }>[] = [
  { header: 'Ukazatel', value: (r) => r.label },
  { header: 'Hodnota', value: (r) => r.value },
]

const capitalize = (t: string) => t.charAt(0).toUpperCase() + t.slice(1)

/** „45: po 2. 11. až ne 8. 11." z popisu okna („za týden 45: …"). */
export function weekText(range: Pick<WeekRange, 'label'>): string {
  return range.label.replace(/^za týden /, '')
}

export function weeklyLeadershipTables(report: WeeklyLeadershipReport): ExportTable[] {
  const asOf = formatDayText(pragueDayOf(report.generatedAt))
  return [
    toExportTable('Souhrn', SUMMARY_COLUMNS, report.summary, { note: capitalize(report.range.label) }),
    toExportTable('Pipeline podle fáze', STAGE_COLUMNS, report.byStage, { note: `Otevřené obchody ke dni ${asOf}` }),
    toExportTable('Nové leady', LEAD_COLUMNS, report.newLeads, { note: 'Obchody založené v týdnu', emptyText: 'V týdnu nepřibyl žádný lead.' }),
    toExportTable('Nabídky', OFFER_WEEK_COLUMNS, report.offers, { note: 'Verze nabídek odeslané (nebo založené) v týdnu', emptyText: 'V týdnu neodešla žádná nabídka.' }),
    toExportTable('Vyhrané', closedColumns('Poznámka / důvod'), report.won, { note: 'Obchody vyhrané v týdnu', emptyText: 'V týdnu se nic nevyhrálo.' }),
    toExportTable('Prohrané', closedColumns('Důvod prohry'), report.lost, { note: 'Obchody prohrané v týdnu a proč', emptyText: 'V týdnu se nic neprohrálo.' }),
  ]
}

export function weeklyLeadershipDocument(report: WeeklyLeadershipReport, generatedBy?: string | null): ExportDocument {
  return exportDocument('tydenni-prehled', weeklyLeadershipTables(report), [{ label: 'Týden', value: weekText(report.range) }], {
    generatedAt: report.generatedAt,
    generatedBy,
    fileBase: `tydenni-prehled-tyden-${isoWeek(pragueDayOf(report.range.since))}`,
  })
}
