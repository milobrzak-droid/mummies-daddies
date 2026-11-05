// Follow-up cadence (balík P4): připomínky neodpovězených nabídek.
//
// Čistá funkce planFollowUpSends rozhodne pro každý obchod, co se má dnes
// stát. Zapisuje domain/crm/followUpCadenceService.ts (běh nad vstříknutou
// DB), denní úlohu obstarává worker/followUpSend.ts přes cron
// /api/cron/follow-ups (za FOLLOWUP_CADENCE_ENABLED).
//
// ČASOVÁNÍ (pracovní dny s českými svátky, lib/businessDays.ts):
// - 1. připomínka: steps[0].afterBusinessDays po odeslání nabídky (kotva =
//   poslední deal_scope_version.sent_at, bez ní poslední odchozí e-mail
//   firmě/kontaktu podle mail_event),
// - n-tá připomínka: steps[n-1] po zařazení předchozí (víc pokusů než kroků
//   = opakuje se poslední krok),
// - po poslední připomínce se čeká ještě jednou poslední interval (aspoň
//   EXHAUST_MIN_CALENDAR_DAYS kalendářních dnů) a pak je cadence vyčerpaná.
//
// STOP PRAVIDLA (trvalá → řádek 'stopped'; přechodná → jen 'skip', nic se nepíše):
// - trvalé: příchozí zpráva od firmy/kontaktu po posledním odeslání, ruční
//   aktivita u obchodu po odeslání nabídky (sales_activity s autorem),
//   nesouhlas s oslovením (políčko, poznámka, odložená firma, nesouhlasí
//   všichni lidé firmy), akce už proběhla, obchod uzavřený nebo mimo fázi
//   (jen když už visí naplánovaný pokus),
// - přechodná: mimo okno odesílání nebo pracovní den, denní limit, ještě
//   není termín, chybí kontakt / e-mail / vlastník / data šablony, u obchodu
//   je otevřený případ follow-up hlídače (řeší ho člověk).
//
// Agent za připomínku NEZAPISUJE sales_activity (zapíše ji až potvrzení
// odeslání v P3 se source 'agent:follow_up' a bez autora), takže pravidlo
// ruční aktivity ani follow-up hlídač na vlastní připomínku agenta nereagují.

import { COMPANY } from '@/config'
import { renderFollowUpTemplate, type FollowUpCadenceConfig } from '@/core/followUpCadence'
import { addBusinessDays, isBusinessDay, isoWeekday } from '@/lib/businessDays'
import { normalizeDealStage } from '@/lib/dealStageLegacy'
import { addDaysToPragueDay, pragueDayOf, pragueToday } from '@/lib/pragueDate'
import { ESCALATE_AFTER_DAYS } from './followUp'
import { accountFullyOptedOut, outreachBlockReason } from './outreachContacts'
import { isOpenDeal } from './sales'

/** Jméno úlohy = klíč zámku v job_lock (0040). */
export const FOLLOW_UP_SEND_JOB = 'follow-up-send'
/** Aktér systémového zápisu (hlavička auditu servisního klíče). */
export const FOLLOW_UP_SEND_ACTOR = FOLLOW_UP_SEND_JOB
/** Řádek v connector_state — čerstvost a poslední chyba úlohy. */
export const FOLLOW_UP_SEND_CONNECTOR = 'follow_up_cadence'
/** sales_activity.source, kterou zapíše potvrzení odeslání v P3. */
export const FOLLOW_UP_ACTIVITY_SOURCE = 'agent:follow_up'

/** Ruční aktivita do hodiny po odeslání nabídky = zápis k samotnému odeslání, ne zásah. */
export const MANUAL_ACTIVITY_GRACE_MS = 60 * 60 * 1000
/**
 * Minimální odstup vyčerpání od posledního zařazení (kalendářní dny). Případ
 * po vyčerpání zakládá hlídač z next_step_due = dnes − ESCALATE_AFTER_DAYS a
 * mlčí, když je aktivita (potvrzení odeslání v P3, i o den později) v ten den
 * nebo po něm — odstup to vylučuje.
 */
export const EXHAUST_MIN_CALENDAR_DAYS = ESCALATE_AFTER_DAYS + 2

/** Přepínač úlohy (výchozí vypnuto): jen přesně 'true'. */
export function followUpCadenceEnabledFromEnv(env: Record<string, string | undefined>): boolean {
  return env.FOLLOWUP_CADENCE_ENABLED === 'true'
}

export function followUpSourceRef(dealId: number, attempt: number): string {
  return `followup:${dealId}:${attempt}`
}

// --- Tvary dat ----------------------------------------------------------------

export type CadenceContact = {
  id: number
  full_name: string | null
  email: string | null
  do_not_contact: boolean | null
  notes: string | null
}

export type CadenceAccount = { id: number; notes: string | null; snooze_until: string | null }

export type CadenceDeal = {
  id: number
  title: string | null
  stage: string
  pillar: string | null
  phase: string | null
  owner_id: string | null
  account_id: number | null
  primary_contact_id: number | null
  next_step_due: string | null
  contact: CadenceContact | null
  account: CadenceAccount | null
}

export type AttemptStatus = 'planned' | 'enqueued' | 'stopped' | 'exhausted'

export type CadenceAttempt = {
  deal_id: number
  attempt: number
  status: AttemptStatus
  planned_on: string
  enqueued_at: string | null
}

/** Výstup follow_up_facts (0105): časy, příznaky a počty, žádný text. */
export type CadenceFacts = {
  deal_id: number
  last_inbound_at: string | null
  last_outbound_at: string | null
  last_human_activity_at: string | null
  offer_sent_at: string | null
  contact_do_not_contact: boolean | null
  account_contacts: number
  account_opted_out: number
  event_date: string | null
}

export type StopReason =
  | 'customer_replied'
  | 'manual_activity'
  | 'opt_out'
  | 'account_snoozed'
  | 'event_passed'
  | 'deal_closed'
  | 'phase_changed'

export type SkipReason =
  | 'finished'
  | 'deal_closed'
  | 'phase_not_applicable'
  | 'no_offer_sent'
  | 'not_due'
  | 'waiting_exhaustion'
  | 'outside_window'
  | 'daily_limit'
  | 'no_contact'
  | 'no_email'
  | 'no_owner'
  | 'case_open'
  | 'template_data_missing'

export type CadenceAction =
  | {
      kind: 'send'
      deal_id: number
      attempt: number
      template: string
      /** true = řádek 'planned' už existuje (předchozí běh frontu nezastihl). */
      existing: boolean
      source_ref: string
      to: string
      mailbox_member_id: string
      subject: string
      text: string
      /** Den dalšího kroku (další připomínka nebo vyčerpání) → deal.next_step_due. */
      next_due: string
    }
  | { kind: 'stop'; deal_id: number; attempt: number; reason: StopReason; existing: boolean }
  | {
      kind: 'exhausted'
      deal_id: number
      /** maxAttempts + 1 — značka konce cadence. */
      attempt: number
      on_exhausted: FollowUpCadenceConfig['onExhausted']
      /** onExhausted 'case': nový termín, ze kterého hlídač hned založí případ. */
      escalate_due: string
    }
  | { kind: 'skip'; deal_id: number; reason: SkipReason }

export type CadencePlanInput = {
  deals: readonly CadenceDeal[]
  attempts: readonly CadenceAttempt[]
  facts: readonly CadenceFacts[]
  /** Obchody s aktivním případem follow-up hlídače. */
  activeCaseDealIds?: ReadonlySet<number>
  /** Kolik připomínek už dnes (pražský den) do fronty odešlo. */
  enqueuedToday: number
  now: Date
  cfg: FollowUpCadenceConfig
  /** Vyhrané fáze podle pilíře (COMPANY.wonPhases). */
  wonPhases?: Readonly<Record<string, readonly string[]>>
}

// --- Pomocníci ------------------------------------------------------------------

const ts = (s: string | null | undefined): number | null => {
  if (!s) return null
  const n = Date.parse(s)
  return Number.isNaN(n) ? null : n
}

const EMAIL_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]+$/

const HOUR_FMT = new Intl.DateTimeFormat('en-GB', { timeZone: COMPANY.timeZone, hour: '2-digit', hourCycle: 'h23' })

/** Je teď okno odesílání (pražský čas, ISO dny, [fromHour, toHour)) a pracovní den? */
export function inSendWindow(now: Date, window: FollowUpCadenceConfig['sendWindow']): boolean {
  const day = pragueDayOf(now)
  if (!isBusinessDay(day)) return false
  if (!window.days.includes(isoWeekday(day))) return false
  const hour = Number(HOUR_FMT.format(now))
  return hour >= window.fromHour && hour < window.toHour
}

/** Krok pro n-tou připomínku (1-based); víc pokusů než kroků = poslední krok. */
export function stepFor(cfg: FollowUpCadenceConfig, attempt: number) {
  return cfg.steps[Math.min(attempt, cfg.steps.length) - 1]
}

/** Den vyčerpání: poslední interval po posledním zařazení, aspoň EXHAUST_MIN_CALENDAR_DAYS. */
export function exhaustionDay(cfg: FollowUpCadenceConfig, lastEnqueuedDay: string): string {
  const byStep = addBusinessDays(lastEnqueuedDay, stepFor(cfg, cfg.maxAttempts).afterBusinessDays)
  const min = addDaysToPragueDay(lastEnqueuedDay, EXHAUST_MIN_CALENDAR_DAYS)
  return byStep > min ? byStep : min
}

// Oslovení jen jménem z bezpečných znaků (písmena, mezera, spojovník,
// apostrof, do 60 znaků); jinak nic — šablona se jménem pak neodejde.
const NAME_RE = /^[\p{L}][\p{L}' -]{0,59}$/u
export function safeFirstName(fullName: string | null | undefined): string | null {
  const first = (fullName ?? '').trim().split(/\s+/)[0] ?? ''
  return NAME_RE.test(first) ? first : null
}

/** Název akce do textu: jeden řádek, bez řídicích znaků, nejvýš 120 znaků. */
export function safeEventTitle(title: string | null | undefined): string | null {
  const t = (title ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim()
  return t ? t.slice(0, 120) : null
}

/** 2026-12-11 → „11. 12. 2026". */
export function czechDate(day: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day ?? '')
  return m ? `${Number(m[3])}. ${Number(m[2])}. ${m[1]}` : null
}

// --- Rozhodnutí -----------------------------------------------------------------

type Evaluated = { action: CadenceAction; dueDay: string | null }

function evaluate(
  deal: CadenceDeal,
  attempts: readonly CadenceAttempt[],
  facts: CadenceFacts | undefined,
  input: CadencePlanInput,
  today: string,
): Evaluated {
  const { cfg } = input
  const skip = (reason: SkipReason, dueDay: string | null = null): Evaluated =>
    ({ action: { kind: 'skip', deal_id: deal.id, reason }, dueDay })

  const own = [...attempts].sort((a, b) => a.attempt - b.attempt)
  if (own.some((a) => a.status === 'stopped' || a.status === 'exhausted')) return skip('finished')
  const enqueued = own.filter((a) => a.status === 'enqueued')
  const planned = own.find((a) => a.status === 'planned') ?? null
  const next = planned?.attempt ?? enqueued.length + 1
  const stop = (reason: StopReason): Evaluated =>
    ({ action: { kind: 'stop', deal_id: deal.id, attempt: next, reason, existing: planned !== null }, dueDay: null })

  // Fáze a uzavření obchodu. Bez naplánovaného pokusu se nic nepíše: obchod
  // mimo fázi do cadence prostě nepatří (vrátí-li se, cadence pokračuje).
  const stage = normalizeDealStage(deal.stage) ?? deal.stage
  const won = deal.pillar ? (input.wonPhases?.[deal.pillar] ?? []).includes(deal.phase ?? '') : false
  if (!isOpenDeal(stage) || won) return planned ? stop('deal_closed') : skip('deal_closed')
  if (!deal.phase || !cfg.appliesToPhases.includes(deal.phase)) {
    return planned ? stop('phase_changed') : skip('phase_not_applicable')
  }

  // Kotva = odeslaná nabídka. Bez ní není na co připomínat.
  const anchor = ts(facts?.offer_sent_at) ?? ts(facts?.last_outbound_at)
  if (anchor === null) return skip('no_offer_sent')
  const lastEnqueued = Math.max(...enqueued.map((a) => ts(a.enqueued_at) ?? 0), 0)
  const lastOut = Math.max(anchor, lastEnqueued)

  // Trvalá stop pravidla.
  const inbound = ts(facts?.last_inbound_at)
  if (inbound !== null && inbound > lastOut) return stop('customer_replied')
  const human = ts(facts?.last_human_activity_at)
  if (human !== null && human > anchor + MANUAL_ACTIVITY_GRACE_MS) return stop('manual_activity')
  const contactFlag = deal.contact?.do_not_contact === true || facts?.contact_do_not_contact === true
  if (deal.contact || deal.account) {
    const block = outreachBlockReason(
      { do_not_contact: contactFlag, notes: deal.contact?.notes ?? null, account: deal.account },
      today,
    )
    if (block === 'account_snoozed') return stop('account_snoozed')
    if (block) return stop('opt_out')
  } else if (contactFlag) {
    return stop('opt_out')
  }
  if (facts && accountFullyOptedOut({ opted_out: facts.account_opted_out, total: facts.account_contacts, account_note: false })) {
    return stop('opt_out')
  }
  if (facts?.event_date && facts.event_date <= today) return stop('event_passed')

  // Termín dalšího kroku.
  let dueDay: string
  const exhausted = !planned && enqueued.length >= cfg.maxAttempts
  if (planned) dueDay = planned.planned_on
  else if (exhausted) dueDay = exhaustionDay(cfg, pragueDayOf(new Date(lastEnqueued)))
  else {
    const base = enqueued.length === 0 ? pragueDayOf(new Date(anchor)) : pragueDayOf(new Date(lastEnqueued))
    dueDay = addBusinessDays(base, stepFor(cfg, next).afterBusinessDays)
  }
  if (dueDay > today) return skip(exhausted ? 'waiting_exhaustion' : 'not_due', dueDay)

  // Případ hlídače = follow-up už převzal člověk.
  if (input.activeCaseDealIds?.has(deal.id)) return skip('case_open', dueDay)

  if (exhausted) {
    return {
      action: {
        kind: 'exhausted',
        deal_id: deal.id,
        attempt: cfg.maxAttempts + 1,
        on_exhausted: cfg.onExhausted,
        escalate_due: addDaysToPragueDay(today, -ESCALATE_AFTER_DAYS),
      },
      dueDay,
    }
  }

  // Připomínka: adresát, schránka, text.
  if (!deal.contact) return skip('no_contact', dueDay)
  const email = (deal.contact.email ?? '').trim().toLowerCase()
  if (!EMAIL_RE.test(email)) return skip('no_email', dueDay)
  if (!deal.owner_id) return skip('no_owner', dueDay)
  const step = stepFor(cfg, next)
  const template = cfg.templates[step.template]
  if (!template) return skip('template_data_missing', dueDay)
  const rendered = renderFollowUpTemplate(template, {
    jmeno: safeFirstName(deal.contact.full_name),
    akce: safeEventTitle(deal.title),
    datum: czechDate(facts?.event_date),
  })
  if (!rendered.ok) return skip('template_data_missing', dueDay)

  const nextDue = next < cfg.maxAttempts
    ? addBusinessDays(today, stepFor(cfg, next + 1).afterBusinessDays)
    : exhaustionDay(cfg, today)
  return {
    action: {
      kind: 'send',
      deal_id: deal.id,
      attempt: next,
      template: step.template,
      existing: planned !== null,
      source_ref: followUpSourceRef(deal.id, next),
      to: email,
      mailbox_member_id: deal.owner_id,
      subject: rendered.subject,
      text: rendered.body,
      next_due: nextDue,
    },
    dueDay,
  }
}

/**
 * Co dnes udělat s cadence u každého obchodu. Čistá funkce: stejný vstup =
 * stejný plán. Okno odesílání a denní limit se týkají jen odeslání (stop
 * a vyčerpání se zapíšou kdykoli); limit dostanou nejdřív nejstarší termíny.
 */
export function planFollowUpSends(input: CadencePlanInput): CadenceAction[] {
  const today = pragueToday(input.now)
  const attemptsByDeal = new Map<number, CadenceAttempt[]>()
  for (const a of input.attempts) {
    const list = attemptsByDeal.get(a.deal_id) ?? []
    list.push(a)
    attemptsByDeal.set(a.deal_id, list)
  }
  const factsByDeal = new Map(input.facts.map((f) => [f.deal_id, f]))
  const window = inSendWindow(input.now, input.cfg.sendWindow)

  const evaluated = [...input.deals]
    .sort((a, b) => a.id - b.id)
    .map((d) => evaluate(d, attemptsByDeal.get(d.id) ?? [], factsByDeal.get(d.id), input, today))

  const sends = evaluated
    .filter((e) => e.action.kind === 'send')
    .sort((a, b) => (a.dueDay ?? '').localeCompare(b.dueDay ?? '') || a.action.deal_id - b.action.deal_id)
  let budget = Math.max(0, input.cfg.dailyLimit - input.enqueuedToday)
  const limited = new Map<number, SkipReason>()
  for (const e of sends) {
    if (!window) limited.set(e.action.deal_id, 'outside_window')
    else if (budget <= 0) limited.set(e.action.deal_id, 'daily_limit')
    else budget--
  }

  return evaluated.map(({ action }) => {
    const reason = action.kind === 'send' ? limited.get(action.deal_id) : undefined
    return reason ? { kind: 'skip', deal_id: action.deal_id, reason } : action
  })
}

/** Důvod prohry pro onExhausted 'lost': popisek z číselníku firmy (deal.lost_reason je text), jinak klíč. */
export function lostReasonText(key: string, reasons = COMPANY.lostReasons ?? []): string {
  return reasons.find((r) => r.key === key)?.label ?? key
}
