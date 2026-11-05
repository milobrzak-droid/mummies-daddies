// KPI agenta na poptávky (P5) — čistá logika bez databáze. Z řádků
// inquiry_agent_run (e-mail, P2), web_inquiry (web, 0102), agent_outbox (P3),
// deal a mail_event spočítá, co CSO a CEO vidí na stránce /cockpit/agent:
// rozhodnutí agenta, eskalace podle důvodů, odeslané a zablokované zprávy,
// rychlost první reakce a nabídky, podíl automaticky vyřízených, trychtýř
// podle deal.phase a rozpad důvodů prohry.
//
// Do výsledku nejde žádný text e-mailu ani kontaktní údaj — jen id, stavy,
// kódy, data a počty (tabulka ukazuje klienta jménem firmy z CRM).
//
// Dny jsou pražské (období „posledních N dní včetně dneška").
import { COMPANY } from '@/config'
import { addDaysToPragueDay, pragueDayOf } from '@/lib/pragueDate'
import { LOST_REASONS, parseLostReason, type LostReasonOption } from '@/domain/crm/lostReason'
import { OUTBOX_REASON_LABELS } from '@/core/agents/outboxPolicy'

// --- Vstupní řádky (sloupce, které čte agentKpiQueries) ---------------------

export type AgentInquirySource = 'email' | 'web'

export type AgentInquiryRow = {
  source: AgentInquirySource
  id: number
  received_at: string
  status: string
  decision_kind: string | null
  reason_codes: readonly string[] | null
  segment: string | null
  deal_id: number | null
  account_id: number | null
  quote_total: number | string | null
  decided_at: string | null
}

export type AgentOutboxRow = {
  id: number
  kind: string
  source_ref: string
  deal_id: number | null
  status: string
  stop_reason: string | null
  sent_at: string | null
  prague_day: string | null
}

export type AgentDealRow = {
  id: number
  account_id: number | null
  pillar: string | null
  phase: string | null
  stage: string
  created_at: string
  closed_at?: string | null
  won_at?: string | null
  lost_reason: string | null
}

export type AgentMailEventRow = {
  account_id: number | null
  direction: string
  occurred_at: string
}

// --- Popisky ----------------------------------------------------------------

export const DECISION_KINDS = ['send_offer', 'ask_info', 'escalate', 'not_inquiry'] as const
export type DecisionKind = (typeof DECISION_KINDS)[number]

export const DECISION_LABELS: Readonly<Record<string, string>> = {
  send_offer: 'Nabídka',
  ask_info: 'Doptání',
  escalate: 'Eskalace',
  not_inquiry: 'Není poptávka',
  pending: 'Čeká na rozhodnutí',
}

export function decisionLabel(kind: string | null | undefined): string {
  return DECISION_LABELS[kind ?? 'pending'] ?? kind ?? DECISION_LABELS.pending
}

/** Důvody eskalace (kódy z core/standardOffer.ts a P2). Neznámý kód se ukáže tak, jak je. */
export const REASON_LABELS: Readonly<Record<string, string>> = {
  map_expired: 'Prošlá cenová mapa',
  unknown_segment: 'Nejasný segment',
  unknown_event_type: 'Nestandardní typ akce',
  non_standard_package: 'Balíček mimo mapu',
  guests_out_of_range: 'Počet hostů mimo rozsah',
  date_in_past: 'Termín v minulosti',
  date_too_soon: 'Termín příliš brzy',
  date_too_far: 'Termín příliš daleko',
  distance_over_limit: 'Místo příliš daleko',
  unknown_extra: 'Doplněk mimo mapu',
  unsupported_diet: 'Dieta mimo mapu',
  dietary_exceeds_guests: 'Víc diet než hostů',
  special_request: 'Zvláštní přání',
  vip_contact: 'VIP kontakt',
  over_auto_send_limit: 'Nad limitem pro odeslání',
  extraction_failed: 'Nepodařilo se přečíst',
}

export function reasonLabel(code: string): string {
  return REASON_LABELS[code] ?? code
}

export const OUTBOX_STATUS_LABELS: Readonly<Record<string, string>> = {
  queued: 'Ve frontě',
  claimed: 'Odesílá se',
  sent: 'Odesláno',
  failed: 'Selhalo',
  needs_attention: 'Potřebuje pozornost',
  blocked: 'Zablokováno',
}

export function outboxStatusLabel(status: string | null | undefined): string {
  if (!status) return 'Neodesláno'
  return OUTBOX_STATUS_LABELS[status] ?? status
}

export const OUTBOX_KIND_LABELS: Readonly<Record<string, string>> = {
  offer: 'Nabídka',
  info_request: 'Doptání',
  follow_up: 'Připomínka',
  outreach: 'Oslovení',
}

export function outboxKindLabel(kind: string): string {
  return OUTBOX_KIND_LABELS[kind] ?? kind
}

/** Stavy fronty, které chtějí člověka — patří nahoru na stránku. */
export const ATTENTION_STATUSES = ['needs_attention', 'blocked'] as const

// --- Období -----------------------------------------------------------------

export const PERIOD_DAYS = [7, 30, 90] as const
export type PeriodDays = (typeof PERIOD_DAYS)[number]
export const DEFAULT_PERIOD: PeriodDays = 30

export type AgentPeriod = { days: PeriodDays; from: string; to: string }

/** Období z parametru URL („?obdobi=7"); neznámá hodnota = výchozích 30 dní. */
export function parsePeriod(value: string | string[] | null | undefined): PeriodDays {
  const n = Number(Array.isArray(value) ? value[0] : value)
  return (PERIOD_DAYS as readonly number[]).includes(n) ? (n as PeriodDays) : DEFAULT_PERIOD
}

/** Posledních `days` pražských dní včetně dneška. */
export function periodFor(today: string, days: PeriodDays = DEFAULT_PERIOD): AgentPeriod {
  return { days, from: addDaysToPragueDay(today, -(days - 1)), to: today }
}

const inPeriod = (day: string | null | undefined, p: Pick<AgentPeriod, 'from' | 'to'>) =>
  !!day && day >= p.from && day <= p.to

// --- Statistika -------------------------------------------------------------

/** Percentil s lineární interpolací (p 0–100); prázdné pole = null. */
export function percentile(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const rank = (Math.min(100, Math.max(0, p)) / 100) * (sorted.length - 1)
  const lo = Math.floor(rank)
  const hi = Math.ceil(rank)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo)
}

export type DurationStat = {
  /** Kolik poptávek už reakci má (z nich je medián a p90). */
  measured: number
  /** Kolik poptávek reakci zatím nemá. */
  waiting: number
  medianMinutes: number | null
  p90Minutes: number | null
}

function durationStat(minutes: readonly number[], waiting: number): DurationStat {
  return {
    measured: minutes.length,
    waiting,
    medianMinutes: percentile(minutes, 50),
    p90Minutes: percentile(minutes, 90),
  }
}

/** „45 min", „3,5 h", „2 dny" — doba do reakce pro dlaždici. */
export function formatDuration(minutes: number | null): string {
  if (minutes == null || !Number.isFinite(minutes)) return '—'
  if (minutes < 60) return `${Math.max(0, Math.round(minutes))} min`
  const hours = minutes / 60
  if (hours < 48) {
    const h = Math.round(hours * 10) / 10
    return `${h.toLocaleString('cs-CZ')} h`
  }
  const d = Math.round(hours / 24)
  return `${d} ${d >= 2 && d <= 4 ? 'dny' : 'dní'}`
}

// --- Vazba poptávka ↔ odchozí fronta ----------------------------------------

/** Klíč idempotence fronty pro poptávku (kontrakt P3: inquiry:<run.id>, web:<id>). */
export function inquirySourceRef(row: Pick<AgentInquiryRow, 'source' | 'id'>): string {
  return `${row.source === 'web' ? 'web' : 'inquiry'}:${row.id}`
}

/** Patří zpráva ve frontě k poptávce? (přesná shoda nebo s pořadím „inquiry:5:2"). */
export function outboxBelongsTo(outbox: Pick<AgentOutboxRow, 'source_ref'>, ref: string): boolean {
  return outbox.source_ref === ref || outbox.source_ref.startsWith(`${ref}:`)
}

function outboxByRef(outbox: readonly AgentOutboxRow[]): Map<string, AgentOutboxRow[]> {
  const map = new Map<string, AgentOutboxRow[]>()
  for (const o of outbox) {
    const m = /^(inquiry|web):(\d+)/.exec(o.source_ref)
    if (!m) continue
    const key = `${m[1]}:${m[2]}`
    map.set(key, [...(map.get(key) ?? []), o])
  }
  return map
}

const ms = (ts: string | null | undefined) => (ts ? Date.parse(ts) : NaN)
const minutesBetween = (from: string, to: number) => (to - ms(from)) / 60000

/** Je poptávka skutečná poptávka (ne spam, ne „není poptávka", ne přeskočená)? */
export function isRealInquiry(row: Pick<AgentInquiryRow, 'status' | 'decision_kind'>): boolean {
  return row.decision_kind !== 'not_inquiry' && row.status !== 'spam' && row.status !== 'skipped'
}

// --- Výsledek ---------------------------------------------------------------

export type CountRow = { key: string; label: string; count: number }

export type FunnelStep = {
  key: string
  label: string
  /** Obchody, které fázi dosáhly (nebo jsou dál). */
  count: number
  /** Podíl z první fáze (0–100), první fáze 100; bez obchodů null. */
  pctOfFirst: number | null
  /** Konverze z předchozí fáze (0–100); u první fáze null. */
  pctOfPrevious: number | null
}

export type AgentKpi = {
  period: AgentPeriod
  inquiries: {
    /** Všechny přijaté řádky v období (e-mail i web). */
    received: number
    /** Z nich skutečné poptávky (bez spamu a „není poptávka"). */
    real: number
    email: number
    web: number
    byDecision: CountRow[]
  }
  escalations: { total: number; byReason: CountRow[] }
  outbox: { sent: number; queued: number; failed: number; needsAttention: number; blocked: number }
  firstResponse: DurationStat
  offerSpeed: DurationStat
  autoShare: { auto: number; total: number; pct: number | null }
  funnel: FunnelStep[]
  outcome: { won: number; lost: number; open: number; winRatePct: number | null }
  lostReasons: CountRow[]
}

export type AgentKpiInput = {
  period: AgentPeriod
  inquiries: readonly AgentInquiryRow[]
  outbox: readonly AgentOutboxRow[]
  deals: readonly AgentDealRow[]
  mailEvents: readonly AgentMailEventRow[]
  /** Výchozí z COMPANY (fáze prvního pilíře, vyhrané fáze všech pilířů). */
  phases?: readonly { key: string; label: string }[]
  wonPhases?: readonly string[]
  lostReasons?: readonly LostReasonOption[]
}

/** Prodejní fáze pro trychtýř: fáze prvního pilíře firmy (u cateringu stejné pro všechny). */
export function defaultFunnelPhases(): readonly { key: string; label: string }[] {
  const first = COMPANY.pillars[0]?.key
  return first ? COMPANY.phases[first] ?? [] : []
}

export function defaultWonPhases(): readonly string[] {
  return [...new Set(Object.values(COMPANY.wonPhases).flat())]
}

const pct = (a: number, b: number) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null)

export const LEGACY_LOST_KEY = '_volny_text'
export const LEGACY_LOST_LABEL = 'Volný text bez kódu'

export function computeAgentKpi(input: AgentKpiInput): AgentKpi {
  const { period } = input
  const phases = input.phases ?? defaultFunnelPhases()
  const won = new Set(input.wonPhases ?? defaultWonPhases())
  const lostReasons = input.lostReasons ?? LOST_REASONS

  const inquiries = input.inquiries.filter((r) => inPeriod(pragueDayOf(r.received_at), period))
  const real = inquiries.filter(isRealInquiry)
  const refs = outboxByRef(input.outbox)

  // Rozhodnutí agenta (nerozhodnuté = „čeká").
  const decisionCounts = new Map<string, number>()
  for (const r of inquiries) {
    const k = r.decision_kind ?? 'pending'
    decisionCounts.set(k, (decisionCounts.get(k) ?? 0) + 1)
  }
  const decisionOrder = [...DECISION_KINDS, 'pending'] as string[]
  const byDecision: CountRow[] = [...decisionCounts.entries()]
    .sort((a, b) => {
      const ia = decisionOrder.indexOf(a[0]); const ib = decisionOrder.indexOf(b[0])
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
    })
    .map(([key, count]) => ({ key, label: decisionLabel(key), count }))

  // Eskalace podle důvodů (jedna poptávka může mít víc důvodů).
  const escalated = inquiries.filter((r) => r.decision_kind === 'escalate')
  const reasonCounts = new Map<string, number>()
  for (const r of escalated) {
    const codes = r.reason_codes && r.reason_codes.length > 0 ? new Set(r.reason_codes) : new Set(['_bez_duvodu'])
    for (const c of codes) reasonCounts.set(c, (reasonCounts.get(c) ?? 0) + 1)
  }
  const byReason: CountRow[] = [...reasonCounts.entries()]
    .map(([key, count]) => ({ key, label: key === '_bez_duvodu' ? 'Bez uvedeného důvodu' : reasonLabel(key), count }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'cs'))

  // Odchozí fronta v období (podle pražského dne zprávy).
  const periodOutbox = input.outbox.filter((o) => inPeriod(o.prague_day ?? (o.sent_at ? pragueDayOf(o.sent_at) : null), period))
  const countStatus = (...st: string[]) => periodOutbox.filter((o) => st.includes(o.status)).length

  // Ruční odpovědi obchodu: odchozí e-mail z mail_event pro firmu poptávky.
  const outboundByAccount = new Map<number, number[]>()
  for (const e of input.mailEvents) {
    if (e.direction !== 'outbound' || e.account_id == null) continue
    const t = ms(e.occurred_at)
    if (!Number.isFinite(t)) continue
    outboundByAccount.set(e.account_id, [...(outboundByAccount.get(e.account_id) ?? []), t])
  }

  const firstResponse: number[] = []
  const offerSpeed: number[] = []
  let firstWaiting = 0
  let offerWaiting = 0
  let auto = 0
  for (const r of real) {
    const received = ms(r.received_at)
    const mine = refs.get(inquirySourceRef(r)) ?? []
    const sentTimes = mine.filter((o) => o.status === 'sent' && o.sent_at).map((o) => ms(o.sent_at)).filter((t) => t >= received)
    const manual = r.account_id != null ? (outboundByAccount.get(r.account_id) ?? []).filter((t) => t >= received) : []
    const first = Math.min(...sentTimes, ...manual)
    if (Number.isFinite(first)) firstResponse.push(minutesBetween(r.received_at, first))
    else firstWaiting++

    // Rychlost nabídky: první odeslaná nabídka z fronty k poptávce (nebo k jejímu obchodu).
    const offers = input.outbox.filter((o) => o.kind === 'offer' && o.status === 'sent' && o.sent_at
      && (outboxBelongsTo(o, inquirySourceRef(r)) || (r.deal_id != null && o.deal_id === r.deal_id)))
      .map((o) => ms(o.sent_at)).filter((t) => t >= received)
    if (offers.length > 0) offerSpeed.push(minutesBetween(r.received_at, Math.min(...offers)))
    else if (r.decision_kind === 'send_offer' || r.decision_kind === 'escalate') offerWaiting++

    // Automaticky vyřízená = agent rozhodl sám a jeho zpráva odešla z fronty.
    if ((r.decision_kind === 'send_offer' || r.decision_kind === 'ask_info') && mine.some((o) => o.status === 'sent')) auto++
  }

  // Trychtýř: obchody založené v období podle dosažené fáze (deal.phase).
  const cohort = input.deals.filter((d) => inPeriod(pragueDayOf(d.created_at), period))
  const reached = (d: AgentDealRow) => {
    const i = d.phase ? phases.findIndex((p) => p.key === d.phase) : 0
    return i < 0 ? 0 : i
  }
  const funnelCounts = phases.map((_, i) => cohort.filter((d) => reached(d) >= i).length)
  const funnel: FunnelStep[] = phases.map((p, i) => ({
    key: p.key,
    label: p.label,
    count: funnelCounts[i],
    pctOfFirst: funnelCounts[0] > 0 ? pct(funnelCounts[i], funnelCounts[0]) : null,
    pctOfPrevious: i === 0 ? null : pct(funnelCounts[i], funnelCounts[i - 1]),
  }))

  // Výhry a prohry uzavřené v období (prohra = stage 'prohráno', výhra = vyhraná fáze).
  const closedDay = (d: AgentDealRow) => d.closed_at ?? d.won_at ?? null
  const isLost = (d: AgentDealRow) => d.stage === 'prohráno'
  const isWon = (d: AgentDealRow) => !isLost(d) && (won.has(d.phase ?? '') || d.stage === 'vyhráno')
  const closedInPeriod = input.deals.filter((d) => inPeriod(closedDay(d), period) || (isWon(d) && !closedDay(d) && inPeriod(pragueDayOf(d.created_at), period)))
  const wonN = closedInPeriod.filter(isWon).length
  const lostDeals = closedInPeriod.filter(isLost)
  const openN = cohort.filter((d) => !isWon(d) && !isLost(d) && d.stage !== 'odloženo').length

  const lostCounts = new Map<string, number>()
  for (const d of lostDeals) {
    const k = parseLostReason(d.lost_reason, lostReasons).key ?? LEGACY_LOST_KEY
    lostCounts.set(k, (lostCounts.get(k) ?? 0) + 1)
  }
  const lostRows: CountRow[] = [...lostCounts.entries()]
    .map(([key, count]) => ({
      key, count,
      label: key === LEGACY_LOST_KEY ? LEGACY_LOST_LABEL : lostReasons.find((r) => r.key === key)?.label ?? key,
    }))
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label, 'cs'))

  return {
    period,
    inquiries: {
      received: inquiries.length,
      real: real.length,
      email: inquiries.filter((r) => r.source === 'email').length,
      web: inquiries.filter((r) => r.source === 'web').length,
      byDecision,
    },
    escalations: { total: escalated.length, byReason },
    outbox: {
      sent: countStatus('sent'),
      queued: countStatus('queued', 'claimed'),
      failed: countStatus('failed'),
      needsAttention: countStatus('needs_attention'),
      blocked: countStatus('blocked'),
    },
    firstResponse: durationStat(firstResponse, firstWaiting),
    offerSpeed: durationStat(offerSpeed, offerWaiting),
    autoShare: { auto, total: real.length, pct: pct(auto, real.length) },
    funnel,
    outcome: { won: wonN, lost: lostDeals.length, open: openN, winRatePct: pct(wonN, wonN + lostDeals.length) },
    lostReasons: lostRows,
  }
}

// --- Tabulka posledních rozhodnutí -----------------------------------------

export type AgentActivityRow = {
  key: string
  source: AgentInquirySource
  receivedAt: string
  /** Jméno firmy z CRM (nikdy e-mail ani jméno osoby); null = nespárováno. */
  client: string | null
  segment: string | null
  decision: string
  decisionLabel: string
  reasons: string[]
  sendStatus: string | null
  sendLabel: string
  /** Odkaz na obchod v Cockpitu; null = obchod zatím nevznikl. */
  dealHref: string | null
}

export function dealHref(dealId: number | null, accountId: number | null): string | null {
  if (dealId == null) return null
  return accountId != null ? `/cockpit/clients/${accountId}/deals/${dealId}` : '/cockpit/pipeline'
}

export function segmentLabel(key: string | null | undefined): string {
  if (!key) return '—'
  return COMPANY.capabilities.standardOffer?.priceMap.segments.find((s) => s.key === key)?.label ?? key
}

/** Nejnovější rozhodnutí nahoře; stav odeslání = poslední zpráva fronty k poptávce. */
export function agentActivityRows(
  inquiries: readonly AgentInquiryRow[],
  outbox: readonly AgentOutboxRow[],
  accountNames: ReadonlyMap<number, string>,
  limit = 50,
): AgentActivityRow[] {
  const refs = outboxByRef(outbox)
  return [...inquiries]
    .sort((a, b) => ms(b.received_at) - ms(a.received_at))
    .slice(0, limit)
    .map((r) => {
      const mine = (refs.get(inquirySourceRef(r)) ?? []).sort((a, b) => b.id - a.id)
      const last = mine[0] ?? null
      const decision = r.decision_kind ?? 'pending'
      return {
        key: inquirySourceRef(r),
        source: r.source,
        receivedAt: r.received_at,
        client: r.account_id != null ? accountNames.get(r.account_id) ?? null : null,
        segment: r.segment,
        decision,
        decisionLabel: decisionLabel(decision),
        reasons: (r.reason_codes ?? []).map(reasonLabel),
        sendStatus: last?.status ?? null,
        sendLabel: outboxStatusLabel(last?.status),
        dealHref: dealHref(r.deal_id, r.account_id),
      }
    })
}

export type AgentAttentionRow = {
  id: number
  kind: string
  kindLabel: string
  status: string
  statusLabel: string
  stopReason: string | null
  /** Důvod zastavení česky (kód, když popisek chybí). */
  stopReasonLabel: string | null
  day: string | null
  dealHref: string | null
  /** Smí ji člověk uvolnit tlačítkem (agent_outbox_release)? Nabídka se schvaluje v Ke schválení. */
  releasable: boolean
}

/** Stavy, ze kterých zprávu vrací do fronty agent_outbox_release (0104). */
export const RELEASABLE_STATUSES = ['blocked', 'failed', 'needs_attention'] as const

export function isReleasable(o: Pick<AgentOutboxRow, 'kind' | 'status' | 'stop_reason'>): boolean {
  return (RELEASABLE_STATUSES as readonly string[]).includes(o.status) && o.kind !== 'offer' && o.stop_reason !== 'body_purged' && o.stop_reason !== 'gdpr_erased'
}

const EXTRA_STOP_LABELS: Readonly<Record<string, string>> = {
  approval_required: 'čeká na schválení člověkem',
  approval_rejected: 'schválení bylo zamítnuto',
  approval_expired: 'žádost o schválení vypršela',
  stale_claim: 'odesílání se nedokončilo — ověřit v Odeslané poště',
  throttled: 'Gmail dočasně omezil odesílání',
  gdpr_erased: 'údaje smazány na žádost (GDPR)',
  missing_unsubscribe: 'oslovení bez odkazu na odhlášení',
  outside_send_window: 'mimo okno odesílání',
}

export function outboxStopReasonLabel(code: string | null | undefined): string | null {
  if (!code) return null
  return (OUTBOX_REASON_LABELS as Readonly<Record<string, string>>)[code] ?? EXTRA_STOP_LABELS[code] ?? code
}

/** Fronta, která chce člověka (needs_attention, blocked) — nejstarší nahoře. */
export function attentionRows(
  outbox: readonly AgentOutboxRow[],
  dealAccounts: ReadonlyMap<number, number | null>,
): AgentAttentionRow[] {
  return outbox
    .filter((o) => (ATTENTION_STATUSES as readonly string[]).includes(o.status))
    .sort((a, b) => (a.prague_day ?? '').localeCompare(b.prague_day ?? '') || a.id - b.id)
    .map((o) => ({
      id: o.id,
      kind: o.kind,
      kindLabel: outboxKindLabel(o.kind),
      status: o.status,
      statusLabel: outboxStatusLabel(o.status),
      stopReason: o.stop_reason,
      stopReasonLabel: outboxStopReasonLabel(o.stop_reason),
      day: o.prague_day,
      dealHref: dealHref(o.deal_id, o.deal_id != null ? dealAccounts.get(o.deal_id) ?? null : null),
      releasable: isReleasable(o),
    }))
}

// --- Přehled odchozí fronty (P3) -------------------------------------------------

export type AgentOutboxListRow = AgentOutboxRow & { created_at: string }

export type AgentOutboxQueueItem = Omit<AgentAttentionRow, 'day'> & { createdAt: string; sentAt: string | null }

export type AgentOutboxQueue = {
  /** Kolik zpráv je teď v jednotlivých neukončených stavech (bez ohledu na období). */
  open: CountRow[]
  /** Posledních N zpráv (nejnovější nahoře) — druh, stav, důvod; nikdy adresa ani text. */
  recent: AgentOutboxQueueItem[]
}

const OPEN_OUTBOX_STATUSES = ['queued', 'claimed', 'blocked', 'failed', 'needs_attention'] as const

export function outboxQueueOverview(
  openStatuses: readonly { status: string }[],
  recent: readonly AgentOutboxListRow[],
  dealAccounts: ReadonlyMap<number, number | null>,
): AgentOutboxQueue {
  const counts = new Map<string, number>()
  for (const r of openStatuses) counts.set(r.status, (counts.get(r.status) ?? 0) + 1)
  return {
    open: OPEN_OUTBOX_STATUSES.map((st) => ({ key: st, label: outboxStatusLabel(st), count: counts.get(st) ?? 0 })),
    recent: recent.map((o) => ({
      id: o.id,
      kind: o.kind,
      kindLabel: outboxKindLabel(o.kind),
      status: o.status,
      statusLabel: outboxStatusLabel(o.status),
      stopReason: o.stop_reason,
      stopReasonLabel: outboxStopReasonLabel(o.stop_reason),
      createdAt: o.created_at,
      sentAt: o.sent_at,
      dealHref: dealHref(o.deal_id, o.deal_id != null ? dealAccounts.get(o.deal_id) ?? null : null),
      releasable: isReleasable(o),
    })),
  }
}
