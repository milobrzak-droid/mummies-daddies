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
import { inDomainSet, looksAutomated } from './autoIntake'

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

/** Dotaz záložního pollingu (Gmail search): Doručená pošta za posledních N dní. */
export function pollingQuery(maxAgeDays: number): string {
  return `in:inbox -in:chats newer_than:${Math.max(1, Math.min(Math.round(maxAgeDays), 30))}d`
}
