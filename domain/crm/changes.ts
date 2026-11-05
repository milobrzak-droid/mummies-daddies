// „Co se změnilo": ranní přehled změn od poslední návštěvy a za týden Po–Ne.
// Čisté funkce bez I/O (čtení dat je v domain/crm/queries/changes.ts).
//
// ZÁSADA: každá položka nese DŮKAZ — odkaz na záznam, ze kterého vznikla,
// a jeho označení (číslo záznamu v auditu, číslo úkolu, čas přijetí pošty).
// Nic se nedopočítává ani neodhaduje; co v datech není, se neukáže.
//
// OKNO ZMĚN
//   Dnes: od poslední návštěvy člověka. Kdy byla, drží tabulka changes_view
//   (0075). „Návštěva" = série otevření obrazovky s mezerami do
//   CHANGES_VISIT_GAP_MINUTES; po delší pauze se okno posune na poslední
//   otevření z minula. Obnovení stránky okno nemění, ať seznam po F5
//   nezmizí. První návštěva (nebo chybějící tabulka) = posledních 7 dní,
//   velmi stará návštěva = nejvýš 30 dní zpět.
//   Týden: pražské pondělí 00:00 až následující pondělí 00:00 (Po–Ne).
//
// OPRÁVNĚNÍ: e-maily od klientů, posuny fází obchodů, posunuté a zrušené
// schůzky a faktury/platby jsou obchodní věci (can_see_sales, 0058) — pro
// ostatní role se nenačítají a buildChangeSections je i z hotových položek
// vyřadí.

import { DEAL_STAGES, engagementKindLabel } from '@/lib/domain'
import { normalizeDealStage } from '@/lib/dealStageLegacy'
import { formatCzk } from '@/lib/format'
import {
  addDaysToPragueDay, daysBetweenPragueDays, pragueDayOf, pragueLocalToUtc, pragueToday,
} from '@/lib/pragueDate'
import { clockTime, isoWeek, plural } from '@/domain/crm/today'
import { CALENDAR_SYNC_JOB, meetingWhenLabel } from '@/domain/crm/meetingCalendar'
import { MILESTONE_STATUS_LABEL, isMilestoneStatus } from '@/domain/delivery/milestone'
import { isDocumentStatus } from '@/domain/delivery/documents'
import { findingSentence } from '@/domain/delivery/documentWatch'
import { APPROVAL_ACTIONS, isApprovalActionType } from '@/core/approvalActions'
import { workSummary } from '@/lib/memberWork'
import { isOwnerKind } from '@/lib/ownerChange'

/** Mezera mezi otevřeními, po které začíná nová návštěva. Drží ručně synchronně 0075 (interval '240 minutes'). */
export const CHANGES_VISIT_GAP_MINUTES = 240
export const CHANGES_FIRST_VISIT_DAYS = 7
export const CHANGES_MAX_LOOKBACK_DAYS = 30

const DAY_MS = 86_400_000

// --- Okno změn --------------------------------------------------------------

export type ViewRow = { baseline_at: string | null; last_open_at: string }

export type ChangeWindow = {
  since: Date
  until: Date
  kind: 'visit' | 'first' | 'capped' | 'week'
  /** Věta do hlavičky karty („od tvé poslední návštěvy dnes v 8:15"). */
  label: string
  /** Vysvětlení, proč okno není „od poslední návštěvy"; jinak null. */
  note: string | null
}

const WEEKDAY_SHORT = ['ne', 'po', 'út', 'st', 'čt', 'pá', 'so']

/** Den v týdnu pražského dne YYYY-MM-DD (0 = neděle). */
function weekdayOf(day: string): number {
  return new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10))).getUTCDay()
}

/** „29. 9." z YYYY-MM-DD. */
function shortDay(day: string): string {
  return `${Number(day.slice(8, 10))}. ${Number(day.slice(5, 7))}.`
}

/** Pevný zápis času pro důkaz: „29. 9. 10:15" (pražský čas, bez „dnes/včera"). */
export function stamp(iso: string | null | undefined): string {
  if (!iso || Number.isNaN(Date.parse(iso))) return '—'
  return `${shortDay(pragueDayOf(iso))} ${clockTime(iso)}`
}

/** „dnes v 8:15", „včera v 8:15", „čt 24. 9. v 8:15". */
export function whenLabel(at: Date, now: Date): string {
  const day = pragueDayOf(at)
  const diff = daysBetweenPragueDays(day, pragueToday(now))
  const clock = clockTime(at.toISOString())
  if (diff === 0) return `dnes v ${clock}`
  if (diff === 1) return `včera v ${clock}`
  return `${WEEKDAY_SHORT[weekdayOf(day)]} ${shortDay(day)} v ${clock}`
}

/**
 * Okno „od poslední návštěvy". Stejné pravidlo návštěvy jako touch_changes_view()
 * v 0075, takže platí před zápisem i po něm.
 */
export function resolveVisitWindow(row: ViewRow | null, now: Date, opts: { tracked?: boolean } = {}): ChangeWindow {
  const tracked = opts.tracked ?? true
  const fromDays = (days: number) => new Date(now.getTime() - days * DAY_MS)

  let since: Date | null = null
  if (row) {
    const last = Date.parse(row.last_open_at)
    const baseline = row.baseline_at ? Date.parse(row.baseline_at) : NaN
    const newVisit = !Number.isNaN(last) && now.getTime() - last > CHANGES_VISIT_GAP_MINUTES * 60_000
    const effective = newVisit ? last : baseline
    if (!Number.isNaN(effective)) since = new Date(effective)
  }

  if (!since) {
    return {
      since: fromDays(CHANGES_FIRST_VISIT_DAYS),
      until: now,
      kind: 'first',
      label: `za posledních ${CHANGES_FIRST_VISIT_DAYS} dní`,
      note: tracked
        ? 'Je to tvoje první návštěva, proto ukazuju poslední týden.'
        : 'Čas poslední návštěvy se zatím neukládá, proto ukazuju poslední týden.' // technicky: chybí migrace 0075,
    }
  }
  const floor = fromDays(CHANGES_MAX_LOOKBACK_DAYS)
  if (since.getTime() < floor.getTime()) {
    return {
      since: floor,
      until: now,
      kind: 'capped',
      label: `za posledních ${CHANGES_MAX_LOOKBACK_DAYS} dní`,
      note: 'Tvoje poslední návštěva byla dávno, ukazuju jen poslední měsíc.',
    }
  }
  return { since, until: now, kind: 'visit', label: `od tvé poslední návštěvy (${whenLabel(since, now)})`, note: null }
}

/** Pondělí (YYYY-MM-DD) týdne, do kterého den patří. */
export function mondayOf(day: string): string {
  return addDaysToPragueDay(day, -((weekdayOf(day) + 6) % 7))
}

export type WeekChoice = 'minuly' | 'tento'

/** Pá–Ne: probíhající týden (páteční přehled); Po–Čt: předchozí Po–Ne (pondělní přehled). */
export function defaultWeek(today: string): WeekChoice {
  const dow = weekdayOf(today)
  return dow === 5 || dow === 6 || dow === 0 ? 'tento' : 'minuly'
}

export function parseWeekChoice(v: string | string[] | undefined, today: string): WeekChoice {
  const s = Array.isArray(v) ? v[0] : v
  return s === 'tento' || s === 'minuly' ? s : defaultWeek(today)
}

export function weekWindow(today: string, which: WeekChoice): ChangeWindow {
  const monday = mondayOf(today)
  const start = which === 'minuly' ? addDaysToPragueDay(monday, -7) : monday
  const end = addDaysToPragueDay(start, 7)
  const sunday = addDaysToPragueDay(start, 6)
  return {
    since: pragueLocalToUtc(`${start}T00:00`),
    until: pragueLocalToUtc(`${end}T00:00`),
    kind: 'week',
    label: `za týden ${isoWeek(start)}: po ${shortDay(start)} až ne ${shortDay(sunday)}`,
    note: null,
  }
}

// --- Druhy změn -------------------------------------------------------------

export type ChangeKind = 'intake' | 'email' | 'stage' | 'meeting' | 'delivery' | 'decision' | 'work' | 'handover' | 'milestone' | 'document' | 'money'
export type ChangeTone = 'sky' | 'peach' | 'mint' | 'lav' | 'sun' | 'pink'

export const CHANGE_KINDS: readonly { kind: ChangeKind; label: string; tone: ChangeTone; salesOnly: boolean }[] = [
  { kind: 'intake', label: 'Nové poptávky', tone: 'mint', salesOnly: true },
  { kind: 'email', label: 'Nové e-maily od klientů', tone: 'sky', salesOnly: true },
  { kind: 'stage', label: 'Posun fáze obchodu', tone: 'lav', salesOnly: true },
  // Schůzky jsou obchodní data (sales_activity, 0058). Posun milníku, který
  // z posunu schůzky vznikl, ukazuje druh „Milníky dodávek" celému týmu.
  { kind: 'meeting', label: 'Posunuté a zrušené schůzky', tone: 'sky', salesOnly: true },
  // Dodávka není obchodní číslo (bez částek), proto ji vidí celý tým.
  { kind: 'delivery', label: 'Nové dodávky', tone: 'mint', salesOnly: false },
  { kind: 'decision', label: 'Rozhodnutí', tone: 'mint', salesOnly: false },
  { kind: 'work', label: 'Nové úkoly a případy', tone: 'sun', salesOnly: false },
  // Předání práce člověka (0088): jen počty a jména, bez obsahu obchodů.
  { kind: 'handover', label: 'Předání práce', tone: 'lav', salesOnly: false },
  { kind: 'milestone', label: 'Milníky dodávek', tone: 'peach', salesOnly: false },
  // Dokumenty dodávek (0094): denní kontrola SharePointu — změnil se od schválení,
  // zmizel, nemá přístup. Bez částek a bez obsahu souboru, proto celý tým.
  { kind: 'document', label: 'Dokumenty dodávek', tone: 'sky', salesOnly: false },
  { kind: 'money', label: 'Faktury a platby', tone: 'pink', salesOnly: true },
]

export function isSalesOnlyKind(kind: ChangeKind): boolean {
  return CHANGE_KINDS.find((k) => k.kind === kind)?.salesOnly ?? true
}

export type ChangeItem = {
  key: string
  kind: ChangeKind
  /** Čas změny (ISO); podle něj se řadí. */
  at: string
  title: string
  detail: string
  /** Kam vede důkaz — záznam, ze kterého změna vznikla. */
  href: string
  /** Označení důkazu („Záznam v auditu č. 4512"). */
  proof: string
  /** Kolik změn položka shrnuje (e-maily jednoho klienta); výchozí 1. */
  count?: number
  /** Dodávka, ke které změna patří (milníky a nové dodávky); jinak chybí. */
  engagementId?: number
}

const byNewest = (a: ChangeItem, b: ChangeItem) => Date.parse(b.at) - Date.parse(a.at) || a.key.localeCompare(b.key)
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s)

// --- Nové poptávky založené automaticky z e-mailu (auto_intake, 0081) ---------

export type IntakeRow = {
  id: number
  account_id: number
  /** Kdy Cockpit klienta založil. */
  created_at: string
  /** Kdy e-mail přišel. */
  occurred_at: string
  account_name: string | null
  /** Termín dalšího kroku obchodu („Odpovědět na poptávku"), YYYY-MM-DD. */
  next_step_due: string | null
}

/**
 * Poptávky, které Cockpit založil sám z e-mailu a člověk je nevrátil
 * („Není poptávka"). Jen metadata: název firmy, odkaz na klienta, kdy e-mail
 * přišel — nic z obsahu zprávy.
 */
export function intakeChanges(rows: readonly IntakeRow[]): ChangeItem[] {
  return rows
    .map((r): ChangeItem => {
      const due = r.next_step_due && /^\d{4}-\d{2}-\d{2}$/.test(r.next_step_due) ? r.next_step_due : null
      return {
        key: `intake-${r.id}`,
        kind: 'intake',
        at: r.created_at,
        title: `Nová poptávka: ${r.account_name?.trim() || 'firma'}`,
        detail: `Vzniklo automaticky z e-mailu${due ? ` · odpovědět do ${shortDay(due)}` : ''}`,
        href: `/cockpit/clients/${r.account_id}`,
        proof: `Automatické založení č. ${r.id}, e-mail přijat ${stamp(r.occurred_at)}`,
      }
    })
    .sort(byNewest)
}

// --- E-maily od klientů (mail_event, jen metadata) --------------------------

export type MailRow = { id: number; occurred_at: string; account_id: number; account_name: string | null }

export function emailChanges(rows: readonly MailRow[]): ChangeItem[] {
  const byAccount = new Map<number, MailRow[]>()
  for (const r of rows) byAccount.set(r.account_id, [...(byAccount.get(r.account_id) ?? []), r])
  const out: ChangeItem[] = []
  for (const [accountId, list] of byAccount) {
    const latest = list.reduce((a, b) => (Date.parse(b.occurred_at) > Date.parse(a.occurred_at) ? b : a))
    const n = list.length
    out.push({
      key: `email-${accountId}`,
      kind: 'email',
      at: latest.occurred_at,
      title: latest.account_name?.trim() || 'Klient',
      detail: `${n} ${plural(n, 'nový e-mail', 'nové e-maily', 'nových e-mailů')} od klienta`,
      href: `/cockpit/clients/${accountId}`,
      proof: `Pošta klienta, poslední e-mail přijat ${stamp(latest.occurred_at)}`,
      count: n,
    })
  }
  return out.sort(byNewest)
}

// --- Posun fáze obchodu (audit deal.stage_changed / deal.created) -----------

export type AuditRow = {
  id: number
  action: string
  entity_id: number
  occurred_at: string
  before: unknown
  after: unknown
}
export type DealInfo = { id: number; title: string | null; account_id: number | null; account_name: string | null }

const prop = (v: unknown, key: string): unknown =>
  v && typeof v === 'object' ? (v as Record<string, unknown>)[key] : undefined

export function dealStageLabel(stage: unknown): string {
  if (typeof stage !== 'string') return '—'
  const key = normalizeDealStage(stage) ?? stage
  return DEAL_STAGES.find((s) => s.key === key)?.label ?? stage
}

export function stageChanges(events: readonly AuditRow[], deals: ReadonlyMap<number, DealInfo>): ChangeItem[] {
  const byDeal = new Map<number, AuditRow[]>()
  for (const e of events) {
    if (e.action !== 'deal.stage_changed' && e.action !== 'deal.created') continue
    byDeal.set(e.entity_id, [...(byDeal.get(e.entity_id) ?? []), e])
  }
  const out: ChangeItem[] = []
  for (const [dealId, list] of byDeal) {
    const sorted = [...list].sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at) || a.id - b.id)
    const last = sorted[sorted.length - 1]
    const created = sorted.find((e) => e.action === 'deal.created')
    const moves = sorted.filter((e) => e.action === 'deal.stage_changed')
    let detail: string
    if (created) {
      detail = 'Nový obchod'
    } else {
      const from = prop(moves[0].before, 'stage')
      const to = prop(moves[moves.length - 1].after, 'stage')
      // Fáze se vrátila tam, kde byla: čistá změna je nulová, nic neukazujeme.
      if (from === to) continue
      detail = `${dealStageLabel(from)} → ${dealStageLabel(to)}`
    }
    const deal = deals.get(dealId)
    const firm = deal?.account_name?.trim()
    const title = [firm, deal?.title?.trim()].filter(Boolean).join(' · ') || `Obchod č. ${dealId}`
    out.push({
      key: `stage-${dealId}`,
      kind: 'stage',
      at: last.occurred_at,
      title,
      detail,
      href: deal?.account_id ? `/cockpit/clients/${deal.account_id}/deals/${dealId}` : '/cockpit/pipeline',
      proof: `Záznam v auditu č. ${last.id}, ${stamp(last.occurred_at)}`,
    })
  }
  return out.sort(byNewest)
}

// --- Posunuté a zrušené schůzky (audit sales_activity) ----------------------

export type MeetingInfo = {
  id: number
  subject: string | null
  /** Začátek schůzky teď (ISO). */
  occurred_at: string
  outcome: string | null
  account_id: number | null
  account_name: string | null
}

/** Auditní řádek i s aktérem — ať je vidět, že změnu přinesl Outlook. */
export type ActorAuditRow = AuditRow & { actor_type?: string | null; actor_id?: string | null }

const fromOutlook = (e: ActorAuditRow) => e.actor_type === 'system' && e.actor_id === CALENDAR_SYNC_JOB
const isCancelEvent = (e: AuditRow) => changedCols(e).includes('outcome') && prop(e.after, 'outcome') === 'cancelled'

/** Změna schůzky, která patří do „Posunuté a zrušené schůzky" (posun začátku nebo zrušení). */
export function isMeetingShiftEvent(e: AuditRow): boolean {
  return e.action === 'sales_activity.updated' && (changedCols(e).includes('occurred_at') || isCancelEvent(e))
}

/**
 * Schůzky, které se v okně posunuly nebo zrušily — typicky kontrolou
 * kalendáře (aktér system:calendar-sync), když se to stalo v Outlooku.
 * Posun sem a zpátky v jednom okně (čistá změna nulová) se neukáže. Zápis
 * schůzky, který doplnil naplánovanou schůzku (planned → completed), sem
 * nepatří.
 */
export function meetingChanges(events: readonly ActorAuditRow[], meetings: ReadonlyMap<number, MeetingInfo>): ChangeItem[] {
  const byMeeting = new Map<number, ActorAuditRow[]>()
  for (const e of events) {
    if (!isMeetingShiftEvent(e)) continue
    byMeeting.set(e.entity_id, [...(byMeeting.get(e.entity_id) ?? []), e])
  }
  const out: ChangeItem[] = []
  for (const [id, list] of byMeeting) {
    const m = meetings.get(id)
    if (!m) continue
    const sorted = [...list].sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at) || a.id - b.id)
    const last = sorted[sorted.length - 1]
    const moves = sorted.filter((e) => changedCols(e).includes('occurred_at'))
    let detail: string
    if (m.outcome === 'cancelled' && sorted.some(isCancelEvent)) {
      detail = `Zrušeno · bylo naplánováno na ${meetingWhenLabel(m.occurred_at)}`
    } else if (moves.length > 0) {
      const from = prop(moves[0].before, 'occurred_at')
      const to = prop(moves[moves.length - 1].after, 'occurred_at')
      if (typeof from !== 'string' || typeof to !== 'string' || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) continue
      if (Date.parse(from) === Date.parse(to)) continue
      detail = `Přesunuto: ${meetingWhenLabel(from)} → ${meetingWhenLabel(to)}`
    } else {
      continue
    }
    if (sorted.every(fromOutlook)) detail += ' · podle Outlooku'
    out.push({
      key: `meeting-${id}`,
      kind: 'meeting',
      at: last.occurred_at,
      title: [m.account_name?.trim(), m.subject?.trim()].filter(Boolean).join(' · ') || `Schůzka č. ${id}`,
      detail,
      href: m.account_id ? `/cockpit/clients/${m.account_id}` : '/cockpit/schuzky',
      proof: `Záznam v auditu č. ${last.id}, ${stamp(last.occurred_at)}`,
    })
  }
  return out.sort(byNewest)
}

// --- Nové dodávky (založené automaticky po vyhrání obchodu, 0080) -----------

export type DeliveryRow = {
  id: number
  kind: string
  created_at: string
  account_id: number | null
  account_name: string | null
}

/**
 * Dodávky, které Cockpit sám založil po vyhrání obchodu (engagement.origin =
 * 'auto_deal_won'). Ruční dodávky sem nepatří — o těch člověk ví. Bez částek,
 * proto to vidí celý tým.
 */
export function deliveryChanges(rows: readonly DeliveryRow[]): ChangeItem[] {
  return rows.map((r): ChangeItem => ({
    key: `delivery-${r.id}`,
    kind: 'delivery',
    at: r.created_at,
    title: [r.account_name?.trim(), engagementKindLabel(r.kind)].filter(Boolean).join(' · '),
    detail: 'Dodávka byla založena automaticky po vyhrání obchodu',
    href: r.account_id ? `/cockpit/clients/${r.account_id}/engagements/${r.id}/edit` : '/cockpit/tasks',
    proof: `Dodávka č. ${r.id}, založena ${stamp(r.created_at)}`,
    engagementId: r.id,
  })).sort(byNewest)
}

// --- Rozhodnutí (approval_request, decision) --------------------------------

export type ApprovalRow = {
  id: number
  status: string
  decided_at: string | null
  decided_by: string | null
  action_kind: string
  case_id: number | null
  case_title: string | null
}
export type DecisionRow = {
  id: number
  question: string
  chosen: string | null
  decided_at: string | null
  decided_by: string | null
  case_id: number | null
  case_title: string | null
}

/** „user:<uuid>" → jméno člena týmu; systém a API mají vlastní slovo. */
export function decidedByLabel(actor: string | null | undefined, names: ReadonlyMap<string, string>): string | null {
  if (!actor) return null
  if (actor.startsWith('user:')) return names.get(actor.slice(5)) ?? null
  if (actor.startsWith('system:')) return 'systém'
  if (actor.startsWith('api_key:')) return 'přes API'
  return null
}

export function decisionChanges(
  input: { approvals: readonly ApprovalRow[]; decisions: readonly DecisionRow[] },
  names: ReadonlyMap<string, string>,
): ChangeItem[] {
  const out: ChangeItem[] = []
  for (const a of input.approvals) {
    if ((a.status !== 'approved' && a.status !== 'rejected') || !a.decided_at) continue
    const by = decidedByLabel(a.decided_by, names)
    out.push({
      key: `approval-${a.id}`,
      kind: 'decision',
      at: a.decided_at,
      // Typovaná žádost (0084) má action_kind = druh akce → český název.
      title: clip(a.case_title?.trim() || (isApprovalActionType(a.action_kind) ? APPROVAL_ACTIONS[a.action_kind].label : a.action_kind), 120),
      detail: `${a.status === 'approved' ? 'Schváleno' : 'Zamítnuto'}${by ? ` · ${by}` : ''}`,
      href: a.case_id ? `/cockpit/pripady/${a.case_id}` : '/cockpit/rozhodnuti',
      proof: `Žádost o schválení č. ${a.id}, ${stamp(a.decided_at)}`,
    })
  }
  for (const d of input.decisions) {
    if (!d.decided_at || !d.chosen) continue
    const by = decidedByLabel(d.decided_by, names)
    out.push({
      key: `decision-${d.id}`,
      kind: 'decision',
      at: d.decided_at,
      title: clip(d.question.trim(), 120),
      detail: `Rozhodnuto: ${clip(d.chosen.trim(), 80)}${by ? ` · ${by}` : ''}`,
      href: d.case_id ? `/cockpit/pripady/${d.case_id}` : '/cockpit/rozhodnuti',
      proof: `Rozhodnutí č. ${d.id}, ${stamp(d.decided_at)}`,
    })
  }
  return out.sort(byNewest)
}

// --- Nové úkoly a případy ---------------------------------------------------

export type TaskRow = {
  id: number
  title: string
  created_at: string
  created_by: string | null
  assignee_id: string | null
  due_on: string | null
  status: string
  account_name: string | null
}
export type CaseRow = {
  id: number
  title: string
  created_at: string
  created_by: string | null
  status: string
  account_name: string | null
}

/**
 * Úkoly pro mě (nebo bez řešitele) a případy, které nezaložil člověk sám.
 * Co jsem založil já, už vím — do „co se změnilo" to nepatří.
 */
export function workChanges(input: { tasks: readonly TaskRow[]; cases: readonly CaseRow[] }, meId: string | null): ChangeItem[] {
  const out: ChangeItem[] = []
  for (const t of input.tasks) {
    if (t.status === 'done') continue
    if (meId && t.created_by === meId) continue
    if (t.assignee_id !== null && t.assignee_id !== meId) continue
    const bits = ['Nový úkol']
    if (t.due_on && /^\d{4}-\d{2}-\d{2}$/.test(t.due_on)) bits.push(`termín ${shortDay(t.due_on)}`)
    if (t.account_name?.trim()) bits.push(t.account_name.trim())
    out.push({
      key: `task-${t.id}`,
      kind: 'work',
      at: t.created_at,
      title: clip(t.title.trim(), 120),
      detail: bits.join(' · '),
      href: '/cockpit/tasks',
      proof: `Úkol č. ${t.id}, založeno ${stamp(t.created_at)}`,
    })
  }
  for (const c of input.cases) {
    if (c.status === 'cancelled') continue
    if (meId && c.created_by === `user:${meId}`) continue
    const bits = ['Nový případ']
    if (c.created_by?.startsWith('system:')) bits.push('založil systém')
    if (c.account_name?.trim()) bits.push(c.account_name.trim())
    out.push({
      key: `case-${c.id}`,
      kind: 'work',
      at: c.created_at,
      title: clip(c.title.trim(), 120),
      detail: bits.join(' · '),
      href: `/cockpit/pripady/${c.id}`,
      proof: `Případ č. ${c.id}, založeno ${stamp(c.created_at)}`,
    })
  }
  return out.sort(byNewest)
}

// --- Předání práce (audit team_member, 0088, 0093) ---------------------------

export type HandoverEvent = {
  id: number
  action: string
  /** uuid člověka, od kterého se předávalo / který byl deaktivován (audit_event.entity_ref). */
  entity_ref: string | null
  actor_id: string | null
  occurred_at: string
  after: unknown
}

export const HANDOVER_ACTIONS = [
  'team_member.work_transferred',
  'team_member.deactivated_with_open_work',
  // Jednotlivá změna vlastníka nebo zástupce jedné věci (0093, change_work_owner).
  'team_member.work_item_reassigned',
] as const

const idOf = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : null)

/**
 * Kam vede položka o jednotlivé změně vlastníka. Obchody a cílové seznamy jsou
 * obchodní data (0058) — bez obchodní role odkaz nevede na jejich detail.
 */
function reassignedHref(after: unknown, canSeeSales: boolean): string {
  const kind = prop(after, 'kind')
  const id = idOf(prop(after, 'item_id'))
  const account = idOf(prop(after, 'account_id'))
  const engagement = idOf(prop(after, 'engagement_id'))
  if (!isOwnerKind(kind) || id === null) return '/cockpit/tasks'
  if (kind === 'pripady') return `/cockpit/pripady/${id}`
  if (kind === 'seznamy') return canSeeSales ? `/cockpit/cilove-seznamy/${id}` : '/cockpit/tasks'
  if (kind === 'obchody') return canSeeSales && account !== null ? `/cockpit/clients/${account}/deals/${id}` : '/cockpit/tasks'
  if (account === null || engagement === null) return '/cockpit/tasks'
  return kind === 'milniky'
    ? `/cockpit/clients/${account}/engagements/${engagement}/edit?zalozka=milniky#milnik-${id}`
    : `/cockpit/clients/${account}/engagements/${engagement}/edit?zalozka=tym`
}

function countsOf(after: unknown): Record<string, number> {
  const c = prop(after, 'counts')
  if (!c || typeof c !== 'object') return {}
  return Object.fromEntries(Object.entries(c as Record<string, unknown>).filter(([, v]) => typeof v === 'number') as [string, number][])
}

/**
 * Hromadné předání práce („Předat práci" v Týmu) a deaktivace člověka, který
 * měl otevřenou práci. Důkaz = záznam v auditu. Jména z týmu, jinak „člen týmu".
 */
export function handoverChanges(
  events: readonly HandoverEvent[],
  names: ReadonlyMap<string, string>,
  opts: { canSeeSales?: boolean } = {},
): ChangeItem[] {
  const who = (id: unknown) => (typeof id === 'string' && names.get(id)) || 'člen týmu'
  const out: ChangeItem[] = []
  for (const e of events) {
    const counts = countsOf(e.after)
    const by = e.actor_id ? names.get(e.actor_id) : undefined
    if (e.action === 'team_member.work_item_reassigned') {
      // Jedna věc (případ, milník, obchod, dodávka, seznam): od koho komu a v jaké roli.
      const role = prop(e.after, 'role') === 'deputy' ? 'deputy' : 'owner'
      const from = prop(e.after, 'from_member_id')
      const to = prop(e.after, 'to_member_id')
      const freed = counts.bez_zastupce ?? 0
      const undone = idOf(prop(e.after, 'undo_of')) !== null
      out.push({
        key: `handover-${e.id}`,
        kind: 'handover',
        at: e.occurred_at,
        title: `${typeof from === 'string' ? who(from) : role === 'owner' ? 'Bez vlastníka' : 'Bez zástupce'} → ${typeof to === 'string' ? who(to) : 'bez zástupce'}`,
        detail: [
          `${undone ? 'Vráceno zpět' : 'Předáno'}: ${workSummary(counts)} (${role === 'owner' ? 'vlastník' : 'zástupce'})`,
          freed > 0 ? `${freed} bez zástupce` : null,
          by ? `${undone ? 'vrátil(a)' : 'předal(a)'} ${by}` : null,
        ].filter(Boolean).join(' · '),
        href: reassignedHref(e.after, opts.canSeeSales ?? false),
        proof: `Záznam v auditu č. ${e.id}, ${stamp(e.occurred_at)}`,
      })
    } else if (e.action === 'team_member.work_transferred') {
      const freed = counts.bez_zastupce ?? 0
      out.push({
        key: `handover-${e.id}`,
        kind: 'handover',
        at: e.occurred_at,
        title: `${who(e.entity_ref)} → ${who(prop(e.after, 'to_member_id'))}`,
        detail: [`Předáno: ${workSummary(counts)}`, freed > 0 ? `${freed} bez zástupce` : null, by ? `předal(a) ${by}` : null]
          .filter(Boolean).join(' · '),
        href: '/cockpit/tasks',
        proof: `Záznam v auditu č. ${e.id}, ${stamp(e.occurred_at)}`,
      })
    } else if (e.action === 'team_member.deactivated_with_open_work') {
      out.push({
        key: `handover-${e.id}`,
        kind: 'handover',
        at: e.occurred_at,
        title: `${who(e.entity_ref)}: deaktivace s otevřenou prací`,
        detail: [`Nepředáno: ${workSummary(counts)}`, by ? `potvrdil(a) ${by}` : null].filter(Boolean).join(' · '),
        href: e.entity_ref ? `/cockpit/tym/${e.entity_ref}/predat` : '/cockpit/tym',
        proof: `Záznam v auditu č. ${e.id}, ${stamp(e.occurred_at)}`,
      })
    }
  }
  return out.sort(byNewest)
}

// --- Milníky dodávek --------------------------------------------------------

export type MilestoneInfo = {
  id: number
  title: string
  status: string
  updated_at: string | null
  engagement_id: number
  account_id: number | null
  account_name: string | null
}

const statusLabel = (s: unknown): string => (isMilestoneStatus(s) ? MILESTONE_STATUS_LABEL[s] : typeof s === 'string' ? s : '—')

function changedCols(e: AuditRow): string[] {
  const c = prop(e.after, '_columns')
  return Array.isArray(c) ? c.filter((x): x is string => typeof x === 'string') : []
}

/**
 * Posuny milníků: stav a termín z auditu (po 0064 řádková změna, dřív appková
 * volání). Milník, který se v okně změnil, ale audit o něm nic nemá, se ukáže
 * jen obecně („změněn, teď: …") podle updated_at — bez vymýšlení, co se změnilo.
 */
export function milestoneChanges(
  input: {
    events: readonly AuditRow[]
    milestones: readonly MilestoneInfo[]
    /**
     * Dodávky, které Cockpit v okně sám založil (0080) i s milníky podle
     * šablony. Jejich vznik hlásí jedna položka „Nové dodávky", ne jeden
     * „Nový milník" za každý řádek šablony — proto se u nich ukážou jen
     * skutečné posuny (stav, termín).
     */
    freshEngagementIds?: ReadonlySet<number>
  },
  win: { since: Date; until: Date },
): ChangeItem[] {
  const fresh = input.freshEngagementIds ?? new Set<number>()
  const info = new Map(input.milestones.map((m) => [m.id, m]))
  const byMilestone = new Map<number, AuditRow[]>()
  for (const e of input.events) byMilestone.set(e.entity_id, [...(byMilestone.get(e.entity_id) ?? []), e])

  const link = (m: MilestoneInfo) =>
    m.account_id ? `/cockpit/clients/${m.account_id}/engagements/${m.engagement_id}/edit?zalozka=milniky` : '/cockpit/tasks'
  const heading = (m: MilestoneInfo) => `${m.title}${m.account_name?.trim() ? ` · ${m.account_name.trim()}` : ''}`

  const out: ChangeItem[] = []
  for (const [id, list] of byMilestone) {
    const m = info.get(id)
    if (!m) continue
    const sorted = [...list].sort((a, b) => Date.parse(a.occurred_at) - Date.parse(b.occurred_at))
    const last = sorted[sorted.length - 1]
    const bits: string[] = []

    if (sorted.some((e) => e.action === 'engagement_milestone.created') && !fresh.has(m.engagement_id)) bits.push('Nový milník')

    const statusEvents = sorted.filter((e) =>
      e.action === 'milestone.status' || e.action === 'milestone.accepted'
      || (e.action === 'engagement_milestone.updated' && changedCols(e).includes('status')))
    if (statusEvents.length > 0) {
      const from = prop(statusEvents[0].before, 'status')
      const to = prop(statusEvents[statusEvents.length - 1].after, 'status')
      if (from !== to) bits.push(`Stav: ${statusLabel(from)} → ${statusLabel(to)}`)
    }

    const dueEvents = sorted.filter((e) => e.action === 'engagement_milestone.updated' && changedCols(e).includes('due_on'))
    if (dueEvents.length > 0) {
      const from = prop(dueEvents[0].before, 'due_on')
      const to = prop(dueEvents[dueEvents.length - 1].after, 'due_on')
      const fmt = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? shortDay(v) : 'bez termínu')
      if (from !== to) bits.push(`Termín: ${fmt(from)} → ${fmt(to)}`)
    }

    if (bits.length === 0) continue
    out.push({
      key: `milestone-${id}`,
      kind: 'milestone',
      at: last.occurred_at,
      title: heading(m),
      detail: bits.join(' · '),
      href: link(m),
      proof: `Záznam v auditu č. ${last.id}, ${stamp(last.occurred_at)}`,
      engagementId: m.engagement_id,
    })
  }

  for (const m of input.milestones) {
    if (byMilestone.has(m.id) || !m.updated_at) continue
    // Nový milník automaticky založené dodávky bez posunu = součást položky „Nové dodávky".
    if (fresh.has(m.engagement_id) && m.status === 'pripraveno') continue
    const t = Date.parse(m.updated_at)
    if (Number.isNaN(t) || t < win.since.getTime() || t >= win.until.getTime()) continue
    out.push({
      key: `milestone-${m.id}`,
      kind: 'milestone',
      at: m.updated_at,
      title: heading(m),
      detail: `Změněn, teď: ${statusLabel(m.status)}`,
      href: link(m),
      proof: `Milník č. ${m.id}, upraveno ${stamp(m.updated_at)}`,
      engagementId: m.engagement_id,
    })
  }
  return out.sort(byNewest)
}

// --- Dokumenty dodávek (nálezy denní kontroly SharePointu, 0094) -----------

export type DocumentFindingRow = {
  id: number
  kind: string
  detected_at: string
  resolved_at: string | null
  document_id: number
  title: string
  status: string
  engagement_id: number
  account_id: number | null
  account_name: string | null
  /** Číslo verze, kterou kontrola viděla (u „changed"), a schválené verze. */
  seen_version: string | null
  approved_version: string | null
}

/**
 * Nálezy denní kontroly dokumentů: schválený/odeslaný/přijatý dokument se od
 * schválení změnil, zmizel ze SharePointu nebo k němu kontrola nemá přístup.
 * Důkaz = číslo nálezu a čas kontroly. Nález se ukáže v okně, ve kterém vznikl,
 * i když už se mezitím sám zavřel (soubor je zpátky) — „už vyřešeno" je v detailu.
 * Bez obsahu souboru: jen název dokumentu, stav a čísla verzí.
 */
export function documentChanges(rows: readonly DocumentFindingRow[]): ChangeItem[] {
  const out: ChangeItem[] = []
  for (const r of rows) {
    if (r.kind !== 'changed' && r.kind !== 'missing' && r.kind !== 'no_access') continue
    const status = isDocumentStatus(r.status) ? r.status : 'draft'
    const sentence = findingSentence(r.kind, status, {
      approved: r.approved_version ? { versionLabel: r.approved_version } : null,
      seen: r.seen_version ? { versionLabel: r.seen_version } : null,
    })
    out.push({
      key: `document-${r.id}`,
      kind: 'document',
      at: r.detected_at,
      title: [r.account_name?.trim(), r.title.trim()].filter(Boolean).join(' · ') || `Dokument č. ${r.document_id}`,
      detail: r.resolved_at ? `${sentence} Už vyřešeno.` : sentence,
      href: r.account_id ? `/cockpit/clients/${r.account_id}/engagements/${r.engagement_id}/edit?zalozka=dokumenty` : '/cockpit/clients?stav=aktivni',
      proof: `Nález kontroly dokumentu č. ${r.id}, ${stamp(r.detected_at)}`,
      engagementId: r.engagement_id,
    })
  }
  return out.sort(byNewest)
}

// --- Faktury a platby -------------------------------------------------------

export type MoneyRow = {
  id: number
  kind: string
  status: string
  amount: number | string
  currency: string
  created_at: string
  account_name: string | null
}

export function moneyLabel(amount: number | string, currency: string): string {
  const n = Number(amount)
  if (!Number.isFinite(n)) return '—'
  if (currency === 'CZK') return formatCzk(n)
  const safe = /^[A-Z]{3}$/.test(currency) ? currency : 'EUR'
  return new Intl.NumberFormat('cs-CZ', { style: 'currency', currency: safe, maximumFractionDigits: 0 })
    .format(n).replace(/[  ]/g, ' ')
}

const MONEY_LABEL: Record<string, string> = {
  'invoiced:draft': 'Návrh podkladu k faktuře',
  'invoiced:confirmed': 'Vystavená faktura',
  'received:draft': 'Návrh platby',
  'received:confirmed': 'Přijatá platba',
}

export function moneyChanges(rows: readonly MoneyRow[]): ChangeItem[] {
  const out: ChangeItem[] = []
  for (const r of rows) {
    const label = MONEY_LABEL[`${r.kind}:${r.status}`]
    if (!label) continue // zrušené a jiné druhy (potenciál, nasmlouváno) sem nepatří
    out.push({
      key: `money-${r.id}`,
      kind: 'money',
      at: r.created_at,
      title: r.account_name?.trim() || 'Klient',
      detail: `${label} · ${moneyLabel(r.amount, r.currency)}`,
      href: '/cockpit/finance',
      proof: `Finanční záznam č. ${r.id}, založeno ${stamp(r.created_at)}`,
    })
  }
  return out.sort(byNewest)
}

// --- Sekce pro kartu --------------------------------------------------------

export type ChangeSection = {
  kind: ChangeKind
  label: string
  tone: ChangeTone
  /** Počet změn (e-maily se počítají po jednom, ne po klientech). */
  total: number
  items: ChangeItem[]
  /** Kolik položek se nevešlo do limitu. */
  hidden: number
}

/**
 * Sekce ve stálém pořadí (i prázdné, aby dlaždice s nulou byla vidět).
 * Obchodní druhy se bez can_see_sales vynechají — i kdyby je někdo předal.
 */
export function buildChangeSections(
  items: readonly ChangeItem[],
  opts: { canSeeSales: boolean; perSection?: number },
): ChangeSection[] {
  const cap = opts.perSection ?? 10
  return CHANGE_KINDS
    .filter((k) => opts.canSeeSales || !k.salesOnly)
    .map((k) => {
      const list = items.filter((i) => i.kind === k.kind).sort(byNewest)
      const total = list.reduce((n, i) => n + (i.count ?? 1), 0)
      return { kind: k.kind, label: k.label, tone: k.tone, total, items: list.slice(0, cap), hidden: Math.max(0, list.length - cap) }
    })
}

export function changesTotal(sections: readonly ChangeSection[]): number {
  return sections.reduce((n, s) => n + s.total, 0)
}

/** Nejnovější položky napříč sekcemi (pro krátký seznam na obrazovce Dnes). */
export function latestChanges(sections: readonly ChangeSection[], n: number): ChangeItem[] {
  return sections.flatMap((s) => s.items).sort(byNewest).slice(0, n)
}

export function changesSummary(total: number): string {
  if (total === 0) return 'Nic se nezměnilo'
  return `${total} ${plural(total, 'změna', 'změny', 'změn')}`
}
