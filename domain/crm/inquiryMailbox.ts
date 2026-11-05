// Agent příchozích poptávek (P2) — schránky Gmailu a předfiltr zpráv.
// Čisté funkce bez I/O; čtení Gmailu a zápis do fronty jsou
// v domain/crm/inquiryMailboxService.ts.
//
// Které schránky: env INQUIRY_AGENT_MAILBOXES = adresy oddělené čárkou
// (schránka vedení, obchodu, případně vyhrazená poptavky@). Sdílená adresa
// info@ bývá v Google Workspace skupina nebo alias: zprávy pak chodí do
// schránek členů (přes skupinu s hlavičkou List-Id) — stejná zpráva u dvou
// lidí má jedno Message-ID a fronta ji vezme jednou (UNIQUE). Vyhrazená
// schránka s přeposíláním se čte jako každá jiná.
//
// Předfiltr (před voláním modelu, jen z hlaviček): vyřadí odeslané, koncepty,
// spam, interní poštu, automaty, hromadnou poštu a staré zprávy. Freemail
// (B2C) NEvyřazuje. Do fronty jdou jen identifikátory, nikdy obsah.
import { headerAddresses, type HeaderLike } from '@/core/agents/mailAuth'
import type { CaseProposalOutput, ProposalDraft } from '@/core/agents/template'
import { inDomainSet, looksAutomated } from './autoIntake'
import { INQUIRY_ESCALATION_CAPABILITY } from './inquiryAgent'

type Env = Record<string, string | undefined>

const EMAIL_RE = /^[^@\s,;<>"]+@[^@\s,;<>"]+\.[a-z]{2,}$/i

/** Adresy čtených schránek z env (malými písmeny, bez duplicit). */
export function inquiryMailboxesFromEnv(env: Env = process.env): string[] {
  return [...new Set((env.INQUIRY_AGENT_MAILBOXES ?? '').split(',').map((s) => s.trim().toLowerCase()).filter((s) => EMAIL_RE.test(s)))]
}

export function inquiryAgentEnabledFromEnv(env: Env = process.env): boolean {
  return env.INQUIRY_AGENT_ENABLED === 'true'
}

/** Klíč connector_state schránky (KEY_RE kontraktu konektorů: jen [a-z0-9_]). */
export function mailboxConnectorKey(mailbox: string, hash: (s: string) => string): string {
  return `gmail:inquiry:${hash(mailbox.toLowerCase()).slice(0, 16)}`
}

export type ScreenContext = {
  mailbox: string
  /** Domény firmy (interní pošta se vyřazuje). */
  companyDomains: readonly string[]
  /** Sdílené adresy poptávek (skupina, alias). */
  inquiryAddresses: readonly string[]
  /** Domény hromadných rozesílek a služeb (autoIntake.automatedDomains). */
  automatedDomains: readonly string[]
  maxAgeDays: number
  now: Date
}

export type ScreenSkip =
  | 'not_inbox'
  | 'no_sender'
  | 'internal'
  | 'automated'
  | 'bulk'
  | 'too_old'

export type InboundCandidate = {
  internetMessageId: string
  gmailMessageId: string
  threadId: string | null
  receivedAt: string
}

export type ScreenResult = { ok: true; candidate: InboundCandidate } | { ok: false; reason: ScreenSkip }

export type GmailMetaLike = { id: string; threadId: string | null; labelIds: readonly string[]; receivedAt: string | null; headers: readonly HeaderLike[] }

const values = (headers: readonly HeaderLike[], name: string) =>
  headers.filter((h) => h.name.toLowerCase() === name.toLowerCase()).map((h) => h.value.trim())

const SKIP_LABELS = new Set(['SENT', 'DRAFT', 'SPAM', 'TRASH', 'CHAT'])

/** List-Id skupiny Google („<info.firma.cz>") pro adresu skupiny. */
export function listIdForAddress(address: string): string {
  return address.toLowerCase().replace('@', '.')
}

function viaInquiryGroup(headers: readonly HeaderLike[], inquiryAddresses: readonly string[]): boolean {
  const lists = values(headers, 'List-Id').map((v) => (/<([^<>]+)>/.exec(v)?.[1] ?? v).trim().toLowerCase())
  return lists.some((l) => inquiryAddresses.some((a) => listIdForAddress(a) === l))
}

/** Předfiltr jedné zprávy (metadata z Gmailu). */
export function screenInboundMessage(m: GmailMetaLike, ctx: ScreenContext): ScreenResult {
  if (!m.labelIds.includes('INBOX') || m.labelIds.some((l) => SKIP_LABELS.has(l))) return { ok: false, reason: 'not_inbox' }

  const fromHeader = values(m.headers, 'From')
  const from = fromHeader.flatMap(headerAddresses)
  if (from.length === 0) return { ok: false, reason: 'no_sender' }
  const sender = from[0]
  const senderDomain = sender.slice(sender.lastIndexOf('@') + 1)
  const company = new Set(ctx.companyDomains.map((d) => d.toLowerCase()))
  const viaGroup = viaInquiryGroup(m.headers, ctx.inquiryAddresses)

  if (inDomainSet(senderDomain, company)) {
    // Skupina s přepisem From (DMARC): From = adresa skupiny, zákazník v Reply-To.
    // Takovou zprávu nevyřadíme — ověření odesílatele ji pošle člověku.
    const isGroupRewrite =
      ctx.inquiryAddresses.includes(sender) &&
      values(m.headers, 'Reply-To').flatMap(headerAddresses).some((a) => !inDomainSet(a.slice(a.lastIndexOf('@') + 1), company))
    if (!isGroupRewrite) return { ok: false, reason: 'internal' }
  }

  const name = /^\s*"?([^"<]*?)"?\s*</.exec(fromHeader[0] ?? '')?.[1]?.trim() || null
  const auto = values(m.headers, 'Auto-Submitted')[0]?.toLowerCase()
  if (
    looksAutomated(sender, name) ||
    inDomainSet(senderDomain, new Set(ctx.automatedDomains.map((d) => d.toLowerCase()))) ||
    (auto !== undefined && auto !== 'no') ||
    values(m.headers, 'X-Autoreply').length > 0 ||
    /\b(all|oof|autoreply)\b/i.test(values(m.headers, 'X-Auto-Response-Suppress')[0] ?? '')
  ) {
    return { ok: false, reason: 'automated' }
  }

  const precedence = values(m.headers, 'Precedence')[0]?.toLowerCase()
  const bulky = precedence === 'bulk' || precedence === 'junk' || precedence === 'list' || values(m.headers, 'List-Unsubscribe').length > 0
  if (bulky && !viaGroup) return { ok: false, reason: 'bulk' }

  const received = m.receivedAt ? Date.parse(m.receivedAt) : NaN
  if (!Number.isFinite(received) || ctx.now.getTime() - received > ctx.maxAgeDays * 86_400_000) return { ok: false, reason: 'too_old' }

  const mid = values(m.headers, 'Message-ID')[0]
  // Bez Message-ID (vzácné): náhradní klíč ze schránky a id zprávy — bez <>,
  // aby ho P3 nepoužila jako In-Reply-To.
  const internetMessageId = mid && mid.length <= 700 ? mid : `gmail:${ctx.mailbox}:${m.id}`
  return { ok: true, candidate: { internetMessageId, gmailMessageId: m.id, threadId: m.threadId, receivedAt: new Date(received).toISOString() } }
}

/** Dotaz pollingu s pevným začátkem okna (epocha v sekundách) — pokračování přes více běhů. */
export function pollingQueryAfter(afterEpochSec: number): string {
  return `in:inbox -in:chats after:${Math.max(0, Math.floor(afterEpochSec))}`
}

// ---------------------------------------------------------------------------
// Kurzor schránky (connector_state.cursor)
//
//   '<historyId>'                       čtení historie (users.history.list) od historyId,
//   'poll:<historyId>:<afterSec>:<n>'   rozpracovaný polling: okno od afterSec (pevné),
//                                       zpracováno n nejstarších zpráv; po dokončení
//                                       se pokračuje historií od historyId (vzatého
//                                       PŘED prvním výpisem, takže nic nepropadne).

export type MailboxCursor =
  | { mode: 'none' }
  | { mode: 'history'; historyId: string }
  | { mode: 'poll'; historyId: string; afterSec: number; offset: number }

const HISTORY_ID_RE = /^[0-9]{1,20}$/

export function parseMailboxCursor(raw: string | null | undefined): MailboxCursor {
  if (!raw) return { mode: 'none' }
  const m = /^poll:([0-9]{1,20}):([0-9]{1,12}):([0-9]{1,6})$/.exec(raw)
  if (m) return { mode: 'poll', historyId: m[1], afterSec: Number(m[2]), offset: Number(m[3]) }
  return HISTORY_ID_RE.test(raw) ? { mode: 'history', historyId: raw } : { mode: 'none' }
}

export function pollCursor(historyId: string, afterSec: number, offset: number): string {
  return `poll:${historyId}:${Math.max(0, Math.floor(afterSec))}:${Math.max(0, Math.floor(offset))}`
}

// ---------------------------------------------------------------------------
// Staré zprávy, které předfiltr přeskočil (too_old): nesmí zmizet tiše

export type StaleMessage = { gmailMessageId: string; receivedAt: string | null }

/** Odkaz na zprávu v Gmailu dané schránky. */
export function gmailMessageLink(mailbox: string, gmailMessageId: string): string {
  return `https://mail.google.com/mail/?authuser=${encodeURIComponent(mailbox)}#all/${encodeURIComponent(gmailMessageId)}`
}

const czDate = (iso: string) => {
  const d = new Date(iso)
  return `${d.getUTCDate()}. ${d.getUTCMonth() + 1}. ${d.getUTCFullYear()}`
}
const gmailDay = (ms: number) => {
  const d = new Date(ms)
  return `${d.getUTCFullYear()}/${d.getUTCMonth() + 1}/${d.getUTCDate()}`
}

/** Odkaz na hledání v Gmailu: Doručená pošta v rozmezí dní, kdy staré zprávy přišly. */
export function staleSearchLink(mailbox: string, items: readonly StaleMessage[]): string | null {
  const times = items.map((i) => (i.receivedAt ? Date.parse(i.receivedAt) : NaN)).filter(Number.isFinite)
  if (times.length === 0) return null
  const from = Math.min(...times)
  const to = Math.max(...times) + 86_400_000
  const q = `in:inbox after:${gmailDay(from)} before:${gmailDay(to)}`
  return `https://mail.google.com/mail/?authuser=${encodeURIComponent(mailbox)}#search/${encodeURIComponent(q)}`
}

/** Limit zdůvodnění návrhu případu (case_proposal_rationale_check, 0067). */
const RATIONALE_MAX = 1000

/**
 * Jeden souhrnný návrh případu pro obchod (CSO): zprávy starší než
 * maxMessageAgeDays, které agent kvůli stáří nezpracoval (typicky po výpadku
 * čtení schránky). Počet, rozmezí dní, odkaz na hledání v Gmailu a přímé
 * odkazy na první zprávy (kolik se vejde do zdůvodnění). Idempotence:
 * schránka + klíč dávky (otisk id zpráv; opakované čtení stejné dávky
 * nezaloží druhý návrh).
 */
export function staleMessagesProposal(a: {
  mailbox: string
  mailboxKey: string
  batchKey: string
  items: readonly StaleMessage[]
  maxAgeDays: number
  node: string
  now: Date
}): ProposalDraft<Record<string, never>, CaseProposalOutput> | null {
  if (a.items.length === 0) return null
  const first = a.items[0]
  const n = a.items.length
  const times = a.items.map((i) => i.receivedAt).filter((x): x is string => !!x && Number.isFinite(Date.parse(x))).sort()
  const range = times.length ? ` (přišly ${czDate(times[0])}${times.length > 1 && czDate(times[0]) !== czDate(times[times.length - 1]) ? `–${czDate(times[times.length - 1])}` : ''})` : ''
  const search = staleSearchLink(a.mailbox, a.items)
  let rationale = `Ve schránce ${a.mailbox} je ${n} ${n === 1 ? 'zpráva' : n < 5 ? 'zprávy' : 'zpráv'} starší než ${a.maxAgeDays} dny${range}, `
    + 'které agent poptávek kvůli stáří automaticky nezpracoval (nejspíš po výpadku čtení schránky). Mohou mezi nimi být poptávky — projděte je ručně.'
  if (search) rationale += ` Hledání v Gmailu: ${search}`
  const links: string[] = []
  for (const it of a.items) {
    const line = ` ${gmailMessageLink(a.mailbox, it.gmailMessageId)}`
    const rest = n - links.length - 1
    const tail = rest > 0 ? ` (a dalších ${rest})` : ''
    if (rationale.length + ' Zprávy:'.length + links.join('').length + line.length + tail.length + 16 > RATIONALE_MAX) break
    links.push(line)
  }
  if (links.length) {
    const rest = n - links.length
    rationale += ` Zprávy:${links.join('')}${rest > 0 ? ` (a dalších ${rest})` : ''}`
  }
  return {
    capability: INQUIRY_ESCALATION_CAPABILITY,
    sourceKey: `mailbox_stale:${a.mailboxKey}:${a.batchKey}`,
    event: {
      source: 'gmail:inbox',
      type: 'inquiry.mailbox_stale',
      external_id: `mailbox_stale:${a.mailboxKey}:${a.batchKey}`,
      occurred_at: a.now.toISOString(),
      subject: null,
      participants: [],
      evidence: { kind: 'email_message', sourceId: first.gmailMessageId, webLink: gmailMessageLink(a.mailbox, first.gmailMessageId) },
      title: null,
      payload: {},
    },
    output: { title: `Nezpracované starší zprávy ve schránce (${n})`, rationale: rationale.slice(0, RATIONALE_MAX) },
    reasons: ['mailbox_stale'],
    method: 'rule',
    infoState: 'ai_suggestion',
    target: {
      node: a.node,
      accountId: null,
      steps: ['Projít starší zprávy ve schránce (odkazy v návrhu)', 'Poptávky založit ručně nebo na ně odpovědět', 'Ověřit, proč čtení schránky vypadlo (Provoz)'],
    },
  }
}
