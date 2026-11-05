// Kontakty k oslovení pro API a MCP (konektor Cockpit v Claude Cowork).
// Čisté funkce bez I/O; čtení dat je v domain/crm/queries/apiOutreach.ts.
//
// DATOVÁ MINIMALIZACE. Ven jde jen to, co je k oslovení potřeba: jméno,
// pozice, e-mail, telefon, firma (id a název) a kdy jsme s člověkem byli
// naposledy v kontaktu. Poznámky, příznak champion, datum založení ani
// kontakty u partnerů ne.
//
// NESOUHLAS S OSLOVENÍM. Výmaz podle GDPR je smazání řádku
// (domain/crm/actions/contacts.ts), takže vymazaný člověk se sem nedostane.
// Kontakt se oslovit nesmí, když platí kterékoli z tohoto:
//   1. contact.do_not_contact (0087): políčko „Nesouhlasí s oslovením"
//      u kontaktu. Skutečný příznak; kdo a kdy ho zapsal, drží databáze.
//   2. account.snooze_until (0030): „vyřazení z připomínek: firma, která
//      řekla ne, nebo se řeší jinde" (Oslovování → Odložit). Dokud platí
//      (pražský den), kontakty firmy se nevrací.
//   3. target_list_item.status 'vyrazeno' (0048): firma vyřazená ze seznamu
//      se přes seznam nevrací (filtr stavu ji vůbec nenabízí).
//   4. Poznámka u kontaktu nebo u firmy s výslovným nesouhlasem
//      („nekontaktovat", „odhlásil se z odběru", „GDPR námitka"…) — DRUHÁ
//      POJISTKA za políčkem: nesouhlas zapsaný jen do poznámky (starší data,
//      nebo někdo zapomněl zaškrtnout) se pořád respektuje. Poznámky ven
//      nejdou, takže bez téhle pojistky by agent nesouhlas neviděl. Vzory
//      jsou úzké a radši kontakt schovají navíc, než aby se oslovil někdo,
//      kdo nechce.
// Vynechaný kontakt se nevrací vůbec (ani jméno). Výsledek nese jen počty
// podle důvodu, aby agent věděl, že nějaký kontakt chybí a proč.
//
// Fronta Oslovování a seznamy k oslovení v aplikaci pracují s firmami:
// summarizeAccountOptOut říká, kolik lidí u firmy nesouhlasí, a firma, u
// které nesouhlasí všichni (nebo to říká poznámka firmy), se k oslovení
// nenabízí vůbec (applyOutreachOptOut).
import type { TargetStatus } from '@/domain/crm/targetLists'

export const CONTACTS_PAGE_DEFAULT = 50
export const CONTACTS_PAGE_MAX = 200
export const SEARCH_MIN_LENGTH = 2
export const SEARCH_MAX_LENGTH = 100

/** Stavy položky seznamu, přes které se kontakty k oslovení vrací. Vyřazená firma ne. */
export const OUTREACH_TARGET_STATUSES = ['navrzeno', 'osloveno', 'odpovedel'] as const satisfies readonly TargetStatus[]
export type OutreachTargetStatus = (typeof OUTREACH_TARGET_STATUSES)[number]

export type OutreachBlockReason = 'contact_opt_out' | 'account_snoozed' | 'note_opt_out'

export const OUTREACH_BLOCK_LABEL: Record<OutreachBlockReason, string> = {
  contact_opt_out: 'kontakt nesouhlasí s oslovením (políčko u kontaktu)',
  account_snoozed: 'oslovení firmy je odložené (firma odmítla, řeší se jinde, nebo ozvat se později)',
  note_opt_out: 'poznámka u kontaktu nebo u firmy uvádí nesouhlas s oslovením',
}

/** Štítek v aplikaci u kontaktu a u firmy (seznamy k oslovení, Oslovování). */
export const DO_NOT_CONTACT_LABEL = 'Nesouhlasí s oslovením'

// ---------------------------------------------------------------------------
// Nesouhlas v poznámce

/** Text pro porovnání: bez diakritiky, malými písmeny, mezery sjednocené. */
export function foldText(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim()
}

// Vzory nad foldText. Každý chce výslovné slovo o kontaktu, oslovení,
// odběru nebo námitce; samotné „nesouhlasí" (s cenou) nebo „GDPR" (projekt
// klienta) nestačí. [^.!?] drží shodu uvnitř jedné věty.
//
// Přímý zákaz oslovení platí v poznámce kontaktu i firmy.
const DIRECT_OPT_OUT: readonly RegExp[] = [
  /\bne(kontaktovat|kontaktujte|oslovovat|oslovujte)\b/,
  /\bnechce (uz |dal |dale |vic |vice )?(byt )?(kontaktovan|oslovovan|osloven|kontaktovat|oslovovat|dalsi kontakt|zadny kontakt|newsletter|obchodni sdeleni|marketing)/,
  /\bnechce,? (aby|abychom)\b[^.!?]{0,30}\b(kontaktoval|oslovoval|psal|volal)/,
  /\bnepreje si (dalsi |zadny |zadne )?(byt )?(kontakt|oslov)/,
  /\bzakaz (kontaktu|kontaktovani|osloveni)/,
  /\bdo not contact\b|\bdon'?t contact\b/,
]
// Práva k osobním údajům (odhlášení, souhlas, námitka, výmaz) jen
// v poznámce kontaktu: u firmy jde spíš o smlouvu nebo projekt („opt-out
// po roce", „výmaz dat po projektu", „nesouhlasí se zpracováním v cloudu").
const PERSONAL_OPT_OUT: readonly RegExp[] = [
  /\bodhlas(il|ila|ili|en|ena|eni)\b[^.!?]{0,30}\b(odber|newsletter|mailing|zasilani|obchodnich sdeleni|marketing)/,
  /\bodvolal[aiy]? souhlas/,
  /\bnesouhlas\w* (se |s )?(zpracovanim (svych |jeho |jejich )?osobnich udaju|oslovenim|kontaktovanim|zasilanim|marketing)/,
  /\bnamitk\w* proti (zpracovani|marketing|primemu marketingu|osloveni)/,
  /\bgdpr namitk|\bnamitk\w* (dle|podle) gdpr/,
  /\b(zadost|zada|pozadal|pozadala|pozadali) o vymaz\b/,
  /\bunsubscrib/,
  /\bopt(ed)?[ -]?out\b/,
]

/**
 * Říká poznámka výslovně, že člověk nechce být oslovován? U poznámky firmy
 * (`of: 'account'`) platí jen přímý zákaz oslovení.
 */
export function noteSaysDoNotContact(notes: string | null | undefined, of: 'contact' | 'account' = 'contact'): boolean {
  if (!notes) return false
  const text = foldText(notes)
  const patterns = of === 'account' ? DIRECT_OPT_OUT : [...DIRECT_OPT_OUT, ...PERSONAL_OPT_OUT]
  return patterns.some((re) => re.test(text))
}

// ---------------------------------------------------------------------------
// Kandidáti a výběr

export type CandidateAccount = { id: number; name: string | null; notes: string | null; snooze_until: string | null }

export type ContactCandidate = {
  id: number
  full_name: string
  role: string | null
  email: string | null
  phone: string | null
  notes: string | null
  /** Políčko „Nesouhlasí s oslovením" (0087); před migrací false. */
  do_not_contact: boolean
  account: CandidateAccount | null
}

/** Co z kontaktu samotného (bez firmy) potřebuje rozhodnutí o nesouhlasu. */
export type OptOutFields = { do_not_contact?: boolean | null; notes: string | null }

/**
 * Nesouhlasí člověk s oslovením? 'flag' = políčko u kontaktu, 'note' =
 * výslovný nesouhlas v jeho poznámce (druhá pojistka), null = ne.
 */
export function contactOptOut(c: OptOutFields): 'flag' | 'note' | null {
  if (c.do_not_contact === true) return 'flag'
  if (noteSaysDoNotContact(c.notes)) return 'note'
  return null
}

/** Proč se kontakt oslovit nesmí; null = smí. `today` je pražský den YYYY-MM-DD. */
export function outreachBlockReason(
  c: OptOutFields & { account: Pick<CandidateAccount, 'notes' | 'snooze_until'> | null },
  today: string,
): OutreachBlockReason | null {
  const own = contactOptOut(c)
  if (own === 'flag') return 'contact_opt_out'
  if (c.account?.snooze_until && c.account.snooze_until > today) return 'account_snoozed'
  if (own === 'note' || noteSaysDoNotContact(c.account?.notes, 'account')) return 'note_opt_out'
  return null
}

// ---------------------------------------------------------------------------
// Nesouhlas u firmy (fronta Oslovování, seznamy k oslovení v aplikaci)

/** Kolik lidí u firmy nesouhlasí s oslovením a jestli to říká poznámka firmy. */
export type AccountOptOut = { opted_out: number; total: number; account_note: boolean }

export function summarizeAccountOptOut(
  accountNotes: string | null | undefined,
  contacts: readonly OptOutFields[],
): AccountOptOut {
  return {
    opted_out: contacts.filter((c) => contactOptOut(c) !== null).length,
    total: contacts.length,
    account_note: noteSaysDoNotContact(accountNotes, 'account'),
  }
}

/** Firmu nejde oslovit vůbec: zakazuje to poznámka firmy, nebo nesouhlasí všichni její lidé. */
export function accountFullyOptedOut(s: AccountOptOut | null | undefined): boolean {
  if (!s) return false
  return s.account_note || (s.total > 0 && s.opted_out === s.total)
}

/** Nesouhlasí u firmy aspoň někdo (nebo to říká poznámka firmy)? Pak se u ní ukáže štítek. */
export function accountHasOptOut(s: AccountOptOut | null | undefined): boolean {
  return !!s && (s.account_note || s.opted_out > 0)
}

export const CONTACT_OPTED_OUT_MESSAGE = 'Kontakt nesouhlasí s oslovením — vyberte jiný kontakt, nebo firmu vyřaďte.'
export const ACCOUNT_OPTED_OUT_MESSAGE = 'Firma nesouhlasí s oslovením (všichni její lidé, nebo poznámka u firmy) — do oslovování nepatří.'

/**
 * Smí se firma (a její hlavní kontakt) oslovit? null = smí, jinak česká
 * hláška pro formulář. Seznamy k oslovení: přidání položky a přechod na „osloveno".
 */
export function outreachGate(input: { contact: OptOutFields | null; account: AccountOptOut | null }):
  { field: 'contact_id' | 'account_id'; message: string } | null {
  if (input.contact && contactOptOut(input.contact)) return { field: 'contact_id', message: CONTACT_OPTED_OUT_MESSAGE }
  if (accountFullyOptedOut(input.account)) return { field: 'account_id', message: ACCOUNT_OPTED_OUT_MESSAGE }
  return null
}

/**
 * Fronta k oslovení bez firem, které oslovit nejde (accountFullyOptedOut);
 * ostatním přidá `opt_out` (null = nikdo nesouhlasí), ať se u nich ukáže
 * štítek. `excluded` = počet vynechaných firem.
 */
export function applyOutreachOptOut<T extends { account_id: number }>(
  queue: readonly T[],
  byAccount: ReadonlyMap<number, AccountOptOut>,
): { queue: (T & { opt_out: AccountOptOut | null })[]; excluded: number } {
  const out: (T & { opt_out: AccountOptOut | null })[] = []
  let excluded = 0
  for (const item of queue) {
    const s = byAccount.get(item.account_id) ?? null
    if (accountFullyOptedOut(s)) {
      excluded += 1
      continue
    }
    out.push({ ...item, opt_out: accountHasOptOut(s) ? s : null })
  }
  return { queue: out, excluded }
}

/** Dotaz na slova (bez diakritiky, malými písmeny); null = bez hledání. */
export function searchTokens(raw: string | null | undefined): string[] | null {
  if (typeof raw !== 'string') return null
  const folded = foldText(raw)
  if (!folded) return null
  return folded.split(' ')
}

/** Každé slovo dotazu se musí najít aspoň v jednom poli (jméno, pozice, e-mail, firma). */
export function matchesSearch(tokens: readonly string[] | null, fields: readonly (string | null | undefined)[]): boolean {
  if (!tokens || tokens.length === 0) return true
  const haystack = foldText(fields.filter((f): f is string => !!f).join(' '))
  return tokens.every((t) => haystack.includes(t))
}

/** Položka seznamu k oslovení, přes kterou se kontakt vrací (podle id firmy). */
export type TargetRef = { item_id: number; list_id: number; account_id: number; contact_id: number | null; status: TargetStatus }

export type ExcludedCounts = { count: number } & Record<OutreachBlockReason, number>

export function emptyExcluded(): ExcludedCounts {
  return { count: 0, contact_opt_out: 0, account_snoozed: 0, note_opt_out: 0 }
}

export type SelectedContact = { candidate: ContactCandidate & { account: CandidateAccount }; target: TargetRef | null }

/**
 * Z kandidátů vybere ty, které odpovídají hledání (a seznamu), vynechá ty,
 * které se oslovit nesmí, a seřadí je: firma, u seznamu hlavní kontakt
 * první, jméno, id. Vynechané jen spočítá.
 */
export function selectOutreachContacts(input: {
  candidates: readonly ContactCandidate[]
  today: string
  search?: readonly string[] | null
  /** Položky seznamu podle id firmy; null = bez filtru seznamu. */
  targets?: ReadonlyMap<number, TargetRef> | null
}): { selected: SelectedContact[]; excluded: ExcludedCounts } {
  const excluded = emptyExcluded()
  const selected: SelectedContact[] = []
  for (const c of input.candidates) {
    // Kontakt bez firmy (partnerský, nebo firma mezitím zmizela) sem nepatří.
    if (!c.account) continue
    const target = input.targets ? input.targets.get(c.account.id) ?? null : null
    if (input.targets && !target) continue
    if (!matchesSearch(input.search ?? null, [c.full_name, c.role, c.email, c.account.name])) continue
    const blocked = outreachBlockReason(c, input.today)
    if (blocked) {
      excluded.count += 1
      excluded[blocked] += 1
      continue
    }
    selected.push({ candidate: c as SelectedContact['candidate'], target })
  }
  const isMain = (s: SelectedContact) => (s.target?.contact_id === s.candidate.id ? 0 : 1)
  selected.sort((a, b) =>
    (a.candidate.account.name ?? '').localeCompare(b.candidate.account.name ?? '', 'cs')
    || a.candidate.account.id - b.candidate.account.id
    || isMain(a) - isMain(b)
    || a.candidate.full_name.localeCompare(b.candidate.full_name, 'cs')
    || a.candidate.id - b.candidate.id)
  return { selected, excluded }
}

// ---------------------------------------------------------------------------
// Stránkování a poslední aktivita

export type Paged<T> = { items: T[]; total: number; next_offset: number | null }

export function paginate<T>(items: readonly T[], limit: number, offset: number): Paged<T> {
  const page = items.slice(offset, offset + limit)
  const next = offset + limit
  return { items: page, total: items.length, next_offset: next < items.length ? next : null }
}

/**
 * Doplní do `into` nejnovější okamžik podle kontaktu. Řádky mohou přijít
 * z víc zdrojů (aktivity, e-maily) v libovolném pořadí; vyhrává pozdější čas.
 */
export function mergeLatest(
  into: Map<number, string>,
  rows: readonly { contact_id: number | null; occurred_at: string | null }[],
): void {
  for (const r of rows) {
    if (r.contact_id == null || !r.occurred_at) continue
    const at = Date.parse(r.occurred_at)
    if (Number.isNaN(at)) continue
    const prev = into.get(r.contact_id)
    if (prev === undefined || at > Date.parse(prev)) into.set(r.contact_id, new Date(at).toISOString())
  }
}

// ---------------------------------------------------------------------------
// Tvar výstupu

export type OutreachContact = {
  id: number
  full_name: string
  role: string | null
  email: string | null
  phone: string | null
  account: { id: number; name: string | null }
  /** Poslední záznam z jednání nebo e-mail spárovaný přímo na tohoto člověka. */
  last_activity_at: string | null
  /** Jen při filtru seznamu k oslovení. */
  target?: { list_id: number; item_id: number; status: TargetStatus; main_contact: boolean }
}

export function toOutreachContact(s: SelectedContact, lastActivity: ReadonlyMap<number, string>): OutreachContact {
  const c = s.candidate
  const out: OutreachContact = {
    id: c.id,
    full_name: c.full_name,
    role: c.role,
    email: c.email,
    phone: c.phone,
    account: { id: c.account.id, name: c.account.name },
    last_activity_at: lastActivity.get(c.id) ?? null,
  }
  if (s.target) {
    out.target = {
      list_id: s.target.list_id,
      item_id: s.target.item_id,
      status: s.target.status,
      main_contact: s.target.contact_id === c.id,
    }
  }
  return out
}
