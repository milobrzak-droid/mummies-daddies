// Čisté pomocné funkce obrazovky „Dnes“ a záložky „Týden“ (bez I/O, testovatelné).
// Stránky data jen natáhnou; tady se z nich skládají texty, počty a stavy zdrojů.

import { isStale, type ConnectorState } from '@/core/connectorState'
import type { MailWebhookHealth } from '@/domain/crm/mailWebhook'
import type { SalesDealLike, SalesFocusItem } from '@/domain/crm/sales'
import { isOpenDeal } from '@/domain/crm/sales'
import { DEAL_STAGES } from '@/lib/domain'
import { normalizeDealStage } from '@/lib/dealStageLegacy'
import { formatDate } from '@/lib/format'
import { COMPANY } from '@/config'
import { addDaysToPragueDay, daysBetweenPragueDays, pragueToday, pragueDayOf } from '@/lib/pragueDate'

const num = (v: unknown) => Number(v) || 0

// ── datum a pozdrav ────────────────────────────────────────────────────────

/** Číslo týdne podle ISO 8601 pro den ve tvaru YYYY-MM-DD. */
export function isoWeek(day: string): number {
  const d = new Date(Date.UTC(+day.slice(0, 4), +day.slice(5, 7) - 1, +day.slice(8, 10)))
  const dow = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - dow) // čtvrtek téhož týdne
  const yearStart = Date.UTC(d.getUTCFullYear(), 0, 1)
  return Math.ceil(((d.getTime() - yearStart) / 86_400_000 + 1) / 7)
}

const weekdayFmt = new Intl.DateTimeFormat('cs-CZ', { timeZone: COMPANY.timeZone, weekday: 'long' })

/** „ÚTERÝ 29. 9. 2026 · TÝDEN 40“ — pražské datum. */
export function todayEyebrow(now: Date = new Date()): string {
  const day = pragueToday(now)
  const weekday = weekdayFmt.format(now).toUpperCase()
  return `${weekday} ${+day.slice(8, 10)}. ${+day.slice(5, 7)}. ${day.slice(0, 4)} · TÝDEN ${isoWeek(day)}`
}

const hourFmt = new Intl.DateTimeFormat('en-GB', { timeZone: COMPANY.timeZone, hour: '2-digit', hourCycle: 'h23' })

/** Pozdrav podle pražské hodiny. Bez jména: české oslovení (5. pád) se nedá spolehlivě skloňovat. */
export function greeting(now: Date = new Date()): string {
  const hour = Number(hourFmt.format(now))
  if (hour >= 5 && hour < 10) return 'Dobré ráno'
  if (hour >= 10 && hour < 18) return 'Dobrý den'
  return 'Dobrý večer'
}

const timeFmt = new Intl.DateTimeFormat('cs-CZ', { timeZone: COMPANY.timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })

/** Pražský čas „09:30“ z ISO okamžiku; neplatný vstup → „—“. */
export function clockTime(iso: string | null | undefined): string {
  if (!iso) return '—'
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '—' : timeFmt.format(d)
}

/** „před 1 dnem“, „před 4 dny“; 0 → „dnes“. */
export function daysAgoLabel(days: number): string {
  if (days <= 0) return 'dnes'
  return days === 1 ? 'před 1 dnem' : `před ${days} dny`
}

/** Počet dnů po termínu (kladný = po termínu) vůči pražskému dnešku. */
export function daysOverdue(due: string, today: string): number {
  return daysBetweenPragueDays(due, today)
}

/**
 * Kam posunout termín po termínu jedním klikem: zítra a příští pondělí
 * (v neděli, kdy je pondělí zítra, o týden dál). Dny YYYY-MM-DD.
 */
export function postponeTargets(today: string): { tomorrow: string; nextWeek: string } {
  const tomorrow = addDaysToPragueDay(today, 1)
  const dow = new Date(`${today}T12:00:00Z`).getUTCDay() || 7 // 1 = pondělí … 7 = neděle
  let nextWeek = addDaysToPragueDay(today, 8 - dow)
  if (nextWeek === tomorrow) nextWeek = addDaysToPragueDay(nextWeek, 7)
  return { tomorrow, nextWeek }
}

/** Hezčí den ve zdroji stavu: dnes / včera / datum. */
export function dayLabel(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return 'nikdy'
  const diff = daysBetweenPragueDays(pragueDayOf(iso), pragueToday(now))
  if (diff === 0) return `dnes ${clockTime(iso)}`
  if (diff === 1) return `včera ${clockTime(iso)}`
  return formatDate(iso)
}

// ── obchody: fáze, dlaždice ────────────────────────────────────────────────

/** Datová barva fáze (DEAL_STAGES.tone, tokeny --d-*); stejná v prstenci, legendě i pruhu. */
export const STAGE_COLOR: Record<string, string> = Object.fromEntries(DEAL_STAGES.map((s) => [s.key, s.tone]))

export type StageSlice = { key: string; label: string; color: string; count: number; value: number }

/** Otevřené obchody po fázích, všechny otevřené fáze (i prázdné) v pořadí postupu. */
export function openStageSlices(deals: Pick<SalesDealLike, 'stage' | 'amount_one_time'>[]): StageSlice[] {
  const open = deals.filter((d) => isOpenDeal(d.stage))
  return DEAL_STAGES.filter((s) => s.open).map((s) => {
    const inStage = open.filter((d) => normalizeDealStage(d.stage) === s.key)
    return {
      key: s.key,
      label: s.label,
      color: STAGE_COLOR[s.key] ?? 'var(--d-neutral)',
      count: inStage.length,
      value: inStage.reduce((sum, d) => sum + num(d.amount_one_time), 0),
    }
  })
}

/** Rozdělení úkolů obchodníka: „Co dnes udělat“ vs. „Po termínu“ (ty mají vlastní seznam). */
export function splitFocus(items: SalesFocusItem[]): { todo: SalesFocusItem[]; overdue: SalesFocusItem[] } {
  return {
    todo: items.filter((i) => i.reason !== 'overdue'),
    overdue: items.filter((i) => i.reason === 'overdue'),
  }
}

// ── stav zdrojů dat ────────────────────────────────────────────────────────

// Prahy kopírují digest (domain/crm/digest.ts) a Nastavení, ať Cockpit o stejném
// zdroji nehlásí na dvou místech dvě různé věci.
const MAIL_STALE_HOURS = 36
const CALENDAR_STALE_HOURS = 24 * 7
const NOTES_STALE_HOURS = 24 * 7

export type SourceTone = 'done' | 'wait' | 'fail' | 'info'
export type SourceRow = { key: string; label: string; via: string; tone: SourceTone; status: string; detail: string }

export type SourcesInput = {
  mail: { syncEnabled: boolean; inbox: ConnectorState | null; sent: ConnectorState | null; webhook: MailWebhookHealth }
  calendar: ConnectorState | null
  lastMeetingNoteAt: string | null
  now?: Date
}

const hasError = (s: ConnectorState | null) => (s?.consecutive_errors ?? 0) > 0

function mailRow(key: string, label: string, state: ConnectorState | null, enabled: boolean, now: Date): SourceRow {
  const via = 'Outlook'
  if (!enabled) return { key, label, via, tone: 'info', status: 'Vypnuto', detail: 'synchronizace pošty je vypnutá' }
  if (hasError(state)) return { key, label, via, tone: 'fail', status: 'Chyba', detail: `poslední úspěch ${dayLabel(state?.last_success_at, now)}` }
  if (isStale(state, MAIL_STALE_HOURS, now.getTime())) {
    return { key, label, via, tone: 'wait', status: state?.last_success_at ? 'Zastaralé' : 'Zatím nic', detail: `poslední ${dayLabel(state?.last_success_at, now)}` }
  }
  return { key, label, via, tone: 'done', status: 'Synchronizuje se', detail: dayLabel(state?.last_success_at, now) }
}

/** Řádky „Stav zdrojů“: pošta (příjem, odeslání), kalendář, zápisy schůzek. */
export function buildTodaySources({ mail, calendar, lastMeetingNoteAt, now = new Date() }: SourcesInput): SourceRow[] {
  const rows: SourceRow[] = [
    mailRow('inbox', 'Doručená pošta', mail.inbox, mail.syncEnabled, now),
    mailRow('sent', 'Odeslaná pošta', mail.sent, mail.syncEnabled, now),
  ]
  if (!calendar) {
    rows.push({ key: 'calendar', label: 'Kalendář a úkoly', via: 'Outlook', tone: 'wait', status: 'Zatím nic', detail: 'ještě nikdy nebylo synchronizováno' })
  } else if (hasError(calendar)) {
    rows.push({ key: 'calendar', label: 'Kalendář a úkoly', via: 'Outlook', tone: 'fail', status: 'Chyba', detail: `poslední úspěch ${dayLabel(calendar.last_success_at, now)}` })
  } else {
    // Kalendář se synchronizuje na kliknutí: týden bez použití není porucha.
    const stale = isStale(calendar, CALENDAR_STALE_HOURS, now.getTime())
    rows.push({ key: 'calendar', label: 'Kalendář a úkoly', via: 'Outlook', tone: stale ? 'wait' : 'done', status: stale ? 'Zastaralé' : 'Synchronizuje se', detail: dayLabel(calendar.last_success_at, now) })
  }

  if (!lastMeetingNoteAt) {
    rows.push({ key: 'notes', label: 'Zápisy schůzek', via: 'Wispr Flow', tone: 'wait', status: 'Zatím nic', detail: 'zatím žádné zápisy' })
  } else {
    const ageH = (now.getTime() - new Date(lastMeetingNoteAt).getTime()) / 3_600_000
    const stale = Number.isNaN(ageH) || ageH > NOTES_STALE_HOURS
    rows.push({ key: 'notes', label: 'Zápisy schůzek', via: 'Wispr Flow', tone: stale ? 'wait' : 'done', status: stale ? 'Dávno bez zápisu' : 'Přicházejí', detail: `poslední ${dayLabel(lastMeetingNoteAt, now)}` })
  }
  return rows
}

/** Věta o okamžitém upozornění na poštu (webhook), nebo null, když je vypnuté. */
export function webhookNote(webhook: MailWebhookHealth): { text: string; problem: boolean } | null {
  if (!webhook.enabled) return null
  if (webhook.broken) return { text: `Okamžité upozornění na poštu nefunguje${webhook.problems[0] ? `: ${webhook.problems[0]}` : ''}`, problem: true }
  if (!webhook.expiresAt) return null
  const d = new Date(webhook.expiresAt)
  if (Number.isNaN(d.getTime())) return null
  return { text: `Okamžité upozornění na poštu platí do ${+pragueDayOf(d).slice(8, 10)}. ${+pragueDayOf(d).slice(5, 7)}.`, problem: false }
}

/** Kolik zdrojů potřebuje pozornost (chyba nebo zastaralé). */
export function sourcesNeedingAttention(rows: SourceRow[]): number {
  return rows.filter((r) => r.tone === 'fail' || r.tone === 'wait').length
}

/**
 * Zdroje s opravdovým problémem (chyba nebo zastaralá data). „Zatím nic“
 * (zdroj ještě nikdy nic nedodal, např. nenapojený) poruchou není: kvůli
 * němu se sbalený Stav zdrojů dat na Dnes sám nerozbaluje.
 */
export function sourcesWithProblem(rows: SourceRow[]): SourceRow[] {
  return rows.filter((r) => r.tone === 'fail' || (r.tone === 'wait' && r.status !== 'Zatím nic'))
}

/**
 * Tón stavové pilulky pro řádek ze „Stavu zdrojů“ týdenního přehledu
 * (digest.sources.lines je text: „… — zastaralé“, „… — chyba: …“).
 */
export function digestSourceTone(line: string): SourceTone {
  if (/ — chyba|nefunguje/i.test(line)) return 'fail'
  if (/ — zastaralé/i.test(line)) return 'wait'
  if (/vypnuto/i.test(line)) return 'info'
  return 'done'
}

export const SOURCE_TONE_LABEL: Record<SourceTone, string> = { done: 'V pořádku', wait: 'Pozor', fail: 'Chyba', info: 'Vypnuto' }

/** Částka pro velké číslo: hodnota a jednotka zvlášť („2,67“ + „mil. Kč“). */
export function moneyParts(v: number): { value: string; unit: string } {
  const n = Number.isFinite(v) ? v : 0
  const abs = Math.abs(n)
  const spaces = (t: string) => t.replace(/[\u00a0\u202f]/g, ' ')
  if (Math.round(abs / 1000) >= 1000) {
    const mil = abs / 1_000_000
    const decimals = Number(mil.toFixed(2)) >= 10 ? 0 : 2
    return { value: (n / 1_000_000).toFixed(decimals).replace('.', ','), unit: 'mil. Kč' }
  }
  if (abs >= 100_000) return { value: spaces(Math.round(n / 1000).toLocaleString('cs-CZ')), unit: 'tis. Kč' }
  return { value: spaces(Math.round(n).toLocaleString('cs-CZ')), unit: 'Kč' }
}

/** České skloňování: 1 obchod, 2–4 obchody, 5+ obchodů. */
export function plural(n: number, one: string, few: string, many: string): string {
  if (n === 1) return one
  return n >= 2 && n <= 4 ? few : many
}

/** Poslední `count` kalendářních měsíců (YYYY-MM) končící měsícem dne `today`. */
export function lastMonths(today: string, count: number): string[] {
  let y = +today.slice(0, 4)
  let m = +today.slice(5, 7)
  const out: string[] = []
  for (let i = 0; i < count; i++) {
    out.unshift(`${y}-${String(m).padStart(2, '0')}`)
    m -= 1
    if (m === 0) { m = 12; y -= 1 }
  }
  return out
}

/** Klíč měsíce YYYY-MM → „Zář“ (zkratka pro osu grafu). */
const MONTH_SHORT = ['Led', 'Úno', 'Bře', 'Dub', 'Kvě', 'Čvn', 'Čvc', 'Srp', 'Zář', 'Říj', 'Lis', 'Pro']
export function monthShort(key: string): string {
  return MONTH_SHORT[Number(key.slice(5, 7)) - 1] ?? key
}
