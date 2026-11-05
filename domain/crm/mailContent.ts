// Obsahový vstup pošty (P2.1 revize z 29. 9. 2026, kapitola 2D) — čistá logika,
// bez I/O. Zápis do databáze a Graph řeší domain/crm/mailContentService.ts.
//
// Pošta se plošně čte jen jako METADATA (mailSync.ts). Tohle je jediná
// výjimka a je vědomá: uživatel přesune e-mail v Outlooku do složky „Cockpit"
// (název z prostředí) a jen takové zprávy Cockpit přečte včetně těla.
// Tady se z jedné takové zprávy rozhodne o čtyřech věcech:
//
//   1. co zpráva říká (recognizeContent) — klíčová slova, žádný model:
//      schválení, posun termínu, požadavek na změnu, přílohy; z těla se vybere
//      jeden důkazní ÚRYVEK (nejvýš 300 znaků, bez adres a dlouhých čísel),
//   2. ke komu patří (resolveAccount) — doména, kontakt, alias, název firmy
//      v předmětu; radši nic než špatná vazba (nejistota = fronta),
//   3. ke které dodávce či obchodu a milníku (chooseTarget, chooseMilestone),
//   4. jak vypadá NÁVRH (buildMailContentProposal) — návrh pracovního případu
//      ke schválení člověkem; nic se nezmění samo.
//
// TĚLO ZPRÁVY SE NEUKLÁDÁ A NELOGUJE. Žije jen v proměnných jednoho běhu; ven
// z téhle vrstvy jde úryvek. Text zprávy je nedůvěryhodný (píše ho kdokoli) —
// nic z něj se nevykonává, jen se v něm hledají slova.
import { createHash } from 'node:crypto'
import type { GraphContentMessage } from '@/connectors/graph'
import { EVIDENCE_SOURCE_ID_MAX } from '@/core/informationState'
import { sanitizeUntrustedText } from '@/core/untrusted'
import { COMPANY } from '@/config'
import { matchMail, OUR_DOMAIN, type MailAlias, type MailContact } from '@/domain/crm/mailMatch'
import { domainOf } from '@/domain/crm/meetingMatch'
import {
  matchNoteToAccount,
  type MatchAccount,
  type MatchAlias,
  type MatchContact,
} from '@/domain/crm/meetingIntake'
import { sanitizeMailWebLink } from '@/domain/crm/mailSync'
import { MAIL_SIGNALS, MAIL_SIGNAL_LABEL, type MailSignal } from '@/domain/crm/mailContentLabels'

// ---------------------------------------------------------------------------
// Meze (musí sedět s CHECKy v 0091_mail_content_intake.sql; hlídá test)

export const MAIL_CONTENT_SOURCE = 'outlook_folder'
/** Klíč connector_state (kurzor složky a Stav zdrojů). */
export const MAIL_CONTENT_CONNECTOR = 'outlook:cockpit'
export const MAIL_CONTENT_EXCERPT_MAX = 300
export const MAIL_CONTENT_SUBJECT_MAX = 200
export const MAIL_CONTENT_ATTACHMENTS_MAX = 10
export const MAIL_CONTENT_ATTACHMENT_NAME_MAX = 120
export const MAIL_CONTENT_DOMAIN_MAX = 253
/** Kolik znaků nejnovější části těla se prohledává (zbytek je většinou podpis a citace). */
export const MAIL_CONTENT_SCAN_MAX = 8_000
export const MAIL_CONTENT_EMPTY_EXCERPT = '(zpráva bez textu)'

export const MAIL_CONTENT_DEFAULT_FOLDER = 'Cockpit'
export const MAIL_CONTENT_FOLDER_MAX = 100

// Příznaky, důvody čekání a jejich popisky jsou v mailContentLabels.ts (bez
// závislosti na serveru), protože je čte i klientská karta fronty.
export { MAIL_SIGNALS, MAIL_SIGNAL_LABEL, MAIL_WAIT_REASONS, MAIL_WAIT_REASON_TEXT } from '@/domain/crm/mailContentLabels'
export type { MailSignal, MailWaitReason } from '@/domain/crm/mailContentLabels'

export const MAIL_MATCH_METHODS = ['contact', 'domain', 'alias', 'name', 'manual'] as const
export type MailMatchMethod = (typeof MAIL_MATCH_METHODS)[number]

// ---------------------------------------------------------------------------
// Prostředí (přepínače výchozí VYPNUTO)

type Env = Record<string, string | undefined>

/** Obsahový vstup pošty: jen přesně `true`. Bez přepínače se nic nečte. */
export function mailContentEnabledFromEnv(env: Env = process.env): boolean {
  return env.MAIL_CONTENT_INTAKE_ENABLED === 'true'
}

/** AI shrnutí zprávy: jen přesně `true` (a klíč ANTHROPIC_API_KEY). Výchozí vypnuto. */
export function mailContentAiEnabledFromEnv(env: Env = process.env): boolean {
  return env.MAIL_CONTENT_AI_ENABLED === 'true'
}

/** Smí Cockpit složku založit? Jen přesně `true`; jinak ji člověk založí v Outlooku. */
export function mailContentFolderCreateFromEnv(env: Env = process.env): boolean {
  return env.MAIL_CONTENT_FOLDER_CREATE === 'true'
}

/** Název složky z prostředí; prázdný nebo příliš dlouhý = výchozí „Cockpit". */
export function mailContentFolderName(env: Env = process.env): string {
  const raw = (env.MAIL_CONTENT_FOLDER ?? '').trim()
  return raw.length >= 1 && raw.length <= MAIL_CONTENT_FOLDER_MAX ? raw : MAIL_CONTENT_DEFAULT_FOLDER
}

// ---------------------------------------------------------------------------
// Zpráva z Graphu → naše zpráva

export type ContentMessage = {
  /** Id zprávy v Graphu (pro dotaz na názvy příloh); nikam se neukládá. */
  graphId: string
  internetMessageId: string
  webLink: string | null
  subject: string
  /** Tělo jako prostý text. Nikdy se neukládá ani neloguje. */
  body: string
  hasAttachments: boolean
  from: string | null
  to: string[]
  cc: string[]
  /** ISO čas přijetí (u odchozí zprávy odeslání). */
  receivedAt: string
}

export type ContentSkip = 'removed' | 'draft' | 'no_message_id' | 'no_date'

const addr = (r: { emailAddress?: { address?: string | null } | null } | null | undefined): string | null => {
  const a = r?.emailAddress?.address
  return typeof a === 'string' && a.includes('@') ? a.trim().toLowerCase() : null
}

export function toContentMessage(m: GraphContentMessage): { message: ContentMessage } | { skip: ContentSkip } {
  if (m['@removed'] !== undefined) return { skip: 'removed' }
  if (m.isDraft) return { skip: 'draft' }
  const mid = typeof m.internetMessageId === 'string' ? m.internetMessageId.trim() : ''
  // Delší Message-ID než evidence unese (512) je nesmysl, ne identifikátor: přeskočit, ať neblokuje stránku.
  if (!mid || mid.length > EVIDENCE_SOURCE_ID_MAX) return { skip: 'no_message_id' }
  const when = m.receivedDateTime ?? m.sentDateTime
  if (!when || !Number.isFinite(Date.parse(when))) return { skip: 'no_date' }
  const list = (rs: GraphContentMessage['toRecipients']) => (rs ?? []).map(addr).filter((a): a is string => !!a)
  return {
    message: {
      graphId: typeof m.id === 'string' ? m.id : '',
      internetMessageId: mid,
      webLink: sanitizeMailWebLink(m.webLink),
      subject: typeof m.subject === 'string' ? m.subject : '',
      body: typeof m.body?.content === 'string' ? m.body.content : '',
      hasAttachments: m.hasAttachments === true,
      from: addr(m.from),
      to: list(m.toRecipients),
      cc: list(m.ccRecipients),
      receivedAt: new Date(when).toISOString(),
    },
  }
}

/** Klíč idempotence: hash Message-ID (stejná zpráva podruhé nic nezdvojí). */
export function dedupeKeyForMessage(internetMessageId: string): string {
  return `sha256:${createHash('sha256').update(internetMessageId.trim()).digest('hex')}`
}

// ---------------------------------------------------------------------------
// Očištění textu

// Písmena bez diakritiky a malá, ZACHOVÁVÁ DÉLKU (index v přeloženém textu
// je index v původním) — foldText z meetingIntake délku mění.
function fold(s: string): string {
  let out = ''
  // Po UTF-16 jednotkách (ne po znacích), aby index zůstal shodný i s emoji.
  for (let i = 0; i < s.length; i++) {
    const unit = s[i]
    const base = unit.normalize('NFD')[0] ?? unit
    const low = base.toLowerCase()
    out += low.length === 1 ? low : base
  }
  return out
}

const collapse = (s: string): string => s.replace(/\s+/g, ' ').trim()

const REPLY_LINE_MARKERS = [
  /^-{2,}\s*(?:original message|puvodni zprava|forwarded message|preposlana zprava)/,
  /^_{5,}\s*$/,
  /^(?:on|dne)\s.{3,200}(?:wrote|napsal|napsala|napsal\(a\))\s*:?\s*$/,
]
const HEADER_START = /^(?:from|od|de|von)\s*:\s*\S/
const HEADER_FOLLOW = /^(?:sent|odeslano|datum|date|to|komu|cc|subject|predmet)\s*:/
const SENT_FROM = /^(?:odeslano z |sent from |ziskat outlook pro )/

/**
 * Nejnovější část zprávy: bez citace předchozí korespondence, řádků „>"
 * a podpisu zařízení. Když by po očištění nezbylo nic, vrátí se původní text
 * (mail, který je celý citace, se aspoň přečte).
 */
export function latestReplyText(body: string): string {
  const text = sanitizeUntrustedText(body, 200_000).text.normalize('NFC')
  const lines = text.split('\n')
  const kept: string[] = []
  for (let i = 0; i < lines.length; i++) {
    const folded = fold(lines[i]).trim()
    if (REPLY_LINE_MARKERS.some((re) => re.test(folded))) break
    if (HEADER_START.test(folded) && lines.slice(i + 1, i + 5).some((l) => HEADER_FOLLOW.test(fold(l).trim()))) break
    if (folded.startsWith('>') || SENT_FROM.test(folded)) continue
    kept.push(lines[i])
  }
  const result = kept.join('\n').trim()
  return result.length > 0 ? result : text.trim()
}

/** E-mailové adresy a dlouhá čísla (telefon, účet) v úryvku se zamaskují. */
export function maskPersonalData(s: string): string {
  return s
    .replace(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, '[e-mail]')
    // Data (2026-10-05, 5/10/2026) telefon nejsou.
    .replace(/\+?\d[\d ()/-]{7,}\d/g, (m) =>
      /^\d{4}-\d{2}-\d{2}$|^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(m) || m.replace(/\D/g, '').length < 9 ? m : '[číslo]')
}

// ---------------------------------------------------------------------------
// Rozpoznání obsahu (pravidla, bez modelu)

// Vzory běží nad textem bez diakritiky a malými písmeny (fold). `(?<![a-z])`
// = začátek slova, takže „neschvalujeme" NEjde jako schválení.
const APPROVAL_RE = /(?<![a-z])(?:schval\w*|odsouhlas\w*|souhlas\w*|akceptuj\w*|akceptac\w*|muzete pokracovat|pokracujte)/
const CHANGE_RE = new RegExp(
  '(?<![a-z])(?:' +
    // nesouhlas a výhrady = klient chce jinak
    'neschval\\w*|nesouhlas\\w*|neodsouhlas\\w*|neakceptuj\\w*|nelze schvalit|nemuzeme schvalit|nevyhovuje|nejsme spokojen\\w*|' +
    'zmen\\w*|uprav\\w*|pripomin\\w*|doplnit|doplneni|rozsirit|rozsireni|navic|pozadavek|pozadavk\\w*|namisto|nepocital\\w*' +
    ')',
)
const SCHEDULE_RE = /(?<![a-z])(?:posun\w*|presun\w*|odloz\w*|odklad\w*|nestihn\w*|zpozden\w*|prodlouz\w*|deadline\w*)/
const TERM_RE = /(?<![a-z])termin\w*/
const ATTACHMENT_RE = /(?<![a-z])(?:prikladam\w*|v priloze|priloh\w*|prilozen\w*|attached|attachment)/

const MONTHS = ['ledna', 'unora', 'brezna', 'dubna', 'kvetna', 'cervna', 'cervence', 'srpna', 'zari', 'rijna', 'listopadu', 'prosince']
const DATE_NUMERIC = /(?<!\d)(\d{1,2})\s?\.\s?(\d{1,2})\s?\.(?:\s?(\d{4}))?/g
const DATE_WORDS = new RegExp(`(?<!\\d)(\\d{1,2})\\s?\\.\\s?(${MONTHS.join('|')})(?:\\s+(\\d{4}))?`, 'g')
// Bez příznaku g (search nemá stav).
const DATE_NUMERIC_ONE = new RegExp(DATE_NUMERIC.source)
const DATE_WORDS_ONE = new RegExp(DATE_WORDS.source)

const ymd = (y: number, m: number, d: number): string | null => {
  const dt = new Date(Date.UTC(y, m - 1, d))
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return null
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

/**
 * Právě jedno datum v textu (`5. 10.`, `5. 10. 2026`, `5. října`) jako
 * YYYY-MM-DD; žádné nebo víc různých = null. Bez roku platí nejbližší budoucí
 * výskyt vůči dni přijetí zprávy (týden zpět se ještě bere jako letošní).
 */
export function extractSingleDate(text: string, receivedAt: Date): string | null {
  const folded = fold(text)
  const found = new Set<string>()
  const add = (dayS: string, monthN: number, yearS: string | undefined) => {
    const day = Number(dayS)
    let year = yearS ? Number(yearS) : receivedAt.getUTCFullYear()
    let iso = ymd(year, monthN, day)
    if (!iso) return
    if (!yearS && Date.parse(`${iso}T23:59:59Z`) < receivedAt.getTime() - 7 * 86_400_000) {
      year += 1
      iso = ymd(year, monthN, day)
    }
    if (iso) found.add(iso)
  }
  for (const m of folded.matchAll(DATE_NUMERIC)) add(m[1], Number(m[2]), m[3])
  for (const m of folded.matchAll(DATE_WORDS)) add(m[1], MONTHS.indexOf(m[2]) + 1, m[3])
  return found.size === 1 ? [...found][0] : null
}

export type Recognition = {
  signals: MailSignal[]
  /** Hlavní příznak pro druh návrhu (změna > termín > schválení > přílohy); null = nic rozpoznáno. */
  primary: MailSignal | null
  /** Důkazní úryvek, nejvýš 300 znaků, vždy neprázdný. */
  excerpt: string
  /** Jediné datum v úryvku u příznaku posunu termínu; jinak null. */
  proposedDate: string | null
}

const PRIORITY: readonly MailSignal[] = ['change', 'schedule', 'approval', 'attachment']

type Hit = { signal: MailSignal; index: number }

function firstHits(folded: string): Hit[] {
  const hits: Hit[] = []
  const at = (re: RegExp) => folded.search(re)
  const approval = at(APPROVAL_RE)
  if (approval >= 0) hits.push({ signal: 'approval', index: approval })
  const change = at(CHANGE_RE)
  if (change >= 0) hits.push({ signal: 'change', index: change })
  const schedule = at(SCHEDULE_RE)
  const term = at(TERM_RE)
  // „termín" sám nestačí (domlouvání schůzky); s datem je to posun nebo potvrzení termínu.
  const hasDate = folded.search(DATE_NUMERIC_ONE) >= 0 || folded.search(DATE_WORDS_ONE) >= 0
  if (schedule >= 0) hits.push({ signal: 'schedule', index: schedule })
  else if (term >= 0 && hasDate) hits.push({ signal: 'schedule', index: term })
  const attachment = at(ATTACHMENT_RE)
  if (attachment >= 0) hits.push({ signal: 'attachment', index: attachment })
  return hits
}

/**
 * Konec věty: `!`, `?`, nový řádek, nebo tečka následovaná mezerou a velkým
 * písmenem (nebo koncem textu). Tečka v „5. 10.", „klient.cz" nebo „např. tam"
 * věta nekončí — jinak by úryvek useknul datum i adresu.
 */
function isBoundary(text: string, i: number): boolean {
  const ch = text[i]
  if (ch === '!' || ch === '?' || ch === '\n') return true
  if (ch !== '.') return false
  const rest = text.slice(i + 1, i + 8)
  return rest === '' || /^\s*$/.test(rest) || /^\s+\p{Lu}/u.test(rest)
}

const SENTENCE_LOOKBACK = 200
const SENTENCE_LOOKAHEAD = 250

/** Věta kolem indexu (nejvýš cca 450 znaků), beze změn textu; `open` = useknutá kvůli limitu. */
function sentenceAround(text: string, index: number): { text: string; open: boolean } {
  let start = index
  while (start > 0 && index - start < SENTENCE_LOOKBACK && !isBoundary(text, start - 1)) start--
  let end = index
  while (end < text.length && end - index < SENTENCE_LOOKAHEAD && !isBoundary(text, end)) end++
  const open = end < text.length && !isBoundary(text, end)
  if (end < text.length && isBoundary(text, end) && text[end] !== '\n') end++
  return { text: text.slice(start, end), open }
}

/** Věta kolem indexu, nejvýš `max` znaků, bez adres a dlouhých čísel. */
export function excerptAround(text: string, index: number, max = MAIL_CONTENT_EXCERPT_MAX): string {
  const sentence = sentenceAround(text, index)
  let piece = maskPersonalData(collapse(sentence.text))
  if (piece.length === 0) return ''
  // Useknutá věta (limit nebo délka) končí výpustkou; celek nikdy nepřesáhne `max` (CHECK v 0091).
  if (piece.length > max || sentence.open) piece = `${piece.slice(0, max - 1).trimEnd()}…`
  return piece
}

/** Prvních `max` znaků nejnovější části; prázdný text = „(zpráva bez textu)". */
export function excerptHead(text: string, max = MAIL_CONTENT_EXCERPT_MAX): string {
  const clean = maskPersonalData(collapse(text))
  if (clean.length === 0) return MAIL_CONTENT_EMPTY_EXCERPT
  return clean.length > max ? `${clean.slice(0, max - 1).trimEnd()}…` : clean
}

export function recognizeContent(input: {
  subject: string
  /** Nejnovější část těla (latestReplyText). */
  text: string
  hasAttachments: boolean
  receivedAt: Date
}): Recognition {
  // Adresy a dlouhá čísla pryč hned: nic z nich se nedostane do úryvku ani do data.
  const scan = maskPersonalData(input.text.slice(0, MAIL_CONTENT_SCAN_MAX))
  const bodyHits = firstHits(fold(scan))
  const subjectHits = firstHits(fold(input.subject))
  const set = new Set<MailSignal>([...bodyHits.map((h) => h.signal), ...subjectHits.map((h) => h.signal)])
  if (input.hasAttachments) set.add('attachment')
  const signals = MAIL_SIGNALS.filter((s) => set.has(s))
  const primary = PRIORITY.find((s) => set.has(s)) ?? null

  const anchor = primary ? bodyHits.find((h) => h.signal === primary) : undefined
  const excerpt = (anchor ? excerptAround(scan, anchor.index) : '') || excerptHead(scan)

  const schedule = bodyHits.find((h) => h.signal === 'schedule')
  const proposedDate = signals.includes('schedule')
    ? extractSingleDate(schedule ? sentenceAround(scan, schedule.index).text : scan.slice(0, 600), input.receivedAt)
    : null
  return { signals, primary, excerpt, proposedDate }
}

/** Předmět do řádku: čistý text, nejvýš 200 znaků, prázdný = null. */
export function cleanSubject(subject: string): string | null {
  const s = collapse(sanitizeUntrustedText(subject, 1_000).text)
  if (s.length === 0) return null
  return s.length > MAIL_CONTENT_SUBJECT_MAX ? `${s.slice(0, MAIL_CONTENT_SUBJECT_MAX - 1).trimEnd()}…` : s
}

/** Názvy příloh do řádku: čisté, nejvýš 10 po 120 znacích. */
export function cleanAttachmentNames(names: readonly string[]): string[] {
  return names
    .map((n) => collapse(sanitizeUntrustedText(n, 500).text))
    .filter((n) => n.length > 0)
    .slice(0, MAIL_CONTENT_ATTACHMENTS_MAX)
    .map((n) => (n.length > MAIL_CONTENT_ATTACHMENT_NAME_MAX ? `${n.slice(0, MAIL_CONTENT_ATTACHMENT_NAME_MAX - 1)}…` : n))
}

// ---------------------------------------------------------------------------
// Ke komu zpráva patří

export type AccountMatchData = {
  contacts: readonly MatchContact[]
  aliases: readonly MatchAlias[]
  accounts: readonly MatchAccount[]
}

export type AccountResolution =
  | { status: 'matched'; accountId: number; method: Exclude<MailMatchMethod, 'manual'> }
  | { status: 'ambiguous' }
  | { status: 'none' }

/** Doména protistrany (u příchozí odesílatel, u naší odchozí první externí příjemce); jen doména, nikdy adresa. */
export function counterpartDomain(msg: Pick<ContentMessage, 'from' | 'to' | 'cc'>, ourDomain: string = OUR_DOMAIN): string | null {
  const ours = ourDomain.toLowerCase()
  const candidates = msg.from && domainOf(msg.from) !== ours ? [msg.from] : [...msg.to, ...msg.cc]
  for (const c of candidates) {
    const d = domainOf(c)
    if (d && d !== ours) return d.length <= MAIL_CONTENT_DOMAIN_MAX ? d : null
  }
  return null
}

function counterparts(msg: Pick<ContentMessage, 'from' | 'to' | 'cc'>, ourDomain: string): string[] {
  const ours = ourDomain.toLowerCase()
  if (msg.from && domainOf(msg.from) !== ours) return [msg.from]
  return [...msg.to, ...msg.cc].filter((a) => domainOf(a) !== ours)
}

/**
 * Klient podle odesílatele: kontakt, doména, alias (mailMatch), pak web klienta
 * a nakonec název nebo IČO v předmětu. Víc kandidátů = ambiguous; nic = none.
 */
export function resolveAccount(
  msg: Pick<ContentMessage, 'from' | 'to' | 'cc' | 'subject'>,
  data: AccountMatchData,
  ourDomain: string = OUR_DOMAIN,
): AccountResolution {
  const people = counterparts(msg, ourDomain)
  const contacts: MailContact[] = data.contacts.map((c, i) => ({ id: i + 1, email: c.email, account_id: c.account_id }))
  const aliases: MailAlias[] = data.aliases
    .filter((a): a is MatchAlias & { alias_domain: string } => !!a.alias_domain)
    .map((a) => ({ domain: a.alias_domain, account_id: a.account_id }))

  const mail = matchMail({ direction: 'inbound', counterparts: people, contacts, aliases, ourDomain })
  if (mail.status === 'matched') {
    if (mail.contact_id != null) return { status: 'matched', accountId: mail.account_id, method: 'contact' }
    const d = people[0] ? domainOf(people[0]) : null
    const viaAlias = d != null && aliases.some((a) => a.domain.toLowerCase().replace(/^@/, '') === d) &&
      !contacts.some((c) => domainOf(c.email.toLowerCase()) === d)
    return { status: 'matched', accountId: mail.account_id, method: viaAlias ? 'alias' : 'domain' }
  }
  if (mail.status === 'ambiguous') return { status: 'ambiguous' }

  const base = { accounts: data.accounts, aliases: data.aliases, contacts: data.contacts }
  if (people.length > 0) {
    const byWeb = matchNoteToAccount({ clientHint: people[0], title: null, text: '', ...base })
    if (byWeb.status === 'matched') return { status: 'matched', accountId: byWeb.accountId, method: 'domain' }
    if (byWeb.status === 'ambiguous') return { status: 'ambiguous' }
  }
  const bySubject = matchNoteToAccount({ clientHint: null, title: msg.subject, text: '', ...base })
  if (bySubject.status === 'matched') return { status: 'matched', accountId: bySubject.accountId, method: 'name' }
  if (bySubject.status === 'ambiguous') return { status: 'ambiguous' }
  return { status: 'none' }
}

// ---------------------------------------------------------------------------
// Dodávka nebo obchod, milník

export type TargetOption = {
  kind: 'engagement' | 'deal'
  id: number
  /** Název dodávky (název obchodu, jinak druh) nebo obchodu. */
  label: string
  /** U dodávky obchod, ze kterého vznikla; u obchodu jeho id. */
  dealId: number | null
}

export type TargetChoice =
  | { status: 'chosen'; target: TargetOption; how: 'named' | 'only' }
  /** Klient nemá žádnou otevřenou dodávku ani obchod: návrh míří na klienta. */
  | { status: 'none' }
  | { status: 'ambiguous'; options: TargetOption[] }

const MIN_LABEL_FOLDED = 4

const words = (s: string): string => ` ${fold(s).replace(/[^a-z0-9]+/g, ' ').trim()} `

function namedIn(haystack: string, options: readonly TargetOption[]): TargetOption[] {
  const found = options.filter((o) => {
    const key = words(o.label).trim()
    return key.length >= MIN_LABEL_FOLDED && haystack.includes(` ${key} `)
  })
  // „Workshop" i „Workshop pro vedení" v textu: delší název je přesnější.
  return found.filter(
    (o) => !found.some((p) => p !== o && words(p.label).length > words(o.label).length && words(p.label).includes(words(o.label).trimEnd())),
  )
}

/**
 * Které dodávky nebo obchodu se zpráva týká: název v předmětu, pak v textu;
 * jediný kandidát u klienta; jinak nejednoznačné (fronta).
 */
export function chooseTarget(options: readonly TargetOption[], subject: string, text: string): TargetChoice {
  if (options.length === 0) return { status: 'none' }
  for (const haystack of [words(subject), words(text.slice(0, MAIL_CONTENT_SCAN_MAX))]) {
    const named = namedIn(haystack, options)
    if (named.length === 1) return { status: 'chosen', target: named[0], how: 'named' }
    if (named.length > 1) return { status: 'ambiguous', options: [...options] }
  }
  if (options.length === 1) return { status: 'chosen', target: options[0], how: 'only' }
  return { status: 'ambiguous', options: [...options] }
}

export type MilestoneOption = { id: number; title: string; status: string; dueOn: string | null }

const CLOSED_MILESTONE = new Set(['prijato', 'uzavreno'])

/**
 * Milník dodávky, o kterém zpráva je: název v předmětu nebo textu; u schválení
 * jediný milník ve stavu „čeká na schválení". Jinak null (návrh to řekne).
 */
export function chooseMilestone(
  milestones: readonly MilestoneOption[],
  signals: readonly MailSignal[],
  subject: string,
  text: string,
): MilestoneOption | null {
  const open = milestones.filter((m) => !CLOSED_MILESTONE.has(m.status))
  const asTargets = open.map((m): TargetOption => ({ kind: 'engagement', id: m.id, label: m.title, dealId: null }))
  for (const haystack of [words(subject), words(text.slice(0, MAIL_CONTENT_SCAN_MAX))]) {
    const named = namedIn(haystack, asTargets)
    if (named.length === 1) return open.find((m) => m.id === named[0].id) ?? null
    if (named.length > 1) return null
  }
  if (signals.includes('approval')) {
    const waiting = open.filter((m) => m.status === 'ceka_na_schvaleni')
    if (waiting.length === 1) return waiting[0]
  }
  return null
}

// ---------------------------------------------------------------------------
// Návrh

export const MAIL_CONTENT_KINDS = ['approval', 'schedule', 'change', 'attachment', 'review'] as const
export type MailContentKind = (typeof MAIL_CONTENT_KINDS)[number]

/** Hodnoty case_proposal.capability; nejvýš jeden čekající návrh na (druh, klient, uzel). */
export const MAIL_CONTENT_CAPABILITIES: Readonly<Record<MailContentKind, string>> = {
  approval: 'mail_content_approval',
  schedule: 'mail_content_schedule',
  change: 'mail_content_change',
  attachment: 'mail_content_attachment',
  review: 'mail_content_review',
}

export function isMailContentCapability(capability: string): boolean {
  return (Object.values(MAIL_CONTENT_CAPABILITIES) as string[]).includes(capability)
}

/** Druh návrhu podle příznaků: změna > termín > schválení > přílohy > k posouzení. */
export function proposalKind(signals: readonly MailSignal[]): MailContentKind {
  return PRIORITY.find((s) => signals.includes(s)) ?? 'review'
}

const KIND_TITLE: Record<MailContentKind, string> = {
  approval: 'Schválení od klienta',
  schedule: 'Posun termínu od klienta',
  change: 'Změna od klienta',
  attachment: 'Podklady od klienta',
  review: 'Zpráva klienta k posouzení',
}

const DAY_FMT = new Intl.DateTimeFormat('cs-CZ', { timeZone: COMPANY.timeZone, day: 'numeric', month: 'numeric', year: 'numeric' })
const dmy = (iso: string): string => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? iso : DAY_FMT.format(d)
}

const cut = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1).trimEnd()}…` : s)

export type MailContentProposalInput = {
  signals: readonly MailSignal[]
  accountName: string
  target: TargetOption | null
  /** Dodávka/obchod nešly určit jednoznačně (člověk zvolil jen klienta). */
  targetUnclear: boolean
  milestone: MilestoneOption | null
  proposedDate: string | null
  receivedAt: string
  attachmentNames: readonly string[]
  /** Krátké shrnutí od modelu (jen s MAIL_CONTENT_AI_ENABLED). */
  aiSummary?: string | null
}

export type MailContentProposal = {
  kind: MailContentKind
  capability: string
  title: string
  rationale: string
  steps: string[]
}

/**
 * NÁVRH pracovního případu ze zprávy. Zdůvodnění NENESE úryvek ani znění
 * zprávy (návrh vidí celý tým, úryvek jen obchodní role) — jen co bylo
 * rozpoznáno, ke komu a čemu to míří. Kroky jsou věty pro člověka, ne příkazy.
 */
export function buildMailContentProposal(a: MailContentProposalInput): MailContentProposal {
  const kind = proposalKind(a.signals)
  const what = a.milestone?.title ?? a.target?.label ?? null
  const title = cut(`${KIND_TITLE[kind]}: ${what ? `${what} — ` : ''}${a.accountName}`, 300)

  const parts: string[] = [
    `Zpráva ze složky Cockpit z ${dmy(a.receivedAt)}${a.signals.length > 0 ? ` (rozpoznáno: ${a.signals.map((s) => MAIL_SIGNAL_LABEL[s]).join(', ')})` : ' (nic konkrétního nerozpoznáno)'}.`,
  ]
  if (a.target) parts.push(`${a.target.kind === 'engagement' ? 'Dodávka' : 'Obchod'}: ${a.target.label}.`)
  else if (a.targetUnclear) parts.push('Dodávka ani obchod nebyly jednoznačné, urči je při přijetí.')
  if (a.milestone) parts.push(`Milník: ${a.milestone.title}.`)
  if (a.proposedDate) parts.push(`Datum z textu: ${dmy(`${a.proposedDate}T12:00:00Z`)} (ověř ve zprávě).`)
  if (a.attachmentNames.length > 0) {
    parts.push(`Přílohy (jen názvy): ${cut(a.attachmentNames.slice(0, 3).join(', '), 200)}${a.attachmentNames.length > 3 ? ' a další' : ''}.`)
  }
  if (a.aiSummary) parts.push(`Shrnutí AI: ${cut(a.aiSummary, 300)}`)
  parts.push('Úryvek ze zprávy vidí vedení a obchod, doklad je odkaz na zprávu v Outlooku. Jen návrh, nic se samo nezměnilo.')
  const rationale = cut(parts.join(' '), 1000)

  const m = a.milestone?.title
  let steps: string[]
  switch (kind) {
    case 'approval':
      steps = [
        'Ověřit ve zprávě, že klient výstup opravdu schválil',
        m ? `U milníku „${cut(m, 120)}“ zapsat přijetí s odkazem na zprávu` : 'Určit, kterého milníku se schválení týká, a zapsat přijetí s odkazem na zprávu',
        'Potvrdit klientovi další krok',
      ]
      break
    case 'schedule':
      steps = [
        `Ověřit ve zprávě, jaký termín klient navrhuje${a.proposedDate ? ` (z textu: ${dmy(`${a.proposedDate}T12:00:00Z`)})` : ''}`,
        m ? `Posunout termín milníku „${cut(m, 120)}“, pokud s tím souhlasíme` : 'Určit, kterého milníku se posun týká, a posunout jeho termín',
        'Domluvit dopad na navazující práci a odpovědět klientovi',
      ]
      break
    case 'change':
      steps = [
        'Přečíst požadavek klienta ve zprávě',
        'Posoudit dopad na rozsah, termín a cenu',
        'Odpovědět klientovi a podle výsledku upravit milník nebo úkol',
      ]
      break
    case 'attachment':
      steps = [
        `Prohlédnout přílohy${a.attachmentNames.length > 0 ? `: ${cut(a.attachmentNames.slice(0, 3).join(', '), 150)}` : ''}`,
        'Zařadit podklady k dodávce nebo obchodu',
      ]
      break
    default:
      steps = ['Přečíst zprávu v Outlooku a rozhodnout o dalším kroku']
  }
  return { kind, capability: MAIL_CONTENT_CAPABILITIES[kind], title, rationale, steps }
}
