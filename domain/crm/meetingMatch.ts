// Rozhodnutí, ke komu schůzka patří. Čistá funkce, protože právě tady se
// dá nejsnáz udělat tichá chyba: naivní „první shoda vyhrává" připsalo
// panel FM Summitu klientovi CENTR GROUP a jednání o NUTRENDu partnerovi
// BETA TRADE, protože na obou hovorech byl někdo známý.
//
// Pravidlo: schůzku přiřadíme jen tehdy, když je na ní právě jedna známá
// firma a žádná neznámá. Jinak jde k ručnímu rozhodnutí — radši prázdno
// než špatná vazba, na kterou se pak někdo spolehne.
import { COMPANY } from '@/config'

export type ContactRef = {
  email: string
  account_id: number | null
  partner_id: number | null
  id: number
}

export type MatchTarget = {
  account_id: number | null
  partner_id: number | null
  contact_id: number | null
}

export type MatchResult =
  | { status: 'matched'; target: MatchTarget }
  | { status: 'ambiguous'; known: string[]; unknown: string[] }
  | { status: 'unknown'; domains: string[] }
  | { status: 'internal' }

// Freemail nenese informaci o firmě — gmail.com neznamená „firma Gmail".
// Takové adresy se proto párují na konkrétní e-mail, ne na doménu.
export const FREEMAIL: ReadonlySet<string> = new Set([
  'gmail.com', 'protonmail.com', 'outlook.com', 'seznam.cz',
  'icloud.com', 'email.cz', 'centrum.cz', 'volny.cz', 'hotmail.com',
])

// Exportováno — sdílené pravidlo „e-mail → doména", používá ho i
// domain/crm/mailMatch.ts.
export function domainOf(email: string): string | null {
  const at = email.lastIndexOf('@')
  return at === -1 ? null : email.slice(at + 1).toLowerCase()
}

export function matchMeeting(
  participants: string[],
  contacts: ContactRef[],
  ourDomain: string,
  /** Ruční doplnění domén, kde firmu známe, ale konkrétní člověk ještě není kontakt. */
  domainMap: Record<string, MatchTarget> = {},
): MatchResult {
  const byEmail = new Map(contacts.map((c) => [c.email.toLowerCase(), c]))
  const guests = participants
    .map((p) => p.toLowerCase().trim())
    .filter((p) => p && domainOf(p) !== ourDomain.toLowerCase())

  if (guests.length === 0) return { status: 'internal' }

  const resolved = new Map<string, MatchTarget>()
  const corporate = [...new Set(guests.map(domainOf).filter((d): d is string => !!d && !FREEMAIL.has(d)))]

  for (const d of corporate) {
    const viaContact = guests.filter((g) => domainOf(g) === d).map((g) => byEmail.get(g)).find(Boolean)
    if (viaContact) {
      resolved.set(d, { account_id: viaContact.account_id, partner_id: viaContact.partner_id, contact_id: viaContact.id })
    } else if (domainMap[d]) {
      resolved.set(d, domainMap[d])
    }
  }

  // Freemail se páruje na přesnou adresu, ne na doménu.
  for (const g of guests) {
    const d = domainOf(g)
    if (!d || !FREEMAIL.has(d)) continue
    const c = byEmail.get(g)
    if (c) resolved.set(g, { account_id: c.account_id, partner_id: c.partner_id, contact_id: c.id })
  }

  const unknown = corporate.filter((d) => !resolved.has(d))
  if (resolved.size === 0) return { status: 'unknown', domains: unknown }
  if (unknown.length > 0) {
    return { status: 'ambiguous', known: [...resolved.keys()], unknown }
  }
  if (resolved.size === 1) return { status: 'matched', target: [...resolved.values()][0] }

  // Klient a partner na jednom hovoru není nejednoznačnost, ale běžný způsob,
  // jak firma prodává — BETA TRADE nebo TAUPARTNER přivedou klienta a jsou u toho.
  // Schůzka je pak o tom klientovi, partner je kanál. Víc klientů naráz už
  // rozhodnout neumíme.
  const accounts = [...resolved.values()].filter((t) => t.account_id != null)
  if (accounts.length === 1) return { status: 'matched', target: accounts[0] }

  return { status: 'ambiguous', known: [...resolved.keys()], unknown }
}

// ---------------------------------------------------------------------------
// Párování proběhlé schůzky na už naplánovanou aktivitu.
//
// Volá ho domain/crm/plannedMeetingPairing.ts pro oba vstupy zápisů: příjem
// z Wispr Flow (meetingIntakeService.ts) i skill (MCP create_activity / REST,
// apiWrite.ts). (Automatický import z Fireflies, pro který to vzniklo, je od
// 2026-09-28 zrušený.)
//
// Schůzku dnes umíme naplánovat z Cockpitu (domain/crm/actions/planMeeting.ts) — vznikne
// řádek `sales_activity` se `source: 'cockpit'` a `outcome: 'planned'`. Když
// pak stejná schůzka doopravdy proběhne a přijde k ní zápis, bez
// párování by na timeline klienta ležela dvakrát: jednou jako plán, jednou
// jako zápis.
//
// Okno: stejný kalendářní den v Europe/Prague a nejvýš PLANNED_MATCH_MAX_DIFF_HOURS hodin
// rozdílu. Proč ne těsná shoda na minuty: schůzky se běžně posouvají o hodinu
// nebo dvě, začnou dřív, protáhnou se — záznam nese skutečný začátek
// hovoru, plán drží ten domluvený. Naopak přes půlnoc nepárujeme vůbec:
// „přesunuto na jiný den" je v praxi jiná schůzka a přepsat kvůli tomu plán
// by zamlčelo, že ten původní termín nikdo neodbavil.
//
// Při remíze (dvě naplánované schůzky stejně daleko) raději nespárujeme nic
// a zápis založí nový řádek. Platí tu stejné pravidlo jako výš u přiřazení
// firmy: špatná vazba je horší než žádná — duplicitu člověk uvidí a smaže,
// tiše přepsaný cizí plán ne.

/** Naplánovaná aktivita, na kterou se importovaná schůzka může navázat. */
export type PlannedActivity = {
  id: number
  account_id: number | null
  partner_id: number | null
  /** ISO timestamp plánovaného začátku (sloupec `occurred_at`). */
  occurred_at: string
  outcome: string | null
}

/** Tolerance párování zápisu na naplánovanou schůzku (a zároveň týž pražský den). */
export const PLANNED_MATCH_MAX_DIFF_HOURS = 12
const MAX_DIFF_MS = PLANNED_MATCH_MAX_DIFF_HOURS * 3_600_000

const PRAGUE_DAY = new Intl.DateTimeFormat('en-CA', {
  timeZone: COMPANY.timeZone,
  year: 'numeric', month: '2-digit', day: '2-digit',
})

/** Kalendářní den v české časové zóně — v UTC by schůzka v 01:00 spadla na jiný den. */
function pragueDay(d: Date): string {
  return PRAGUE_DAY.format(d)
}

function sameEntity(target: MatchTarget, planned: PlannedActivity): boolean {
  // Klient má přednost: když schůzka patří klientovi, musí sedět klient.
  if (target.account_id != null) return planned.account_id === target.account_id
  if (target.partner_id != null) return planned.account_id == null && planned.partner_id === target.partner_id
  return false
}

/**
 * Najde naplánovanou aktivitu, kterou má importovaná schůzka jen doplnit.
 * Vrací `null`, když jistou shodu nemáme — volající pak založí nový řádek.
 */
export function matchPlannedMeeting(
  /** Kdy schůzka podle zápisu proběhla (ISO). */
  occurredAt: string,
  /** Komu byla schůzka přiřazena (výstup `matchMeeting`). */
  target: MatchTarget,
  planned: PlannedActivity[],
): PlannedActivity | null {
  const actual = new Date(occurredAt)
  if (Number.isNaN(actual.getTime())) return null
  const day = pragueDay(actual)

  const candidates: { row: PlannedActivity; diff: number }[] = []
  for (const p of planned) {
    if (p.outcome !== 'planned') continue
    if (!sameEntity(target, p)) continue
    const at = new Date(p.occurred_at)
    if (Number.isNaN(at.getTime())) continue
    const diff = Math.abs(at.getTime() - actual.getTime())
    if (diff > MAX_DIFF_MS) continue
    if (pragueDay(at) !== day) continue
    candidates.push({ row: p, diff })
  }

  if (candidates.length === 0) return null
  candidates.sort((a, b) => a.diff - b.diff)
  if (candidates.length > 1 && candidates[0].diff === candidates[1].diff) return null
  return candidates[0].row
}
