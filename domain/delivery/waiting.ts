// Hlídání čekání: který milník dodávky stojí, protože čeká na klienta.
// Čisté funkce bez I/O (čtení dat je v domain/delivery/queries/waiting.ts).
//
// Co je „čekání na klienta":
//   ceka_na_schvaleni — hotová věc je ODESLANÁ klientovi a klient ji zatím
//                       nepotvrdil („odesláno ≠ přijato", domain/delivery/milestone.ts).
//   ceka_na_vstup     — bez klientových podkladů nebo odpovědi nejde pokračovat.
// Ostatní stavy (připraveno, v práci, přijato, uzavřeno) na klienta nečekají.
//
// Co hlídáme (signály; žádný z nich není vymyšlené číslo, všechno jde z dat):
//   po termínu   — termín milníku (due_on) je před dneškem;
//   bez pohybu   — milník je ve stavu čekání aspoň WAITING_QUIET_DAYS dní.
// Kdy čekání začalo: čas posledního posunu stavu z auditu (milestone.status
// nebo engagement_milestone.updated se změnou stavu); nemáme-li ho, čas
// poslední úpravy řádku (updated_at). Zdroj se vždy dá dohledat na milníku.
//
// Co udělat: „Připomenout klientovi" založí ÚKOL s hotovým návrhem e-mailu
// v popisu (domain/delivery/actions/waiting.ts). Nic se neodesílá; návrh se
// dá otevřít v poště (mailto:) a odešle ho člověk sám po přečtení.

import { engagementKindLabel } from '@/lib/domain'
import { plainEmailAddress } from '@/lib/mailto'
import { daysBetweenPragueDays, pragueDayOf } from '@/lib/pragueDate'
import type { MilestoneStatus } from '@/domain/delivery/milestone'

export const WAITING_STATUSES = ['ceka_na_vstup', 'ceka_na_schvaleni'] as const satisfies readonly MilestoneStatus[]
export type WaitingStatus = (typeof WAITING_STATUSES)[number]

/** Od kolika dní čekání je milník „bez pohybu" a stojí za upozornění. */
export const WAITING_QUIET_DAYS = 5

/** Začátek názvu úkolu s připomínkou; podle něj se pozná, že už existuje. */
export const REMINDER_TITLE_PREFIX = 'Připomenout klientovi: '
const TITLE_MAX = 200

export function isWaitingStatus(s: unknown): s is WaitingStatus {
  return typeof s === 'string' && (WAITING_STATUSES as readonly string[]).includes(s)
}

/** Název úkolu s připomínkou; stejný milník = stejný název (idempotence). */
export function reminderTaskTitle(milestoneTitle: string): string {
  return `${REMINDER_TITLE_PREFIX}${milestoneTitle.trim()}`.slice(0, TITLE_MAX)
}

export type WaitingKind = 'approval' | 'input'
export type WaitingSignal = 'overdue' | 'quiet'

export const WAITING_KIND_LABEL: Record<WaitingKind, string> = {
  approval: 'Čeká na schválení klientem',
  input: 'Čeká na podklady od klienta',
}

export function waitingKindOf(status: WaitingStatus): WaitingKind {
  return status === 'ceka_na_schvaleni' ? 'approval' : 'input'
}

/** Řádek milníku ve stavu čekání i s dodávkou a klientem (tvar z dotazu). */
export type WaitingMilestoneRow = {
  id: number
  engagement_id: number
  title: string
  owner_id: string | null
  status: string
  due_on: string | null
  updated_at: string | null
  created_at: string | null
  engagement: {
    id: number
    account_id: number
    kind: string
    phase: string
    account_name: string | null
  } | null
}

export type ClientContact = { name: string | null; email: string | null }

export type WaitingItem = {
  key: string
  milestoneId: number
  engagementId: number
  accountId: number
  accountName: string
  /** „Workshop", „Pilot" … — druh dodávky česky. */
  deliveryLabel: string
  title: string
  status: WaitingStatus
  kind: WaitingKind
  ownerId: string | null
  /** Od kdy stav trvá (ISO). */
  since: string
  /** Kolik pražských dní už čekáme (0 = od dneška). */
  daysWaiting: number
  dueOn: string | null
  /** Dní po termínu; null = bez termínu nebo v termínu. */
  daysOverdue: number | null
  signals: WaitingSignal[]
  /** Věta, na co se čeká. */
  what: string
  /** Kde je milník k otevření (záložka Milníky dodávky). */
  href: string
  /** Úkol s připomínkou už je založený a otevřený. */
  reminderOpen: boolean
  contact: ClientContact | null
}

export type WaitingInput = {
  milestones: WaitingMilestoneRow[]
  /** Poslední posun stavu z auditu: id milníku → ISO čas. */
  moves: Map<number, string>
  /** Otevřené úkoly s připomínkou: id dodávky → množina názvů. */
  openReminders: Map<number, Set<string>>
  /** Kontakt klienta (sponzor) podle id dodávky. */
  contacts: Map<number, ClientContact>
  /** Pražský dnešek, YYYY-MM-DD. */
  today: string
}

function validDay(d: string | null | undefined): d is string {
  return !!d && /^\d{4}-\d{2}-\d{2}$/.test(d)
}

/** Věta „na co čekáme" včetně data, kdy jsme věc klientovi poslali. */
export function waitingWhat(kind: WaitingKind, sinceIso: string): string {
  const d = pragueDayOf(sinceIso)
  const short = `${Number(d.slice(8, 10))}. ${Number(d.slice(5, 7))}.`
  return kind === 'approval'
    ? `Odesláno klientovi ${short}, zatím není přijato.`
    : `Čekáme na podklady od klienta od ${short}`
}

function waitingSince(m: WaitingMilestoneRow, moves: Map<number, string>): string | null {
  const move = moves.get(m.id)
  if (move && !Number.isNaN(Date.parse(move))) return move
  for (const v of [m.updated_at, m.created_at]) if (v && !Number.isNaN(Date.parse(v))) return v
  return null
}

/**
 * Milníky, které čekají na klienta, seřazené podle naléhavosti: nejdřív po
 * termínu (nejdéle), pak bez pohybu (nejdéle), pak ostatní (nejdéle čekající).
 * Uzavřené dodávky se nehlídají.
 */
export function buildWaitingItems(input: WaitingInput): WaitingItem[] {
  const items: WaitingItem[] = []
  for (const m of input.milestones) {
    if (!isWaitingStatus(m.status)) continue
    const eng = m.engagement
    if (!eng || eng.phase === 'uzavreno') continue
    const since = waitingSince(m, input.moves)
    if (!since) continue

    const kind = waitingKindOf(m.status)
    const daysWaiting = Math.max(0, daysBetweenPragueDays(pragueDayOf(since), input.today))
    const overdueBy = validDay(m.due_on) && m.due_on < input.today ? daysBetweenPragueDays(m.due_on, input.today) : null
    const signals: WaitingSignal[] = []
    if (overdueBy !== null) signals.push('overdue')
    if (daysWaiting >= WAITING_QUIET_DAYS) signals.push('quiet')

    items.push({
      key: `m${m.id}`,
      milestoneId: m.id,
      engagementId: m.engagement_id,
      accountId: eng.account_id,
      accountName: eng.account_name?.trim() || 'Klient',
      deliveryLabel: engagementKindLabel(eng.kind),
      title: m.title,
      status: m.status,
      kind,
      ownerId: m.owner_id,
      since,
      daysWaiting,
      dueOn: m.due_on,
      daysOverdue: overdueBy,
      signals,
      what: waitingWhat(kind, since),
      href: `/cockpit/clients/${eng.account_id}/engagements/${m.engagement_id}/edit?zalozka=milniky`,
      reminderOpen: input.openReminders.get(m.engagement_id)?.has(reminderTaskTitle(m.title)) ?? false,
      contact: input.contacts.get(m.engagement_id) ?? null,
    })
  }
  const rank = (i: WaitingItem) => (i.signals.includes('overdue') ? 2 : i.signals.includes('quiet') ? 1 : 0)
  return items.sort((a, b) =>
    rank(b) - rank(a)
    || (b.daysOverdue ?? 0) - (a.daysOverdue ?? 0)
    || b.daysWaiting - a.daysWaiting
    || a.milestoneId - b.milestoneId)
}

// --- Kdy čekání začalo: z auditu --------------------------------------------

export type MilestoneAuditEvent = {
  entity_id: number
  action: string
  occurred_at: string
  after: unknown
}

/** Akce, které posunují stav milníku (po 0064 řádková změna, dřív appkové volání). */
export const MILESTONE_MOVE_ACTIONS = [
  'milestone.status',
  'milestone.accepted',
  'engagement_milestone.updated',
  'engagement_milestone.created',
] as const

function changedStatus(e: MilestoneAuditEvent): boolean {
  if (e.action === 'milestone.status' || e.action === 'milestone.accepted' || e.action === 'engagement_milestone.created') return true
  if (e.action !== 'engagement_milestone.updated') return false
  const after = e.after as { _columns?: unknown } | null
  return Array.isArray(after?._columns) && (after._columns as unknown[]).includes('status')
}

/** Poslední posun stavu každého milníku (id → ISO čas). */
export function lastStatusMoves(events: readonly MilestoneAuditEvent[]): Map<number, string> {
  const out = new Map<number, string>()
  for (const e of events) {
    if (!changedStatus(e)) continue
    const t = Date.parse(e.occurred_at)
    if (Number.isNaN(t)) continue
    const cur = out.get(e.entity_id)
    if (!cur || t > Date.parse(cur)) out.set(e.entity_id, e.occurred_at)
  }
  return out
}

// --- Texty pro kartu --------------------------------------------------------

const daysWord = (n: number) => (n === 1 ? 'den' : n >= 2 && n <= 4 ? 'dny' : 'dní')

/** „Čeká už 8 dní", „Čeká od dneška". */
export function waitingAgeLabel(days: number): string {
  if (days <= 0) return 'Čeká od dneška'
  return `Čeká už ${days} ${daysWord(days)}`
}

/** „Po termínu o 3 dny". */
export function overdueLabel(days: number): string {
  return `Po termínu o ${days} ${daysWord(days)}`
}

export function waitingSummary(items: readonly WaitingItem[]): string {
  const n = items.length
  if (n === 0) return 'Nic nečeká na klienta'
  const late = items.filter((i) => i.signals.includes('overdue')).length
  const quiet = items.filter((i) => !i.signals.includes('overdue') && i.signals.includes('quiet')).length
  const base = `${n} ${n === 1 ? 'věc čeká' : n >= 2 && n <= 4 ? 'věci čekají' : 'věcí čeká'} na klienta`
  const parts: string[] = []
  if (late) parts.push(`${late} po termínu`)
  if (quiet) parts.push(`${quiet} bez pohybu`)
  return parts.length ? `${base} · ${parts.join(', ')}` : base
}

// --- Návrh připomínky (nic se neodesílá) ------------------------------------

const MONTH_GENITIVE = ['ledna', 'února', 'března', 'dubna', 'května', 'června', 'července', 'srpna', 'září', 'října', 'listopadu', 'prosince']

export type ReminderDraft = { subject: string; body: string }

/**
 * Návrh e-mailu klientovi. Bez podpisu (přidá poštovní klient) a bez oslovení
 * jménem: české oslovení (5. pád) se nedá spolehlivě skloňovat.
 */
export function reminderDraft(item: Pick<WaitingItem, 'title' | 'kind' | 'since'>): ReminderDraft {
  const d = pragueDayOf(item.since)
  const sent = `${Number(d.slice(8, 10))}. ${MONTH_GENITIVE[Number(d.slice(5, 7)) - 1]}`
  const greet = 'Dobrý den,'
  const subject = `Připomenutí: ${item.title}`
  const body = item.kind === 'approval'
    ? `${greet}\n\nnavazuji na „${item.title}“, které jsme Vám poslali ${sent}. Zatím u nás není potvrzené.\n\nMohli byste se na to prosím podívat a dát nám vědět, jestli je to v pořádku, nebo co ještě upravit? Jakmile to potvrdíte, můžeme pokračovat dál.\n\nDěkuji.`
    : `${greet}\n\npro další postup u „${item.title}“ potřebujeme od Vás podklady. Čekáme na ně od ${sent}.\n\nMohli byste je prosím poslat, případně dát vědět, kdy je můžeme čekat? Bez nich nemůžeme pokračovat.\n\nDěkuji.`
  return { subject, body }
}

/** Text do popisu úkolu: návrh + upozornění, že se nic samo neodešle. */
export function reminderTaskDescription(draft: ReminderDraft, item: Pick<WaitingItem, 'what' | 'accountName'>): string {
  return [
    `${item.accountName}: ${item.what}`,
    '',
    'Návrh e-mailu (nic se neodesílá automaticky; před odesláním ho přečti a uprav):',
    '',
    `Předmět: ${draft.subject}`,
    '',
    draft.body,
  ].join('\n')
}

const MAILTO_BODY_MAX = 1500

/** mailto: odkaz s předvyplněným návrhem; otevře nový e-mail v poště, sám nic neposílá. */
export function reminderMailto(draft: ReminderDraft, to: string | null | undefined): string {
  // Jen prostá adresa: `a@b.cz?bcc=…` by přenesla parametry do mailto (N9).
  const addr = plainEmailAddress(to) ?? ''
  const q = `subject=${encodeURIComponent(draft.subject)}&body=${encodeURIComponent(draft.body.slice(0, MAILTO_BODY_MAX))}`
  return `mailto:${addr}?${q}`
}
