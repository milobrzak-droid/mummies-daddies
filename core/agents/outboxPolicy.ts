// Pravidla odchozí fronty agenta (balík P3) — čisté funkce bez sítě,
// databáze a hodnot firmy. Úloha agent-outbox (domain/crm/agentOutboxService.ts)
// pro každou zprávu ve frontě posbírá fakta a tady se rozhodne:
//
//   send             — odeslat (autonomous = bez člověka, všechny brány splněné)
//   request_approval — chybí brána pravomoci: nabídka → žádost send_offer,
//                      ostatní druhy → zablokovat s úkolem (uvolní člověk)
//   block            — stop pravidlo: neodesílá se vůbec (úkol vlastníkovi)
//   wait             — mimo okno odesílání (připomínky), zkusí se příště
//
// BRÁNY PRAVOMOCI (samostatné odeslání bez člověka) — musí platit všechny:
//   env AGENT_AUTOSEND_ENABLED, pravidlo L4 pro druh zprávy (authority_policy),
//   verze mapy nezačíná „ilustracni" (ani mapa firmy, ani mapa nabídky),
//   druh zprávy je mezi povolenými, nabídka je do autoSendMaxTotal, kontakt
//   není citlivý (VIP), od zařazení nezasáhl člověk a zpráva není zastaralá.
// Zprávu schválenou člověkem brány pravomoci nezajímají; stop pravidla
// a limity platí vždy.
import type { OutboxKind } from './outboxPort'
import type { AutoSendKind } from './inquiryAgentConfig'

// --- Verze mapy --------------------------------------------------------------

/** Ilustrační (neschválená) mapa: dokud platí, agent sám nic neodešle. */
export function isIllustrativeMapVersion(version: string | null | undefined): boolean {
  return typeof version === 'string' && /^ilustracni/i.test(version.trim())
}

/** Druhy zpráv fronty, které smí odejít bez člověka (z kontraktů P2 a P4). */
export function autoSendOutboxKinds(inquiryKinds: readonly AutoSendKind[] | null | undefined, followUpEnabled: boolean): OutboxKind[] {
  const out: OutboxKind[] = []
  for (const k of inquiryKinds ?? []) {
    if (k === 'send_offer' && !out.includes('offer')) out.push('offer')
    if (k === 'ask_info' && !out.includes('info_request')) out.push('info_request')
  }
  if (followUpEnabled) out.push('follow_up')
  return out
}

// --- Adresy ------------------------------------------------------------------

const ADDRESS_RE = /^[^@\s<>,;"()]+@[^@\s<>,;"()]+\.[^@\s<>,;"()]+$/

/** Platná adresa e-mailu (malými písmeny), nebo null. */
export function normalizeAddress(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null
  const a = raw.trim().toLowerCase()
  return a.length <= 254 && ADDRESS_RE.test(a) ? a : null
}

/**
 * Jediná adresa z hlavičky From / Reply-To („Jméno <a@b.cz>" nebo „a@b.cz").
 * Víc adres, skupina nebo nečitelná hodnota = null.
 */
export function parseSingleMailbox(header: string | null | undefined): string | null {
  if (typeof header !== 'string') return null
  // Uvozovaná zobrazovaná jména můžou obsahovat čárky i lomené závorky.
  const h = header.replace(/"(?:[^"\\]|\\.)*"/g, '""').trim()
  if (!h || h.includes(';')) return null
  const angles = h.match(/<([^<>]*)>/g)
  if (angles) {
    if (angles.length !== 1) return null
    return normalizeAddress(angles[0].slice(1, -1))
  }
  if (h.includes(',')) return null
  return normalizeAddress(h)
}

export const domainOf = (address: string) => address.slice(address.lastIndexOf('@') + 1)

/** Doména a nebo její poddoména (relaxované zarovnání podle DMARC). */
function aligned(a: string, b: string): boolean {
  const x = a.toLowerCase().replace(/\.$/, '')
  const y = b.toLowerCase().replace(/\.$/, '')
  return x === y || x.endsWith(`.${y}`) || y.endsWith(`.${x}`)
}

/** Adresa patří firmě (vlastní doména nebo její poddoména). */
export function isOwnAddress(address: string, ownDomains: readonly string[]): boolean {
  const d = domainOf(address)
  return ownDomains.some((raw) => {
    const o = raw.trim().toLowerCase()
    return o !== '' && (d === o || d.endsWith(`.${o}`))
  })
}

/** Adresa automatu (noreply, mailer-daemon, bounce …): na tu se nikdy neodpovídá. */
export function isAutomatedAddress(address: string): boolean {
  const local = address.slice(0, address.lastIndexOf('@'))
  return /^(no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer[-_.]?daemon|postmaster|bounces?|notifications?|newsletter|automat)([-_.+].*)?$/i.test(local)
}

/** Adresa je mezi citlivými kontakty (celá adresa nebo '@doména'). */
export function isVipAddress(address: string, vip: readonly string[]): boolean {
  const a = address.toLowerCase()
  return vip.some((v) => {
    const x = v.trim().toLowerCase()
    return x.startsWith('@') ? a.endsWith(x) : x === a
  })
}

// --- Ověření odesílatele příchozí zprávy (odpověď ve vlákně) ----------------

export type SenderAuth = 'pass' | 'fail' | 'missing'

type AuthMethod = { method: string; result: string; props: Record<string, string> }

function parseAuthResults(value: string): { authserv: string; methods: AuthMethod[] } {
  // Komentáře v závorkách nesou volný text (např. „google.com: domain of …").
  const clean = value.replace(/\([^()]*\)/g, ' ')
  const parts = clean.split(';').map((p) => p.trim()).filter(Boolean)
  const authserv = (parts.shift() ?? '').split(/\s+/)[0].toLowerCase()
  const methods: AuthMethod[] = []
  for (const p of parts) {
    const tokens = p.split(/\s+/)
    const m = /^([a-z0-9-]+)=([a-z]+)$/i.exec(tokens[0] ?? '')
    if (!m) continue
    const props: Record<string, string> = {}
    for (const t of tokens.slice(1)) {
      const kv = /^([a-z0-9.-]+)=(.+)$/i.exec(t)
      if (kv) props[kv[1].toLowerCase()] = kv[2].replace(/^"|"$/g, '')
    }
    methods.push({ method: m[1].toLowerCase(), result: m[2].toLowerCase(), props })
  }
  return { authserv, methods }
}

/**
 * Výsledek SPF/DKIM/DMARC z PRVNÍ hlavičky Authentication-Results našeho
 * serveru (`trustedAuthServId`). Hlavičky jiných serverů může podvrhnout
 * odesílatel, proto se ignorují. Pass = dmarc=pass, nebo (bez DMARC
 * záznamu) dkim/spf=pass zarovnané s doménou From.
 */
export function verifySenderAuth(authResults: readonly string[], fromAddress: string, trustedAuthServId: string): SenderAuth {
  const trusted = authResults.map(parseAuthResults).find((h) => h.authserv === trustedAuthServId.toLowerCase())
  if (!trusted) return 'missing'
  const fromDomain = domainOf(fromAddress)
  const dmarc = trusted.methods.find((m) => m.method === 'dmarc')
  if (dmarc) {
    if (dmarc.result !== 'pass') return dmarc.result === 'none' ? alignedPass(trusted.methods, fromDomain) : 'fail'
    const hf = dmarc.props['header.from']
    return !hf || aligned(hf, fromDomain) ? 'pass' : 'fail'
  }
  return alignedPass(trusted.methods, fromDomain)
}

function alignedPass(methods: AuthMethod[], fromDomain: string): SenderAuth {
  for (const m of methods) {
    if (m.result !== 'pass') continue
    if (m.method === 'dkim') {
      const d = m.props['header.d'] ?? (m.props['header.i'] ? m.props['header.i'].slice(m.props['header.i'].lastIndexOf('@') + 1) : '')
      if (d && aligned(d, fromDomain)) return 'pass'
    }
    if (m.method === 'spf') {
      const mf = m.props['smtp.mailfrom'] ?? ''
      const d = mf.includes('@') ? mf.slice(mf.lastIndexOf('@') + 1) : mf
      if (d && aligned(d, fromDomain)) return 'pass'
    }
  }
  return 'fail'
}

export type ReplyProblem = 'from_invalid' | 'reply_to_mismatch' | 'sender_not_verified'

/**
 * Komu odpovědět ve vlákně: VŽDY jen na From původní zprávy. Reply-To
 * s jinou adresou, nečitelné From nebo neověřený odesílatel = neodpovídá se
 * (eskalace člověku).
 */
export function replyTarget(input: {
  from: string | null
  replyTo: string | null
  authResults: readonly string[]
  trustedAuthServId: string
}): { recipient: string | null; problems: ReplyProblem[] } {
  const problems: ReplyProblem[] = []
  const from = parseSingleMailbox(input.from)
  if (!from) return { recipient: null, problems: ['from_invalid'] }
  if (input.replyTo != null && input.replyTo.trim() !== '') {
    const rt = parseSingleMailbox(input.replyTo)
    if (rt !== from) problems.push('reply_to_mismatch')
  }
  if (verifySenderAuth(input.authResults, from, input.trustedAuthServId) !== 'pass') problems.push('sender_not_verified')
  return { recipient: from, problems }
}

// --- Rozhodnutí ----------------------------------------------------------------

export type OutboxStopReason =
  | 'body_purged'
  | 'missing_recipient'
  | 'own_address'
  | 'automated_recipient'
  | 'do_not_contact'
  | 'deal_closed'
  | 'version_not_draft'
  | 'mailbox_inactive'
  | ReplyProblem
  | 'customer_replied'
  | 'snoozed'

export type OutboxGateReason =
  | 'autosend_disabled'
  | 'authority_not_l4'
  | 'illustrative_map'
  | 'kind_not_allowed'
  | 'over_auto_send_limit'
  | 'vip_contact'
  | 'human_activity'
  | 'queue_expired'
  | 'snoozed'

export interface OutboxItemView {
  kind: OutboxKind
  priceMapVersion: string | null
  quoteTotal: number | null
  /** Zprávu uvolnil člověk (schválená žádost send_offer nebo agent_outbox_release). */
  humanApproved: boolean
  bodyPurged: boolean
  /** Stáří zprávy ve frontě (od zařazení) v hodinách. */
  ageHours: number
}

export interface OutboxFacts {
  /** Skutečný příjemce (From původní zprávy nebo adresa z fronty), už normalizovaný. */
  recipient: string | null
  /** Problémy s odesílatelem původní zprávy (jen režim odpovědi). */
  replyProblems: readonly ReplyProblem[]
  ownAddress: boolean
  automatedRecipient: boolean
  /** Kontakt nebo adresa nesouhlasí s oslovením (0087), výmaz GDPR. */
  doNotContact: boolean
  /** Obchod je vyhraný, prohraný nebo uzavřený. */
  dealClosed: boolean
  /** Nabídka: verze je pořád koncept (null = netýká se). */
  versionIsDraft: boolean | null
  mailboxActive: boolean
  /** Zákazník napsal (ve vlákně / k obchodu) po zařazení nebo po schválení. */
  customerReplied: boolean
  /** Člověk zapsal k obchodu aktivitu po zařazení zprávy. */
  humanActivity: boolean
  /** Obchod nebo klient je odložený (snooze). */
  snoozed: boolean
  vip: boolean
}

export interface OutboxGates {
  autoSendEnabled: boolean
  /** Aktivní pravidlo L4 pro druh zprávy (authority_policy). */
  autonomyGranted: boolean
  /** Verze mapy firmy (COMPANY…priceMap.version). */
  companyMapVersion: string | null
  autoSendKinds: readonly OutboxKind[]
  /** Strop částky nabídky bez DPH pro samostatné odeslání. */
  autoSendMaxTotal: number | null
  maxQueueAgeHours: number
  /** Okno odesílání (jen připomínky): null = bez okna. */
  withinSendWindow: boolean | null
}

export type OutboxDecision =
  | { action: 'send'; autonomous: boolean }
  | { action: 'request_approval'; reasons: OutboxGateReason[] }
  | { action: 'block'; reason: OutboxStopReason }
  | { action: 'wait'; reason: 'outside_send_window' }

/** Stop pravidla (neodesílá se vůbec) — v pořadí priority. */
export function outboxStopReason(item: OutboxItemView, f: OutboxFacts): OutboxStopReason | null {
  if (item.bodyPurged) return 'body_purged'
  if (f.replyProblems.includes('from_invalid')) return 'from_invalid'
  if (!f.recipient) return 'missing_recipient'
  if (f.ownAddress) return 'own_address'
  if (f.automatedRecipient) return 'automated_recipient'
  if (f.doNotContact) return 'do_not_contact'
  if (f.dealClosed) return 'deal_closed'
  if (item.kind === 'offer' && f.versionIsDraft === false) return 'version_not_draft'
  if (!f.mailboxActive) return 'mailbox_inactive'
  if (f.replyProblems.includes('reply_to_mismatch')) return 'reply_to_mismatch'
  if (f.replyProblems.includes('sender_not_verified')) return 'sender_not_verified'
  if (f.customerReplied) return 'customer_replied'
  // Odložený obchod: připomínka nemá smysl ani po schválení.
  if (item.kind === 'follow_up' && f.snoozed) return 'snoozed'
  return null
}

/** Chybějící brány pravomoci (prázdné = smí odejít bez člověka). */
export function outboxGateFailures(item: OutboxItemView, f: OutboxFacts, g: OutboxGates): OutboxGateReason[] {
  const out: OutboxGateReason[] = []
  if (!g.autoSendEnabled) out.push('autosend_disabled')
  if (!g.autonomyGranted) out.push('authority_not_l4')
  if (isIllustrativeMapVersion(g.companyMapVersion) || isIllustrativeMapVersion(item.priceMapVersion)) out.push('illustrative_map')
  if (!g.autoSendKinds.includes(item.kind)) out.push('kind_not_allowed')
  if (item.kind === 'offer') {
    if (g.autoSendMaxTotal == null || item.quoteTotal == null || item.quoteTotal > g.autoSendMaxTotal) out.push('over_auto_send_limit')
  }
  if (f.vip) out.push('vip_contact')
  if (f.humanActivity) out.push('human_activity')
  if (item.ageHours > g.maxQueueAgeHours) out.push('queue_expired')
  if (f.snoozed) out.push('snoozed')
  return out
}

export function decideOutbox(item: OutboxItemView, facts: OutboxFacts, gates: OutboxGates): OutboxDecision {
  const stop = outboxStopReason(item, facts)
  if (stop) return { action: 'block', reason: stop }
  if (gates.withinSendWindow === false) return { action: 'wait', reason: 'outside_send_window' }
  if (item.humanApproved) return { action: 'send', autonomous: false }
  const failures = outboxGateFailures(item, facts, gates)
  if (failures.length === 0) return { action: 'send', autonomous: true }
  return { action: 'request_approval', reasons: failures }
}

// --- Limity --------------------------------------------------------------------

export interface OutboxLimits {
  /** Nejvýš tolik zpráv daných druhů za pražský den. */
  dailyLimit: number
  limitKinds: OutboxKind[]
  /** Nejvýš tolik zpráv jednomu příjemci za pražský den (všechny druhy). */
  perRecipientDailyLimit: number
}

/** Limity pro druh zprávy: odpovědi na poptávku sdílí limit agenta, připomínky mají svůj. */
export function outboxLimits(
  kind: OutboxKind,
  inquiry: { dailyAutoSendLimit: number; perRecipientDailyLimit: number } | null | undefined,
  followUp: { dailyLimit: number } | null | undefined,
): OutboxLimits {
  const perRecipientDailyLimit = Math.max(0, inquiry?.perRecipientDailyLimit ?? 0)
  if (kind === 'follow_up') {
    return { dailyLimit: Math.max(0, followUp?.dailyLimit ?? 0), limitKinds: ['follow_up'], perRecipientDailyLimit }
  }
  return { dailyLimit: Math.max(0, inquiry?.dailyAutoSendLimit ?? 0), limitKinds: ['offer', 'info_request'], perRecipientDailyLimit }
}

// --- Okno odesílání ------------------------------------------------------------

/** Je místní čas firmy v okně? `isoWeekday` 1 = pondělí … 7 = neděle; hodiny [from, to). */
export function isWithinWindow(local: { isoWeekday: number; hour: number }, w: { days: readonly number[]; fromHour: number; toHour: number }): boolean {
  return w.days.includes(local.isoWeekday) && local.hour >= w.fromHour && local.hour < w.toHour
}

// --- Text zprávy ---------------------------------------------------------------

/**
 * Text, který opravdu odejde: k vygenerovanému textu se připojí podmínky
 * nabídky (nabídka, připomínka) a patička firmy — každá část jen jednou.
 */
export function customerText(kind: OutboxKind, text: string, cfg: { footer: string; offerTerms: string }): string {
  let out = text.replace(/\r\n?/g, '\n').trimEnd()
  const parts = [kind === 'info_request' ? '' : cfg.offerTerms, cfg.footer].map((p) => p.trim()).filter(Boolean)
  for (const p of parts) if (!out.includes(p)) out = `${out}\n\n${p}`
  return out
}

/** Krátký český popis důvodu (úkol pro člověka). Nikdy osobní údaje. */
export const OUTBOX_REASON_LABELS: Readonly<Record<OutboxStopReason | OutboxGateReason | 'forbidden' | 'unauthorized' | 'rejected' | 'uncertain' | 'token_unavailable', string>> = {
  body_purged: 'text zprávy už je po retenci smazaný',
  missing_recipient: 'chybí adresa příjemce',
  own_address: 'příjemce je adresa naší firmy',
  automated_recipient: 'příjemce je automat (noreply apod.)',
  do_not_contact: 'kontakt nesouhlasí s oslovením',
  deal_closed: 'obchod je uzavřený',
  version_not_draft: 'verze nabídky už není koncept',
  mailbox_inactive: 'schránka odesílatele není aktivní',
  from_invalid: 'odesílatele původní zprávy nejde určit',
  reply_to_mismatch: 'adresa pro odpověď (Reply-To) se liší od odesílatele',
  sender_not_verified: 'odesílatele se nepodařilo ověřit (SPF/DKIM/DMARC)',
  customer_replied: 'zákazník mezitím napsal znovu',
  snoozed: 'obchod je odložený',
  autosend_disabled: 'samostatné odesílání je vypnuté',
  authority_not_l4: 'agent nemá pravomoc odesílat sám',
  illustrative_map: 'mapa nabídek je jen ilustrační (neschválená)',
  kind_not_allowed: 'tento druh zprávy agent sám neposílá',
  over_auto_send_limit: 'částka je nad limitem pro samostatné odeslání',
  vip_contact: 'kontakt je citlivý (VIP)',
  human_activity: 'k obchodu mezitím zasáhl člověk',
  queue_expired: 'zpráva čekala ve frontě příliš dlouho',
  forbidden: 'Gmail odeslání odmítl (oprávnění)',
  unauthorized: 'přihlášení ke Gmailu neplatí',
  rejected: 'Gmail zprávu odmítl',
  uncertain: 'není jisté, jestli zpráva odešla',
  token_unavailable: 'schránka není připojená ke Gmailu',
}
