// Automatické založení poptávky z příchozího e-mailu — PRAVIDLA jistoty.
// Čisté funkce bez I/O (zápis a čtení dat je v domain/crm/autoIntakeService.ts,
// atomické založení v migraci 0081). Návod pro provoz: docs/PROVOZ.md.
//
// CO SE STANE S PŘÍCHOZÍ ZPRÁVOU OD NEZNÁMÉ DOMÉNY
//   Zpráva projde sadou pravidel (decideIntake) a skončí jednou ze čtyř cest:
//     skip     nic se nestane (interní adresa, freemail, partner, no-reply,
//              hromadná pošta, dřív zamítnutá doména, stará zpráva…)
//     auto     VYSOKÁ jistota → klient + alias domény + kontakt + otevřený
//              obchod v Kvalifikaci + úkol; člověk jen vidí výsledek a může
//              dát „Není poptávka" (Zpět)
//     propose  NIŽŠÍ jistota → návrh ke schválení (case_proposal), nic se
//              nezakládá, dokud ho člověk nepřijme
//     known    doména už v CRM je (jen podle webu klienta) → žádný druhý
//              klient, jen aktivita u něj
//
// VYSOKÁ JISTOTA = všech jedenáct podmínek zároveň (jinak návrh):
//   1 firemní doména (ne freemail), 2 doména v CRM nikde není, 3 ne interní
//   doména a ne partner, 4 ne dříve zamítnutá doména a k doméně není žádný
//   návrh, 5 odesílatel není automat (no-reply, newsletter, notifikace…)
//   ani platforma hromadné pošty, 6 odesílatel je konkrétní člověk (ne
//   info@, obchod@…), 7 zpráva přišla přímo na schránku vlastníka (v To),
//   8 není hromadná (nejvýš maxAutoRecipients příjemců), 9 mezi příjemci
//   není další externí adresa (ani jiný klient), 10 zpráva není stará,
//   11 firma ve jménu odesílatele sedí s jeho doménou (rozpor = někdo se může
//   vydávat za cizí firmu, viz senderCompanyMismatch). SPF/DKIM/DMARC se
//   nekontroluje: Cockpit ty hlavičky ve metadatech nemá.
//
// SOUKROMÍ — vědomá výjimka z „pošta jsou jen metadata"
//   Sync pošty (mailSync.ts, mail_event) dál ukládá jen směr, čas, firmu
//   a doménu; předmět ani tělo se nečtou nikdy. Tenhle modul ale u VYSOKÉ
//   jistoty potřebuje jméno odesílatele z hlavičky a jeho adresu, aby
//   vznikl kontakt — přesně to, co by člověk opsal ručně. Důvod výjimky:
//   je to obchodní poptávka poslaná přímo majiteli schránky z firemní
//   adresy, takže účel (odpovědět, evidovat kontakt) je zjevný; a je
//   vratná („Není poptávka" kontakt smaže). Mimo to platí:
//     * jméno a adresa žijí jen v paměti jednoho běhu (IntakeCandidate) a
//       zapíšou se JEN do contact u vysoké jistoty; do mail_event, návrhu,
//       logu, statistik běhu ani auditu nejdou nikdy (auditu jen názvem sloupce);
//     * freemail a nejistý odesílatel po sobě nezanechá nic víc než dnes;
//     * návrh nižší jistoty nese jen doménu, žádné jméno ani adresu.
//   Text z hlavičky je nedůvěryhodný vstup: čistí se (sanitizeUntrustedText),
//   zkracuje a nikdy se nepředává modelu — pravidla jsou deterministická.

import type { AutoIntakeConfig } from '@/core/tenant'
import { sanitizeUntrustedText } from '@/core/untrusted'
import { FREEMAIL, domainOf } from '@/domain/crm/meetingMatch'
import { addDaysToPragueDay, pragueDayOf } from '@/lib/pragueDate'
import { categoryForLine } from '@/lib/validation/schemas'

// ---------------------------------------------------------------------------
// Konstanty

/** case_proposal.capability návrhů nižší jistoty (CHECK v 0067: ^[a-z][a-z0-9_]{0,63}$). */
export const AUTO_INTAKE_CAPABILITY = 'mail_new_inquiry'
export const AUTO_INTAKE_LABEL = 'Nová poptávka z e-mailu'
/** Aktér automatu v auditu (hlavička x-cockpit-audit-actor → 'system:auto_intake'). */
export const AUTO_INTAKE_ACTOR = 'auto_intake'
/** sales_activity.source aktivity, kterou automat zakládá (idempotence přes external_id = Message-ID). */
export const AUTO_INTAKE_ACTIVITY_SOURCE = 'auto_intake'
/** Zdroj návrhu (source klíče události) a typ události: jeden návrh na doménu. */
export const AUTO_INTAKE_PROPOSAL_SOURCE = 'outlook:inbox'
export const AUTO_INTAKE_PROPOSAL_EVENT_TYPE = 'inquiry.domain'
/** Označení „vzniklo automaticky" — text v poznámkách a předmětu aktivity. */
export const AUTO_INTAKE_MARK = 'Vzniklo automaticky z e-mailu'

export const AUTO_INTAKE_MIGRATION_PENDING_MESSAGE = 'Automatické zakládání poptávek čeká na migraci 0081.'

/** Strop, aby překlep v env nevypnul ochranu proti zaplavení. */
export const AUTO_INTAKE_MAX_DAILY_LIMIT = 200
/** Kolik kandidátů z jednoho běhu se zpracuje (první sync stáhne historii). */
export const AUTO_INTAKE_MAX_CANDIDATES_PER_RUN = 100
/** Kolik návrhů nižší jistoty smí vzniknout z jednoho běhu. */
export const AUTO_INTAKE_MAX_PROPOSALS_PER_RUN = 20

const DAY_MS = 86_400_000

// ---------------------------------------------------------------------------
// Freemail a další pomocné množiny

// Sync pošty používá menší seznam (FREEMAIL v meetingMatch.ts) — u zakládání
// klienta musí být přísnější: yahoo.com nebo post.cz nesmí být „firma".
const EXTRA_FREEMAIL = [
  'yahoo.com', 'yahoo.cz', 'ymail.com', 'live.com', 'live.cz', 'msn.com', 'outlook.cz', 'hotmail.cz', 'hotmail.co.uk',
  'post.cz', 'atlas.cz', 'tiscali.cz', 'quick.cz', 'iol.cz', 'gmx.com', 'gmx.de', 'gmx.at', 'gmx.net', 'web.de', 't-online.de',
  'aol.com', 'mail.com', 'proton.me', 'pm.me', 'protonmail.ch', 'me.com', 'mac.com', 'googlemail.com', 'zoho.com',
  'yandex.com', 'yandex.ru', 'mail.ru', 'seznam.sk', 'zoznam.sk', 'azet.sk', 'centrum.sk', 'post.sk', 'pobox.com',
  'fastmail.com', 'tutanota.com', 'tuta.io', 'o2.pl', 'wp.pl', 'interia.pl', 'onet.pl',
]
export const INTAKE_FREEMAIL: ReadonlySet<string> = new Set([...FREEMAIL, ...EXTRA_FREEMAIL])

// Adresa, ze které nepíše člověk. Porovnává se část před zavináčem bez
// diakritiky, malými písmeny; oddělovače (. _ -) se ignorují.
const AUTOMATED_LOCAL = new Set([
  'noreply', 'donotreply', 'noresponse', 'mailerdaemon', 'postmaster', 'bounce', 'bounces', 'newsletter', 'newsletters',
  'news', 'notification', 'notifications', 'notify', 'alert', 'alerts', 'automat', 'automatic', 'automated', 'system',
  'robot', 'bot', 'daemon', 'update', 'updates', 'digest', 'marketing', 'mailing', 'campaign', 'promo', 'billing',
  'invoice', 'invoices', 'faktury', 'faktura', 'receipt', 'receipts', 'order', 'orders', 'objednavky', 'objednavka',
  'unsubscribe', 'reply', 'mail', 'email', 'info-noreply', 'security', 'account', 'accounts', 'donotreplay',
])

// Obecná firemní schránka: firma je skutečná, ale nepíše konkrétní člověk.
const ROLE_LOCAL = new Set([
  'info', 'office', 'obchod', 'sales', 'kontakt', 'contact', 'podpora', 'support', 'hello', 'ahoj', 'sekretariat',
  'sekretarka', 'recepce', 'reception', 'poptavka', 'poptavky', 'admin', 'administrativa', 'team', 'tym', 'hr', 'jobs',
  'kariera', 'servis', 'service', 'zakaznik', 'zakaznicky', 'ucetni', 'accounting', 'finance', 'it', 'helpdesk', 'web',
  'webmaster', 'business', 'obchodni', 'vedeni', 'reditel', 'management', 'zakazky', 'nabidky', 'dispecink', 'sklad',
])

const foldAscii = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
const compactLocal = (local: string): string => foldAscii(local).replace(/[._-]+/g, '').replace(/\d+$/g, '')

/** Domény o dvou částech (co.uk, com.au…), u kterých není TLD jen poslední nálepka. */
const TWO_PART_TLD = new Set(['co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'com.au', 'co.nz', 'co.jp', 'com.br', 'com.pl'])

/** Je `domain` jednou z `set` nebo její subdoménou (mail.acme.cz ⊂ acme.cz)? */
export function inDomainSet(domain: string, set: ReadonlySet<string>): boolean {
  if (set.has(domain)) return true
  const parts = domain.split('.')
  for (let i = 1; i < parts.length - 1; i++) if (set.has(parts.slice(i).join('.'))) return true
  return false
}

// ---------------------------------------------------------------------------
// Kandidát: zpráva z Outlooku, jak ji vidí pravidla (jen v paměti jednoho běhu)

export type IntakeMatchStatus = 'unknown' | 'ambiguous'

export type IntakeCandidate = {
  /** RFC 5322 Message-ID — klíč idempotence. */
  messageId: string
  occurredAt: string
  /** Odkaz zpět do Outlooku (jen povolení hostitelé, viz sanitizeMailWebLink). */
  webLink: string | null
  fromAddress: string
  /** Jméno z hlavičky Od, očištěné; null = žádné použitelné. */
  fromName: string | null
  to: readonly string[]
  cc: readonly string[]
  /** Jak dopadlo párování v syncu: doména neznámá / patří víc firmám. */
  matchStatus: IntakeMatchStatus
}

type Addr = { emailAddress?: { address?: string | null; name?: string | null } | null } | null | undefined

/** Tvar zprávy z Graphu, který kandidát potřebuje (strukturálně, ať není kruhový import). */
export type IntakeMessageLike = {
  internetMessageId?: string | null
  receivedDateTime?: string | null
  from?: Addr
  toRecipients?: readonly Addr[] | null
  ccRecipients?: readonly Addr[] | null
}

const ADDRESS_RE = /^[^\s@<>"',;]+@[^\s@<>"',;]+\.[^\s@<>"',;]{2,}$/

function normAddress(a: Addr): string | null {
  const raw = a?.emailAddress?.address
  if (typeof raw !== 'string') return null
  const e = raw.trim().toLowerCase()
  return ADDRESS_RE.test(e) ? e : null
}

/**
 * Jméno z hlavičky Od → použitelné jméno, nebo null. Text je od cizího
 * odesílatele: očistí se od neviditelných znaků, zkrátí a zahodí, když
 * vypadá jako adresa, odkaz nebo značka.
 */
export function cleanDisplayName(raw: unknown, address: string | null): string | null {
  if (typeof raw !== 'string') return null
  const text = sanitizeUntrustedText(raw, 200).text
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/^[\s"'`]+|[\s"'`]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  if (text.length < 2) return null
  if (/[@<>]|https?:|www\./i.test(text)) return null
  if (address && text.toLowerCase() === address) return null
  if (!/\p{L}/u.test(text)) return null
  return text
}

/**
 * Zpráva ze syncu → kandidát, nebo null, když nejde o příchozí zprávu se
 * čitelným odesílatelem a časem. Volá se JEN u zpráv, které sync nespároval
 * (unknown / ambiguous), a jen když je zakládání zapnuté.
 */
export function intakeCandidateFromMessage(
  msg: IntakeMessageLike,
  matchStatus: IntakeMatchStatus,
  webLink: string | null,
): IntakeCandidate | null {
  const messageId = typeof msg.internetMessageId === 'string' ? msg.internetMessageId.trim() : ''
  if (!messageId || messageId.length > 700) return null
  const at = msg.receivedDateTime
  if (!at || !Number.isFinite(Date.parse(at))) return null
  const fromAddress = normAddress(msg.from)
  if (!fromAddress) return null
  const list = (xs: readonly Addr[] | null | undefined): string[] =>
    [...new Set((xs ?? []).map(normAddress).filter((a): a is string => a !== null))]
  return {
    messageId,
    occurredAt: new Date(at).toISOString(),
    webLink,
    fromAddress,
    fromName: cleanDisplayName(msg.from?.emailAddress?.name, fromAddress),
    to: list(msg.toRecipients),
    cc: list(msg.ccRecipients),
    matchStatus,
  }
}

// ---------------------------------------------------------------------------
// Odesílatel: automat, obecná schránka, konkrétní člověk

export function looksAutomated(address: string, name: string | null): boolean {
  const local = address.slice(0, address.lastIndexOf('@'))
  const compact = compactLocal(local)
  if (AUTOMATED_LOCAL.has(compact)) return true
  if (/no-?reply|do-?not-?repl|mailer-daemon|bounce/i.test(local)) return true
  if (name && /newsletter|no-?reply|do not reply|notifikac|notification|upozorn[eě]n[ií]|automatick/i.test(foldAscii(name))) return true
  return false
}

export function isRoleAddress(address: string): boolean {
  const local = foldAscii(address.slice(0, address.lastIndexOf('@')))
  if (ROLE_LOCAL.has(compactLocal(local))) return true
  // „obchod.praha", „info-cz": první část je obecná schránka a za ní jen jedno slovo.
  const parts = local.split(/[._-]+/).filter(Boolean)
  return parts.length === 2 && ROLE_LOCAL.has(parts[0])
}

// Značky firmy ve jménu odesílatele (právní forma, oddělení).
const LEGAL_FORM_RES: readonly RegExp[] = [
  /\bspol\.\s?s\s?r\.\s?o\.?/i,
  /\bs\.\s?r\.\s?o\.?/i,
  /\ba\.\s?s\.?(?=$|[\s,;|)–—/-])/i,
  /\bk\.\s?s\.?(?=$|[\s,;|)–—/-])/i,
  /\bv\.\s?o\.\s?s\.?/i,
  /\bz\.\s?s\.?(?=$|[\s,;|)–—/-])/i,
  /\b(?:gmbh|ltd|inc|llc)\b\.?/i,
]
// Testuje se nad textem bez diakritiky (\b v JavaScriptu nezná „í").
const DEPARTMENT_RE = /\b(?:oddeleni|tym|team|support|podpora|obchod\w*|sales|office|info|marketing|recepce|sekretariat|servis|helpdesk)\b/
const isDepartment = (s: string): boolean => DEPARTMENT_RE.test(foldAscii(s))

export const hasLegalForm = (s: string): boolean => LEGAL_FORM_RES.some((re) => re.test(s))

const NAME_WORD_RE = /^\p{L}[\p{L}'’.-]*$/u

function nameWords(name: string): string[] {
  return name.split(/\s+/).filter((w) => w.replace(/[.'’-]/g, '').length >= 2 && NAME_WORD_RE.test(w))
}

/** Rozdělí jméno „Jan Novák | ACME s.r.o." na části podle | / – — a ' - '. */
function nameSegments(name: string): string[] {
  return name.split(/\s*[|/–—]\s*|\s+-\s+|\s*[()]\s*/).map((s) => s.trim()).filter(Boolean)
}

export type SenderKind = 'personal' | 'unclear' | 'role'

/**
 * Píše konkrétní člověk? 'personal' = jméno o aspoň dvou slovech (a není to
 * firma ani oddělení), nebo adresa tvaru jan.novak / j.novak; 'unclear' =
 * jedno slovo (jan@, novak@); 'role' = obecná schránka (info@, obchod@).
 */
export function senderKind(address: string, name: string | null): SenderKind {
  if (isRoleAddress(address)) return 'role'
  const segments = name ? nameSegments(name) : []
  const personSegment = segments.find((s) => !hasLegalForm(s) && !isDepartment(s) && nameWords(s).length >= 2)
  if (personSegment && nameWords(personSegment).length <= 4) return 'personal'
  const local = foldAscii(address.slice(0, address.lastIndexOf('@')))
  if (/^[a-z]{2,}[._-][a-z]{2,}$/.test(local) || /^[a-z][._-][a-z]{2,}$/.test(local) || /^[a-z]{2,}[._-][a-z]$/.test(local)) return 'personal'
  return 'unclear'
}

// ---------------------------------------------------------------------------
// Názvy: firma z jména odesílatele nebo z domény, jméno kontaktu

/** Jméno firmy odvozené z domény („acme-stroje.cz" → „Acme Stroje"). */
export function companyNameFromDomain(domain: string): string {
  const labels = domain.toLowerCase().split('.').filter(Boolean)
  let core = labels
  if (labels.length > 2 && TWO_PART_TLD.has(labels.slice(-2).join('.'))) core = labels.slice(0, -2)
  else if (labels.length > 1) core = labels.slice(0, -1)
  const slug = core[core.length - 1] || domain
  const words = slug.split(/[-_]+/).filter(Boolean).map((p) => p.charAt(0).toUpperCase() + p.slice(1))
  return words.join(' ') || domain
}

/** Firma z jména odesílatele: část s právní formou („Jan Novák | ACME s.r.o." → „ACME s.r.o."). */
export function companyNameFromSender(name: string | null): string | null {
  if (!name) return null
  for (const seg of nameSegments(name)) {
    if (!hasLegalForm(seg)) continue
    const words = seg.split(/\s+/)
    if (words.length < 2 || words.length > 8 || seg.length > 120) continue
    return seg
  }
  return null
}

// Slova ve jménu firmy, která nic neříkají o tom, jak se jmenuje doména.
const GENERIC_COMPANY_WORDS = new Set([
  'czech', 'cesko', 'ceska', 'cesky', 'republika', 'group', 'holding', 'international', 'global', 'company', 'europe',
  'services', 'service', 'solutions', 'praha', 'brno', 'the', 'and', 'for', 'sro', 'gmbh',
])

/** Registrovatelné jádro domény bez TLD a subdomén, bez oddělovačů („mail.acme-stroje.cz" → „acmestroje"). */
function domainCore(domain: string): string {
  const labels = domain.toLowerCase().split('.').filter(Boolean)
  let core = labels
  if (labels.length > 2 && TWO_PART_TLD.has(labels.slice(-2).join('.'))) core = labels.slice(0, -2)
  else if (labels.length > 1) core = labels.slice(0, -1)
  return foldAscii(core[core.length - 1] ?? '').replace(/[^a-z0-9]/g, '')
}

/**
 * Rozpor mezi firmou, za kterou se odesílatel ve jménu z hlavičky vydává
 * („Jan Novák | Skutečná Firma s.r.o."), a doménou, ze které píše. Jméno
 * z hlavičky si volí odesílatel sám, doména je to jediné, co nejde snadno
 * napsat cokoli. Bez ověření SPF/DKIM/DMARC (Cockpit ty hlavičky ve
 * metadatech nemá) je to jediná dostupná kontrola, že se někdo nevydává za
 * cizí firmu: takový mail jde jen jako návrh, ne automatem.
 *
 * `true` = jméno firmy z hlavičky obsahuje význačná slova a žádné z nich se
 * v doméně neobjevuje (ani naopak). Jméno bez firmy (jen člověk) rozpor
 * nemá: firma se pak odvozuje z domény.
 */
export function senderCompanyMismatch(fromName: string | null, domain: string): boolean {
  const company = companyNameFromSender(fromName)
  if (!company) return false
  let text = foldAscii(company)
  for (const re of LEGAL_FORM_RES) text = text.replace(new RegExp(re.source, 'gi'), ' ')
  const tokens = text.split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !GENERIC_COMPANY_WORDS.has(t))
  if (tokens.length === 0) return false
  const core = domainCore(domain)
  if (core.length < 2) return false
  return !tokens.some((t) => core.includes(t) || (core.length >= 3 && t.includes(core)))
}

/** Jméno firmy nového klienta: z odesílatele (má právní formu), jinak z domény. */
export function companyNameFor(candidate: Pick<IntakeCandidate, 'fromName'>, domain: string): string {
  return companyNameFromSender(candidate.fromName) ?? companyNameFromDomain(domain)
}

function nameFromLocal(address: string): string {
  const local = address.slice(0, address.lastIndexOf('@'))
  return local.split(/[._-]+/).filter(Boolean).map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join(' ') || address
}

/** Jméno kontaktu: osobní část jména z hlavičky, jinak z adresy („jan.novak" → „Jan Novak"). */
export function contactNameFor(candidate: Pick<IntakeCandidate, 'fromName' | 'fromAddress'>): string {
  const segments = candidate.fromName ? nameSegments(candidate.fromName) : []
  const person = segments.find((s) => !hasLegalForm(s) && !isDepartment(s) && nameWords(s).length >= 1)
  return (person ?? nameFromLocal(candidate.fromAddress)).slice(0, 200)
}

/**
 * Doména z pole „web" klienta („https://www.Acme.cz/kontakt" → „acme.cz"), nebo
 * null. Stejné pravidlo jako v auto_intake_found (0081): bez schématu, bez www,
 * jen hostitel.
 */
export function hostFromWeb(web: string | null | undefined): string | null {
  if (typeof web !== 'string') return null
  const t = web.trim()
  if (!t || /\s/.test(t)) return null
  try {
    const u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(t) ? t : `https://${t}`)
    const host = u.hostname.toLowerCase().replace(/^www\./, '')
    return host.includes('.') ? host : null
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Pracovní dny (po–pá; státní svátky se nepočítají)

const weekday = (day: string): number => new Date(`${day}T12:00:00Z`).getUTCDay()

/** Pražský den posunutý o `n` pracovních dnů (víkend se přeskočí). */
export function addBusinessDays(day: string, n: number): string {
  let d = day
  let left = Math.max(0, Math.floor(n))
  while (left > 0) {
    d = addDaysToPragueDay(d, 1)
    const w = weekday(d)
    if (w !== 0 && w !== 6) left--
  }
  return d
}

// ---------------------------------------------------------------------------
// Rozhodnutí

export type IntakeSkipReason =
  | 'stale'
  | 'invalid'
  | 'internal'
  | 'freemail'
  | 'partner'
  | 'automated'
  | 'automated_domain'
  | 'bulk'
  | 'not_addressed'
  | 'rejected'
  | 'has_proposal'
  | 'known_domain'

export const INTAKE_SKIP_LABELS: Record<IntakeSkipReason, string> = {
  stale: 'zpráva je starší než limit (první synchronizace stahuje historii)',
  invalid: 'chybí čitelná adresa odesílatele',
  internal: 'odesílatel je z interní domény',
  freemail: 'osobní e-mail (gmail, seznam…) bez firemní domény',
  partner: 'doména patří partnerovi',
  automated: 'automatická adresa (no-reply, newsletter, notifikace…)',
  automated_domain: 'odesílatel je platforma pro hromadnou poštu nebo notifikace',
  bulk: 'hromadná zpráva (hodně příjemců)',
  not_addressed: 'v hlavičce nejsme ani v To, ani v Cc (skrytá kopie, konference)',
  rejected: 'doménu jsme dřív zamítli („Není poptávka")',
  has_proposal: 'k doméně už existuje návrh',
  known_domain: 'doména už v CRM je a zpráva nesplňuje podmínky pro aktivitu',
}

/** Proč jde zpráva jen jako návrh (nižší jistota). */
export type IntakeCaution =
  | 'role_address'
  | 'unclear_person'
  | 'not_direct'
  | 'external_recipients'
  | 'many_recipients'
  | 'two_clients'
  | 'limit'
  | 'name_conflict'
  | 'name_domain_mismatch'

export const INTAKE_CAUTION_TEXT: Record<IntakeCaution, string> = {
  role_address: 'Píše obecná adresa firmy (typu info nebo obchod), ne konkrétní člověk.',
  unclear_person: 'Z adresy a jména odesílatele není jasné, jestli píše konkrétní člověk.',
  not_direct: 'Zpráva nepřišla přímo na naši schránku (jen v kopii).',
  external_recipients: 'Ve zprávě jsou i další externí příjemci.',
  many_recipients: 'Zpráva má víc příjemců, než je pro automat obvyklé.',
  two_clients: 'Ve zprávě vystupují dva klienti, nebo doména patří víc klientům — rozhodni, komu patří.',
  limit: 'Dnešní limit automatických založení je vyčerpaný.',
  name_conflict: 'V CRM už je firma se stejným názvem — ověř, jestli nejde o tu samou.',
  name_domain_mismatch: 'Jméno firmy v hlavičce odesílatele nesedí s jeho doménou — ověř, že nejde o cizí firmu.',
}

/** Kódy podmínek vysoké jistoty, které se ukládají do auto_intake.reasons (ne text zprávy). */
export type IntakeReason =
  | 'corporate_domain'
  | 'new_domain'
  | 'personal_sender'
  | 'direct_to_mailbox'
  | 'single_external_party'
  | 'not_bulk'

export type IntakeDecision =
  | { kind: 'skip'; reason: IntakeSkipReason }
  | {
      kind: 'auto'
      domain: string
      companyName: string
      contactName: string
      contactEmail: string
      reasons: IntakeReason[]
    }
  | { kind: 'known'; domain: string; accountId: number }
  | { kind: 'propose'; domain: string; cautions: IntakeCaution[]; relatedAccountIds: number[] }

/** Pravidla firmy, která rozhodování potřebuje (z AutoIntakeConfig). */
export type IntakeRules = Pick<
  AutoIntakeConfig,
  'maxAgeDays' | 'maxAutoRecipients' | 'bulkRecipients'
>

export type IntakeContext = {
  /** Naše domény: firemní pošta + interní domény z konfigurace. */
  ourDomains: ReadonlySet<string>
  /** Adresa schránky, kterou synchronizujeme; null = neznámá (pak nikdy „přímo"). */
  mailboxAddress: string | null
  partnerDomains: ReadonlySet<string>
  /** Domény, které člověk zamítl („Není poptávka", zamítnutý návrh). */
  rejectedDomains: ReadonlySet<string>
  /** Domény, ke kterým existuje návrh (jakéhokoli stavu) — o nich rozhoduje člověk. */
  proposedDomains: ReadonlySet<string>
  /** Doména → id klientů (kontakty, aliasy, web). */
  knownDomains: ReadonlyMap<string, readonly number[]>
  /** Celá adresa → id klienta (kontakty). */
  knownAddresses: ReadonlyMap<string, number>
  automatedDomains: ReadonlySet<string>
  rules: IntakeRules
  now: Date
}

const lower = (s: string): string => s.trim().toLowerCase()

/**
 * Rozhodne, co se zprávou udělat. Čistá funkce: stejný kandidát a kontext
 * dají vždy stejný výsledek (tabulka případů: test/auto-intake-rules.test.ts).
 * Pořadí kontrol je pořadí od „jistě ne" po „jistě ano".
 */
export function decideIntake(c: IntakeCandidate, ctx: IntakeContext): IntakeDecision {
  const skip = (reason: IntakeSkipReason): IntakeDecision => ({ kind: 'skip', reason })
  const from = lower(c.fromAddress)
  const domain = domainOf(from)
  if (!domain || !domain.includes('.') || domain.includes('..')) return skip('invalid')

  // 1) stáří: první synchronizace stáhne celou historii schránky
  const age = ctx.now.getTime() - Date.parse(c.occurredAt)
  if (!Number.isFinite(age) || age > ctx.rules.maxAgeDays * DAY_MS || age < -DAY_MS) return skip('stale')

  // 2) kdo nikdy není poptávka
  if (inDomainSet(domain, ctx.ourDomains)) return skip('internal')
  if (INTAKE_FREEMAIL.has(domain)) return skip('freemail')
  if (inDomainSet(domain, ctx.partnerDomains)) return skip('partner')
  if (looksAutomated(from, c.fromName)) return skip('automated')
  if (inDomainSet(domain, ctx.automatedDomains)) return skip('automated_domain')

  // 3) hromadná zpráva a zpráva, ve které nejsme vidět (skrytá kopie, konference)
  const recipients = [...new Set([...c.to, ...c.cc].map(lower))]
  if (recipients.length > ctx.rules.bulkRecipients) return skip('bulk')
  if (!recipients.some((r) => {
    const d = domainOf(r)
    return !!d && inDomainSet(d, ctx.ourDomains)
  })) return skip('not_addressed')

  // 4) člověk už rozhodl nebo rozhoduje
  if (ctx.rejectedDomains.has(domain)) return skip('rejected')
  if (ctx.proposedDomains.has(domain)) return skip('has_proposal')

  // 5) tvrdé podmínky vysoké jistoty; co nesedí, je důvod pro návrh
  const cautions: IntakeCaution[] = []
  const related = new Set<number>()

  const kind = senderKind(from, c.fromName)
  if (kind === 'role') cautions.push('role_address')
  else if (kind === 'unclear') cautions.push('unclear_person')

  const direct = ctx.mailboxAddress !== null && c.to.map(lower).includes(lower(ctx.mailboxAddress))
  if (!direct) cautions.push('not_direct')

  if (recipients.length > ctx.rules.maxAutoRecipients) cautions.push('many_recipients')

  const others = recipients.filter((r) => {
    if (r === from) return false
    const d = domainOf(r)
    return !!d && !inDomainSet(d, ctx.ourDomains)
  })
  if (others.length > 0) {
    cautions.push('external_recipients')
    for (const o of others) {
      const viaAddress = ctx.knownAddresses.get(o)
      const viaDomain = ctx.knownDomains.get(domainOf(o) ?? '') ?? []
      if (viaAddress !== undefined) related.add(viaAddress)
      for (const id of viaDomain) related.add(id)
    }
  }

  // 6) doména odesílatele v CRM: jeden klient → jen aktivita; víc klientů → člověk
  const known = ctx.knownDomains.get(domain) ?? []
  if (known.length > 1) {
    cautions.push('two_clients')
    for (const id of known) related.add(id)
  } else if (related.size > 0 && known.length === 0) {
    // Odesílatel je neznámý, ale v kopii je někdo, koho už známe.
    cautions.push('two_clients')
  } else if (c.matchStatus === 'ambiguous' && known.length < 2) {
    // Sync doménu označil za nejednoznačnou, tady ji vidíme jinak (souběh dat):
    // nikdy automat, rozhodne člověk.
    cautions.push('two_clients')
  }
  if (known.length === 1) return cautions.length === 0 ? { kind: 'known', domain, accountId: known[0] } : skip('known_domain')

  // Nová doména: firma z hlavičky musí sedět s doménou (jinak návrh, ne automat).
  if (senderCompanyMismatch(c.fromName, domain)) cautions.push('name_domain_mismatch')

  if (cautions.length > 0) {
    return { kind: 'propose', domain, cautions: [...new Set(cautions)], relatedAccountIds: [...related].sort((a, b) => a - b) }
  }
  return {
    kind: 'auto',
    domain,
    companyName: companyNameFor(c, domain),
    contactName: contactNameFor(c),
    contactEmail: from,
    reasons: ['corporate_domain', 'new_domain', 'personal_sender', 'direct_to_mailbox', 'single_external_party', 'not_bulk'],
  }
}

// ---------------------------------------------------------------------------
// Konfigurace: kontrola, limit, zapnutí

/** Chyby konfigurace firmy; neprázdné pole = automat se nespustí. */
export function autoIntakeConfigIssues(cfg: AutoIntakeConfig, nodes: readonly string[]): string[] {
  const issues: string[] = []
  const int = (v: unknown, min: number, max: number) => Number.isInteger(v) && (v as number) >= min && (v as number) <= max
  if (!nodes.includes(cfg.node)) issues.push(`uzel ${cfg.node} firma nemá`)
  if (!int(cfg.dailyLimit, 1, AUTO_INTAKE_MAX_DAILY_LIMIT)) issues.push(`dailyLimit musí být celé číslo 1–${AUTO_INTAKE_MAX_DAILY_LIMIT}`)
  if (!int(cfg.maxAgeDays, 1, 30)) issues.push('maxAgeDays musí být celé číslo 1–30')
  if (!int(cfg.maxAutoRecipients, 1, 10)) issues.push('maxAutoRecipients musí být celé číslo 1–10')
  if (!int(cfg.bulkRecipients, 2, 50) || cfg.bulkRecipients < cfg.maxAutoRecipients) {
    issues.push('bulkRecipients musí být celé číslo 2–50 a nejméně maxAutoRecipients')
  }
  if (!(cfg.revenueLine in categoryForLine)) issues.push(`neznámá obchodní linie: ${cfg.revenueLine}`)
  for (const [name, tpl] of [['dealTitleTemplate', cfg.dealTitleTemplate], ['taskTitleTemplate', cfg.taskTitleTemplate]] as const) {
    if (!tpl.includes('{firma}') || tpl.length > 200) issues.push(`${name} musí obsahovat {firma} a mít nejvýš 200 znaků`)
  }
  if (!cfg.proposalTitleTemplate.includes('{domena}') || cfg.proposalTitleTemplate.length > 200) {
    issues.push('proposalTitleTemplate musí obsahovat {domena} a mít nejvýš 200 znaků')
  }
  if (cfg.nextStep.trim() === '' || cfg.nextStep.length > 300) issues.push('nextStep je prázdný nebo delší než 300 znaků')
  if (!int(cfg.nextStepBusinessDays, 0, 10)) issues.push('nextStepBusinessDays musí být celé číslo 0–10')
  if (cfg.proposalSteps.length < 1 || cfg.proposalSteps.length > 10) issues.push('proposalSteps: kroků musí být 1–10')
  for (const s of cfg.proposalSteps) if (s.trim() === '' || s.length > 300) issues.push('krok návrhu je prázdný nebo delší než 300 znaků')
  for (const d of [...cfg.internalDomains, ...cfg.automatedDomains]) {
    if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/.test(d)) issues.push(`neplatná doména v konfiguraci: ${d}`)
  }
  return issues
}

/** Denní limit: env AUTO_INTAKE_DAILY_LIMIT (celé číslo 1–200) přebije konfiguraci; nesmysl se ignoruje. */
export function resolveDailyLimit(cfg: Pick<AutoIntakeConfig, 'dailyLimit'>, env: Record<string, string | undefined>): number {
  const raw = env.AUTO_INTAKE_DAILY_LIMIT?.trim()
  if (raw && /^\d+$/.test(raw)) {
    const n = Number(raw)
    if (n >= 1 && n <= AUTO_INTAKE_MAX_DAILY_LIMIT) return n
  }
  return cfg.dailyLimit
}

/** Přepínač zapnutí: automat běží jen s CAPABILITY_AUTO_INTAKE_ENABLED=true. */
export function autoIntakeEnabledFromEnv(env: Record<string, string | undefined>): boolean {
  return env.CAPABILITY_AUTO_INTAKE_ENABLED === 'true'
}

// ---------------------------------------------------------------------------
// Texty a vstup pro RPC auto_intake_found (0081)

const fill = (tpl: string, key: string, value: string): string => tpl.split(`{${key}}`).join(value).trim()
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s)

/** „29. 9. 2026" z okamžiku (pražský den). */
export function czDay(iso: string): string {
  const d = pragueDayOf(iso)
  return `${Number(d.slice(8, 10))}. ${Number(d.slice(5, 7))}. ${d.slice(0, 4)}`
}

export type FoundPayload = {
  message_id: string
  domain: string
  occurred_at: string
  today: string
  daily_limit: number
  owner_id: string
  evidence_id: number | null
  reasons: IntakeReason[]
  account: { name: string; notes: string }
  contact: { full_name: string; email: string }
  deal: {
    title: string
    revenue_line: string
    revenue_category: string
    stage: string
    next_step: string
    next_step_due: string
    note: string
  }
  task: { title: string; due_on: string; priority: 'high' }
  activity: { subject: string }
}

/**
 * Vstup pro RPC auto_intake_found. Texty říkají „vzniklo automaticky"
 * a co dál; nic z nich není obsah zprávy (ten se nečte).
 */
export function buildFoundPayload(args: {
  candidate: IntakeCandidate
  decision: Extract<IntakeDecision, { kind: 'auto' | 'known' }>
  companyName: string
  cfg: AutoIntakeConfig
  ownerId: string
  evidenceId: number | null
  dailyLimit: number
  now: Date
}): FoundPayload {
  const { candidate: c, decision, cfg, now } = args
  const today = pragueDayOf(now)
  const due = addBusinessDays(today, cfg.nextStepBusinessDays)
  const name = clip(args.companyName, 300)
  const mark = `${AUTO_INTAKE_MARK} (${czDay(c.occurredAt)}).`
  return {
    message_id: c.messageId,
    domain: decision.domain,
    occurred_at: c.occurredAt,
    today,
    daily_limit: args.dailyLimit,
    owner_id: args.ownerId,
    evidence_id: args.evidenceId,
    reasons: decision.kind === 'auto' ? decision.reasons : [],
    account: {
      name,
      notes: `${mark} Doména ${decision.domain}. Název odvozený z domény nebo odesílatele — ověř a doplň. Předmět ani obsah zprávy Cockpit nečte.`,
    },
    contact: {
      full_name: decision.kind === 'auto' ? decision.contactName : contactNameFor(c),
      email: decision.kind === 'auto' ? decision.contactEmail : lower(c.fromAddress),
    },
    deal: {
      title: fill(cfg.dealTitleTemplate, 'firma', name),
      revenue_line: cfg.revenueLine,
      revenue_category: categoryForLine[cfg.revenueLine as keyof typeof categoryForLine],
      stage: 'kvalifikace',
      next_step: cfg.nextStep,
      next_step_due: due,
      note: `${mark} Další krok: ${cfg.nextStep.toLowerCase()}.`,
    },
    task: { title: clip(fill(cfg.taskTitleTemplate, 'firma', name), 300), due_on: due, priority: 'high' },
    activity: { subject: `Příchozí e-mail — ${AUTO_INTAKE_MARK.toLowerCase()}` },
  }
}

// ---------------------------------------------------------------------------
// Návrh nižší jistoty (case_proposal)

export const INTAKE_TWO_CLIENTS_TITLE = 'E-mail se dvěma klienty — rozhodni, komu patří'

/** Klíč návrhu = jeden návrh na doménu (case_proposal UNIQUE (capability, source_key)). */
export function proposalSourceKey(domain: string): string {
  return `${AUTO_INTAKE_PROPOSAL_SOURCE}|${AUTO_INTAKE_PROPOSAL_EVENT_TYPE}|${domain}`
}

/** Doména z klíče návrhu (pro paměť zamítnutých domén); null, když klíč není náš. */
export function domainFromProposalKey(sourceKey: string): string | null {
  const prefix = `${AUTO_INTAKE_PROPOSAL_SOURCE}|${AUTO_INTAKE_PROPOSAL_EVENT_TYPE}|`
  return sourceKey.startsWith(prefix) ? sourceKey.slice(prefix.length) || null : null
}

/** Název a zdůvodnění návrhu. Nese jen doménu a pojmenované důvody — žádné jméno ani adresu. */
export function buildProposalText(
  domain: string,
  cautions: readonly IntakeCaution[],
  cfg: Pick<AutoIntakeConfig, 'proposalTitleTemplate'>,
  relatedNames: readonly string[] = [],
): { title: string; rationale: string } {
  const twoClients = cautions.includes('two_clients')
  const title = twoClients ? INTAKE_TWO_CLIENTS_TITLE : fill(cfg.proposalTitleTemplate, 'domena', domain)
  const bits = ['Neznámá firma nám napsala e-mail.', ...cautions.map((c) => INTAKE_CAUTION_TEXT[c])]
  if (twoClients && relatedNames.length > 0) bits.push(`Týká se: ${relatedNames.join(', ')}.`)
  bits.push(`Doména ${domain}. Automat zakládá klienta jen při vysoké jistotě.`)
  return { title: clip(title, 300), rationale: clip(bits.join(' '), 1000) }
}
