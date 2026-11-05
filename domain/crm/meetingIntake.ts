// Příjem zápisů schůzek z diktátu (Wispr Flow) — čistá logika, bez I/O.
//
// Wispr Flow nemá veřejné API (rozhodnutí vlastníka 28. 9. 2026), takže zápis
// posílá člověk sám: zkratka v telefonu, curl, webhook. Endpoint
// POST /api/ingest/meeting-notes (app/api/ingest/meeting-notes/route.ts)
// přijme text, tenhle soubor rozhoduje o třech věcech:
//
//   1. jaký vstup je platný (meetingNoteInput, meze velikosti),
//   2. ke které firmě zápis patří (matchNoteToAccount) — IČO, e-mail/doména,
//      alias, název; radši nic než špatná vazba (stejná filozofie jako
//      domain/crm/meetingMatch.ts a mailMatch.ts),
//   3. které řádky textu jsou úkoly (extractActionItems) a jak vypadá z nich
//      složený NÁVRH případu (buildStepsProposal) — návrh, ne zápis do CRM.
//
// Zápis do databáze dělá domain/crm/meetingIntakeService.ts.
//
// Text zápisu je nedůvěryhodný (diktát z jednání, mluvil kdokoli). Tady ho
// nic nevykonává — jen se páruje, hledají se v něm řádky „úkol: …" a uloží
// se jako text. Model se na něj nevolá.
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { FREEMAIL } from '@/domain/crm/meetingMatch'
import { normalizeCompanyName, cleanCompanyName } from '@/connectors/ares'
import { pragueLocalToUtc } from '@/lib/pragueDate'

// ---------------------------------------------------------------------------
// Meze (musí sedět s CHECKy v 0078_meeting_note_intake.sql)

export const MEETING_NOTE_SOURCE = 'wispr_flow'
export const MEETING_NOTE_BODY_MAX = 50_000
export const MEETING_NOTE_TITLE_MAX = 300
export const MEETING_NOTE_HINT_MAX = 200
export const MEETING_NOTE_ACTIONS_MAX = 10
export const MEETING_NOTE_ACTION_MAX = 300
export const MEETING_NOTE_EXTERNAL_ID_MAX = 128
/** Největší tělo požadavku v bajtech (text v UTF-8 + JSON obal). */
export const MEETING_NOTE_REQUEST_MAX_BYTES = 200_000
// Tolerance na posun hodin a časová pásma (jako u create_activity).
const FUTURE_TOLERANCE_MS = 24 * 60 * 60 * 1000

export const FUTURE_OCCURRED_AT_ERROR = 'occurred_at nesmí být v budoucnosti.'
export const INVALID_OCCURRED_AT_ERROR = 'occurred_at není platné datum (očekávám 2026-09-29 nebo ISO čas).'

const optText = (max: number, label: string) =>
  z.string().trim().max(max, `${label} je delší než ${max} znaků`).nullish()
    .transform((v) => (v && v.length > 0 ? v : null))

// Odesílatel nemusí umět poslat čisté null: zkratky často posílají prázdné
// pole místo vynechaného. Prázdný řetězec = „neuvedeno".
export const meetingNoteInput = z.object({
  text: z.string().trim().min(1, 'text je povinný').max(MEETING_NOTE_BODY_MAX, `text je delší než ${MEETING_NOTE_BODY_MAX} znaků`),
  title: optText(MEETING_NOTE_TITLE_MAX, 'title'),
  // Datum schůzky: 2026-09-29 (poledne pražského času) nebo ISO čas.
  occurred_at: optText(64, 'occurred_at'),
  // Nápověda klienta: název, IČO, doména nebo e-mail účastníka.
  client_hint: optText(MEETING_NOTE_HINT_MAX, 'client_hint'),
  // Klíč idempotence od odesílatele (zkratka ho může poslat při opakování).
  external_id: z.string().trim().max(MEETING_NOTE_EXTERNAL_ID_MAX, 'external_id je příliš dlouhé')
    .regex(/^[A-Za-z0-9._:@-]*$/, 'external_id smí obsahovat jen písmena, číslice a . _ : @ -').nullish()
    .transform((v) => (v && v.length > 0 ? v : null)),
  // Úkoly předem vytažené odesílatelem (volitelné). Doplňují ty, které
  // Cockpit najde sám v řádcích „úkol: …".
  actions: z.array(z.string().trim().max(MEETING_NOTE_ACTION_MAX, `úkol je delší než ${MEETING_NOTE_ACTION_MAX} znaků`))
    .max(MEETING_NOTE_ACTIONS_MAX, `nejvýš ${MEETING_NOTE_ACTIONS_MAX} úkolů`).nullish()
    .transform((v) => (v ?? []).filter((a) => a.length > 0)),
})

export type MeetingNoteInput = z.infer<typeof meetingNoteInput>

/**
 * Kdy schůzka proběhla (UTC ISO). Prázdné = teď. `YYYY-MM-DD` = poledne
 * pražského času téhož dne (Wispr diktát datum bez hodiny většinou nemá).
 * Vrací chybu jako text, ne výjimku.
 */
export function resolveOccurredAt(
  raw: string | null,
  now: Date = new Date(),
): { ok: true; iso: string } | { ok: false; error: string } {
  if (raw == null) return { ok: true, iso: now.toISOString() }
  let date: Date
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    try {
      date = pragueLocalToUtc(`${raw}T12:00`)
    } catch {
      return { ok: false, error: INVALID_OCCURRED_AT_ERROR }
    }
  } else {
    date = new Date(raw)
  }
  if (Number.isNaN(date.getTime())) return { ok: false, error: INVALID_OCCURRED_AT_ERROR }
  if (date.getTime() > now.getTime() + FUTURE_TOLERANCE_MS) return { ok: false, error: FUTURE_OCCURRED_AT_ERROR }
  return { ok: true, iso: date.toISOString() }
}

/**
 * Klíč idempotence: id od odesílatele, jinak hash textu (stejný text = stejný zápis).
 * Klíč nese i vlastníka API klíče (`owner`): bez něj by byla idempotence globální —
 * `external_id` nebo text jiného držitele klíče by tiše zahodil nový zápis a vrátil
 * id cizího (a stejný text by fungoval jako oracle „tohle už někdo poslal").
 * Vlastník je jen v klíči; do odpovědi ani do logu nejde.
 */
export function dedupeKeyFor(source: string, externalId: string | null, text: string, owner: string | null = null): string {
  const who = owner ?? 'anon'
  if (externalId) return `ext:${source}:${who}:${externalId}`
  return `sha256:${createHash('sha256').update(`${who}\n${text.normalize('NFC')}`).digest('hex')}`
}

/** Předmět aktivity: název, jinak první věta textu (nejvýš 120 znaků). */
export function subjectFor(title: string | null, text: string): string {
  if (title) return title
  const first = text.split(/\n|(?<=[.!?])\s/).map((s) => s.trim()).find((s) => s.length > 0) ?? ''
  if (first.length === 0) return 'Zápis ze schůzky (Wispr Flow)'
  return first.length > 120 ? `${first.slice(0, 119)}…` : first
}

// ---------------------------------------------------------------------------
// Párování na firmu

export type MatchAccount = { id: number; name: string; ico: string | null; web: string | null }
export type MatchAlias = { account_id: number; alias_domain: string | null; alias_name: string | null }
export type MatchContact = { account_id: number; email: string }

export const NOTE_MATCH_METHODS = ['ico', 'domain', 'alias', 'name', 'text_name'] as const
export type NoteMatchMethod = (typeof NOTE_MATCH_METHODS)[number]

export type NoteMatchResult =
  | { status: 'matched'; accountId: number; method: NoteMatchMethod }
  /** Víc firem nebo protichůdné signály — rozhodne člověk. */
  | { status: 'ambiguous'; accountIds: number[] }
  | { status: 'none' }

export type NoteMatchInput = {
  clientHint: string | null
  title: string | null
  text: string
  accounts: readonly MatchAccount[]
  aliases: readonly MatchAlias[]
  contacts: readonly MatchContact[]
}

/** IČO bez mezer a s nulami na 8 číslic; jiné než číslice = null. */
export function canonicalIco(raw: string): string | null {
  const digits = raw.replace(/\s/g, '').replace(/^CZ/i, '')
  if (!/^\d{1,8}$/.test(digits)) return null
  return digits.padStart(8, '0')
}

/** Kontrolní číslice IČO (modulo 11). Náhodných 8 číslic v textu tak firmu nespáruje. */
export function isValidIco(ico: string): boolean {
  if (!/^\d{8}$/.test(ico)) return false
  const d = ico.split('').map(Number)
  const sum = d.slice(0, 7).reduce((acc, n, i) => acc + n * (8 - i), 0)
  let c = 11 - (sum % 11)
  if (c === 10) c = 0
  else if (c === 11) c = 1
  return c === d[7]
}

/** Malá písmena bez diakritiky, jen alfanumerika oddělená mezerou. */
export function foldText(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

/** Klíč názvu firmy: bez právní formy, závorek a interpunkce („Sigmaform s.r.o." → „sigmaform"). */
export function nameKey(name: string): string {
  return normalizeCompanyName(cleanCompanyName(name))
}

const EMAIL_RE = /[a-z0-9._%+-]+@([a-z0-9-]+(?:\.[a-z0-9-]+)+)/gi
const DOMAIN_RE = /\b((?:[a-z0-9-]+\.)+[a-z]{2,24})\b/gi

/** IČO v nápovědě: jen čísla (i s mezerami), případně s „IČO"/„CZ" — kontrolní součet musí sedět. */
export function icosInHint(hint: string): string[] {
  const out = new Set<string>()
  for (const m of hint.matchAll(/(?:\bCZ\s*)?\d[\d ]{4,10}\d/gi)) {
    const c = canonicalIco(m[0])
    if (c && isValidIco(c)) out.add(c)
  }
  return [...out]
}

/** IČO v textu jen s výslovným štítkem („IČO 27082440", „IČ: 27082440"). */
export function icosInText(text: string): string[] {
  const out = new Set<string>()
  for (const m of text.matchAll(/\b(?:i[čc]o?|ico)\s*[:.]?\s*(\d[\d ]{4,10}\d)/gi)) {
    const c = canonicalIco(m[1])
    if (c && isValidIco(c)) out.add(c)
  }
  return [...out]
}

function domainOfEmail(email: string): string | null {
  const at = email.lastIndexOf('@')
  return at === -1 ? null : email.slice(at + 1).toLowerCase()
}

function hostOfWeb(web: string | null): string | null {
  if (!web) return null
  const h = web.trim().toLowerCase().replace(/^[a-z]+:\/\//, '').replace(/^www\./, '').split(/[/?#]/)[0]
  return h && h.includes('.') ? h : null
}

const bare = (d: string) => d.toLowerCase().replace(/^@/, '').replace(/^www\./, '')

type Hit = { accountId: number; method: NoteMatchMethod }

function ofSet(hits: Hit[]): number[] {
  return [...new Set(hits.map((h) => h.accountId))]
}

// Minimální délka jména firmy, které smí spárovat zápis jen podle zmínky
// v textu. Krátké a obecné názvy („K2", „Doprava") jsou v běžné řeči všude.
export const TEXT_NAME_MIN_LENGTH = 5

/** Kandidáti z nápovědy: IČO > e-mail/doména > název/alias. Prázdné pole = nápověda nic nenašla. */
function hitsFromHint(hint: string, input: NoteMatchInput): Hit[] {
  const hits: Hit[] = []

  // 1) IČO — jednoznačné, kontrolní součet ho chrání proti náhodnému číslu.
  const icos = new Set(icosInHint(hint))
  if (icos.size > 0) {
    for (const a of input.accounts) {
      const c = a.ico ? canonicalIco(a.ico) : null
      if (c && icos.has(c)) hits.push({ accountId: a.id, method: 'ico' })
    }
  }

  // 2) E-mail a doména. Freemail (gmail.com…) se páruje jen na přesnou adresu
  //    známého kontaktu, nikdy na doménu — gmail.com neznamená firmu.
  const emails = new Set([...hint.matchAll(EMAIL_RE)].map((m) => m[0].toLowerCase()))
  const domains = new Set<string>()
  for (const e of emails) {
    const d = domainOfEmail(e)
    if (d) domains.add(d)
  }
  const hintNoEmails = hint.replace(EMAIL_RE, ' ')
  for (const m of hintNoEmails.matchAll(DOMAIN_RE)) domains.add(bare(m[1]))
  const corporate = [...domains].filter((d) => !FREEMAIL.has(d))
  for (const c of input.contacts) {
    const e = c.email.trim().toLowerCase()
    if (emails.has(e)) hits.push({ accountId: c.account_id, method: 'domain' })
    else {
      const d = domainOfEmail(e)
      if (d && !FREEMAIL.has(d) && corporate.includes(d)) hits.push({ accountId: c.account_id, method: 'domain' })
    }
  }
  for (const al of input.aliases) {
    const d = al.alias_domain ? bare(al.alias_domain) : null
    if (d && !FREEMAIL.has(d) && corporate.includes(d)) hits.push({ accountId: al.account_id, method: 'alias' })
  }
  for (const a of input.accounts) {
    const h = hostOfWeb(a.web)
    if (h && !FREEMAIL.has(h) && corporate.includes(bare(h))) hits.push({ accountId: a.id, method: 'domain' })
  }

  // 3) Název: celé jméno firmy (bez právní formy) se musí rovnat nápovědě.
  const key = nameKey(hint)
  if (key.length >= 2) {
    for (const a of input.accounts) if (nameKey(a.name) === key) hits.push({ accountId: a.id, method: 'name' })
    for (const al of input.aliases) {
      if (al.alias_name && nameKey(al.alias_name) === key) hits.push({ accountId: al.account_id, method: 'alias' })
    }
  }
  return hits
}

/** Kandidáti bez nápovědy: výslovné IČO v textu, jinak zmínka celého názvu firmy. */
function hitsFromText(input: NoteMatchInput): Hit[] {
  const haystackSource = `${input.title ?? ''}\n${input.text}`
  const icos = new Set(icosInText(haystackSource))
  const hits: Hit[] = []
  if (icos.size > 0) {
    for (const a of input.accounts) {
      const c = a.ico ? canonicalIco(a.ico) : null
      if (c && icos.has(c)) hits.push({ accountId: a.id, method: 'ico' })
    }
    if (hits.length > 0) return hits
  }

  const haystack = ` ${foldText(haystackSource)} `
  type Mention = { accountId: number; key: string; method: NoteMatchMethod }
  const mentions: Mention[] = []
  const consider = (accountId: number, name: string, method: NoteMatchMethod) => {
    const key = foldText(nameKey(name))
    if (key.length < TEXT_NAME_MIN_LENGTH) return
    if (haystack.includes(` ${key} `)) mentions.push({ accountId, key, method })
  }
  for (const a of input.accounts) consider(a.id, a.name, 'text_name')
  for (const al of input.aliases) if (al.alias_name) consider(al.account_id, al.alias_name, 'text_name')

  // „Sigmaform" v textu „Sigmaform Servis" nesmí vyhrát nad delším jménem jiné firmy:
  // zmínku, jejíž klíč je celý obsažen v delším klíči zmíněném u jiné firmy,
  // zahodíme (delší jméno je přesnější).
  const kept = mentions.filter(
    (m) => !mentions.some((o) => o.accountId !== m.accountId && o.key.length > m.key.length && ` ${o.key} `.includes(` ${m.key} `)),
  )
  return kept.map((m) => ({ accountId: m.accountId, method: m.method }))
}

const STRENGTH: Record<NoteMatchMethod, number> = { ico: 5, domain: 4, alias: 3, name: 2, text_name: 1 }

/**
 * Ke které firmě zápis patří? Čistá funkce.
 *
 * S nápovědou (client_hint) rozhoduje JEN ona — text zápisu zmiňuje i cizí
 * firmy, takže by nápovědu přebíjel omylem. Nápověda, která nic nenajde,
 * vede do fronty (neznámá firma), ne k hádání podle textu.
 * Bez nápovědy se hledá výslovné IČO a pak zmínka celého názvu firmy.
 *
 * Spáruje se jen když všechny signály vedou na PRÁVĚ JEDNU firmu. Víc firem
 * (dvě se stejným jménem, doména sdílená mateřskou a dceřinou firmou,
 * IČO jedné a doména druhé) = `ambiguous`, žádná = `none`; obojí jde do
 * fronty k ručnímu rozhodnutí.
 */
export function matchNoteToAccount(input: NoteMatchInput): NoteMatchResult {
  const hint = input.clientHint?.trim() ?? ''
  const hits = hint ? hitsFromHint(hint, input) : hitsFromText(input)
  const ids = ofSet(hits)
  if (ids.length === 0) return { status: 'none' }
  if (ids.length > 1) return { status: 'ambiguous', accountIds: ids.sort((a, b) => a - b) }
  const strongest = hits.reduce((best, h) => (STRENGTH[h.method] > STRENGTH[best.method] ? h : best))
  return { status: 'matched', accountId: ids[0], method: strongest.method }
}

// ---------------------------------------------------------------------------
// Úkoly z textu → návrh kroků

// Předpona řádku, která z něj dělá úkol: „Úkol: …", „Úkol pro Petra: …",
// „TODO – …", „Další krok: …", „Akce: …". Porovnává se bez diakritiky.
// Dodatek („pro Petra", „do pátku") smí mít jen úkol/úkoly — u „akce" by
// z „Akce Black Friday: sleva" vznikl falešný úkol.
const ACTION_PREFIX_RE =
  /^(?:(?:ukol|ukoly)(?: [a-z0-9]{1,20}){0,4}|todo|to do|akce|dalsi krok|dalsi kroky|next steps?|action items?|action)$/

/**
 * Vytáhne z diktátu řádky, které výslovně jsou úkol („Úkol: poslat nabídku
 * do pátku"), a doplní je úkoly od odesílatele. Nic nevymýšlí: žádný model,
 * jen řádky s výslovnou předponou. Duplicity (bez ohledu na diakritiku
 * a velikost písmen) se slučují, výsledek má nejvýš MEETING_NOTE_ACTIONS_MAX
 * položek po nejvýš MEETING_NOTE_ACTION_MAX znacích.
 */
export function extractActionItems(text: string, explicit: readonly string[] = []): string[] {
  const found: string[] = []
  const segments = text
    .split(/\n+/)
    .flatMap((line) => line.split(/(?<=[.!?])\s+(?=\S)/))
  for (const raw of segments) {
    // odrážky, zaškrtávátka a číslování na začátku
    const seg = raw.replace(/^\s*(?:[-*•–—]+|\d{1,2}[.)]|\[[ xX]?\])\s*/, '').trim()
    if (seg.length === 0) continue
    const sep = seg.search(/[:–—]|\s-\s/)
    if (sep < 1 || sep > 60) continue
    if (!ACTION_PREFIX_RE.test(foldText(seg.slice(0, sep)))) continue
    const payload = seg.slice(sep).replace(/^\s*(?:[:–—]|-)\s*/, '').trim().replace(/[.;]+$/, '').trim()
    if (payload.length >= 3) found.push(payload)
  }

  const out: string[] = []
  const seen = new Set<string>()
  for (const a of [...explicit, ...found]) {
    const clean = a.replace(/\s+/g, ' ').trim()
    if (clean.length < 3) continue
    const item = clean.length > MEETING_NOTE_ACTION_MAX ? `${clean.slice(0, MEETING_NOTE_ACTION_MAX - 1)}…` : clean
    const key = foldText(item)
    if (key.length === 0 || seen.has(key)) continue
    seen.add(key)
    out.push(item)
    if (out.length >= MEETING_NOTE_ACTIONS_MAX) break
  }
  return out
}

export const TITLE_PLACEHOLDER = '{firma}'

/** Název návrhu ze šablony firmy; `{firma}` = jméno firmy z CRM. Nejvýš 300 znaků. */
export function renderProposalTitle(template: string, accountName: string): string {
  const title = template.split(TITLE_PLACEHOLDER).join(accountName.trim()).trim()
  return title.length > 300 ? `${title.slice(0, 299)}…` : title
}

export type StepsProposal = { title: string; rationale: string; steps: string[] }

/**
 * Návrh případu z úkolů v zápisu; null, když v textu žádné nejsou.
 * Zdůvodnění je obecné (nenese text zápisu), kroky jsou úkoly tak, jak je
 * řekl člověk — ke schválení na /pripady?view=navrhy.
 */
export function buildStepsProposal(
  actions: readonly string[],
  accountName: string,
  titleTemplate: string,
): StepsProposal | null {
  if (actions.length === 0) return null
  const n = actions.length
  return {
    title: renderProposalTitle(titleTemplate, accountName),
    rationale: `Ze zápisu schůzky (Wispr Flow) vybráno ${n} ${n === 1 ? 'úkol' : n < 5 ? 'úkoly' : 'úkolů'}. Zkontroluj kroky, než návrh přijmeš.`,
    steps: [...actions],
  }
}
