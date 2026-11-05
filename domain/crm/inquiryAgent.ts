// Agent příchozích poptávek (P2) — čistá doménová logika bez I/O.
//
// Obě cesty (e-mail přes Gmail a webový formulář) končí stejným verdiktem
// AgentVerdict: send_offer | ask_info | escalate | not_inquiry. Tady se:
//   - z rozhodnutí výpočtu (decideInquiry / evaluateStandardOffer) skládá
//     verdikt a na něj se nasazují pojistky agenta (applyAgentGates):
//       * odesílatel neprošel SPF/DKIM/DMARC nebo má jiné Reply-To → eskalace,
//       * nejasný / rozporný segment se nedoptává, jde na posouzení obchodu,
//       * místo akce uvedené, ale nedohledatelné (geokódování) → eskalace,
//       * druh odpovědi mimo autoSendKinds → eskalace;
//   - staví payload RPC inquiry_agent_found (CRM zápis), návrh eskalace
//     (case_proposal) a položka odchozí fronty (OutboxEnqueue, P3).
//
// Osobní údaje: do důvodů eskalace (rationale) ani do kódů nejdou částky,
// adresy, jména ani text e-mailu — jen kódy a české popisky.
import type { InquiryDecision } from '@/core/agents/inquiryToOffer'
import type { AutoSendKind, InquiryAgentConfig, InquiryLeadMapping } from '@/core/agents/inquiryAgentConfig'
import type { SenderAuthVerdict } from '@/core/agents/mailAuth'
import { composeReplyText } from '@/core/agents/inquiryReply'
import type { OutboxEnqueue, OutboxMode } from '@/core/agents/outboxPort'
import type { CaseProposalOutput, ProposalDraft } from '@/core/agents/template'
import type { EvidenceRef } from '@/core/informationState'
import { formatCzk, type MissingField, type OfferQuote, type OfferResult } from '@/core/standardOffer'
import { addBusinessDays, companyNameFromDomain, INTAKE_FREEMAIL, inDomainSet } from './autoIntake'

export const INQUIRY_AGENT_ACTOR = 'inquiry_agent'
export const INQUIRY_ESCALATION_CAPABILITY = 'inquiry_escalation'
export const INQUIRY_ACTIVITY_SOURCE = 'agent:inquiry'

export type AgentKind = 'send_offer' | 'ask_info' | 'escalate' | 'not_inquiry'

export type AgentVerdict = {
  kind: AgentKind
  /** Kódy důvodů (eskalace z mapy + pojistky agenta). Bez textu poptávky. */
  reasonCodes: string[]
  missing: MissingField[]
  /** Nabídka (send_offer) nebo koncept u eskalace; jinak null. */
  quote: OfferQuote | null
  /** Text odpovědi zákazníkovi (jen send_offer / ask_info), bez patičky. */
  reply: { subject: string; body: string } | null
}

/** Kódy pojistek agenta (doplňují EscalationCode z core/standardOffer.ts). */
export type AgentGateCode =
  | 'sender_unverified'
  | 'segment_unclear'
  | 'venue_unresolved'
  | 'auto_send_kind_off'
  | 'existing_open_deal'
  | 'ambiguous_account'
  | 'extraction_failed'
  | 'model_unavailable'

/** České popisky kódů do zdůvodnění eskalace (bez částek a adres). */
export const INQUIRY_REASON_LABELS: Record<string, string> = {
  map_expired: 'cenová mapa vypršela',
  unknown_segment: 'segment mimo mapu',
  unknown_event_type: 'typ akce mimo standardní nabídku',
  non_standard_package: 'nestandardní balíček',
  guests_out_of_range: 'počet hostů mimo rozsah balíčku',
  date_in_past: 'termín už proběhl',
  date_too_soon: 'termín je příliš brzy',
  date_too_far: 'termín je příliš daleko',
  distance_over_limit: 'místo akce je dál, než pokrývá mapa',
  unknown_extra: 'doplněk mimo nabídku',
  unsupported_diet: 'dieta mimo nabídku',
  dietary_exceeds_guests: 'dietních porcí je víc než hostů',
  special_request: 'zvláštní přání',
  vip_contact: 'citlivý / VIP kontakt',
  over_auto_send_limit: 'částka nad limitem samostatného odeslání',
  extraction_failed: 'poptávku se nepodařilo automaticky přečíst',
  model_unavailable: 'čtení modelem opakovaně selhalo',
  sender_unverified: 'odesílatele nejde ověřit (SPF/DKIM/DMARC nebo jiné Reply-To)',
  segment_unclear: 'nejasné, jestli jde o firemní akci, nebo soukromou oslavu',
  venue_unresolved: 'místo akce nejde dohledat',
  auto_send_kind_off: 'tento druh odpovědi agent sám neposílá',
  existing_open_deal: 'zákazník už má otevřenou poptávku',
  ambiguous_account: 'odesílatel odpovídá víc klientům v CRM',
  auth_results_missing: 'chybí ověření odesílatele',
  dmarc_fail: 'DMARC neprošel',
  dkim_unaligned: 'podpis DKIM neodpovídá odesílateli',
  from_invalid: 'neplatný odesílatel',
  from_multiple: 'víc odesílatelů',
  reply_to_mismatch: 'Reply-To se liší od odesílatele',
}

export const reasonLabel = (code: string): string => INQUIRY_REASON_LABELS[code] ?? code

const uniq = <T>(xs: readonly T[]): T[] => [...new Set(xs)]

// ---------------------------------------------------------------------------
// Verdikt z výpočtu

/** E-mail: rozhodnutí decideInquiry → verdikt. */
export function verdictFromDecision(d: InquiryDecision): AgentVerdict {
  switch (d.kind) {
    case 'not_inquiry':
      return { kind: 'not_inquiry', reasonCodes: [], missing: [], quote: null, reply: null }
    case 'send_offer':
      return { kind: 'send_offer', reasonCodes: [], missing: [], quote: d.quote, reply: d.email }
    case 'ask_info':
      return {
        kind: 'ask_info',
        reasonCodes: d.segment?.basis === 'conflict' ? ['segment_unclear'] : [],
        missing: [...d.missing],
        quote: null,
        reply: d.email,
      }
    case 'escalate':
      return { kind: 'escalate', reasonCodes: uniq(d.reasons.map((r) => r.code)), missing: [...d.missing], quote: d.draft, reply: null }
  }
}

/** Web: výsledek evaluateStandardOffer + texty → verdikt. */
export function verdictFromOfferResult(
  r: OfferResult,
  render: { offer: (q: OfferQuote) => { subject: string; body: string }; info: (missing: MissingField[]) => { subject: string; body: string } },
): AgentVerdict {
  if (r.kind === 'standard') return { kind: 'send_offer', reasonCodes: [], missing: [], quote: r.quote, reply: render.offer(r.quote) }
  if (r.kind === 'needs_info') return { kind: 'ask_info', reasonCodes: [], missing: [...r.missing], quote: null, reply: render.info([...r.missing]) }
  return { kind: 'escalate', reasonCodes: uniq(r.reasons.map((x) => x.code)), missing: [...r.missing], quote: r.draft, reply: null }
}

/** Převede verdikt na eskalaci s dalšími kódy (koncept nabídky zůstává). */
export function escalateVerdict(v: AgentVerdict, ...codes: string[]): AgentVerdict {
  return { kind: 'escalate', reasonCodes: uniq([...v.reasonCodes, ...codes]), missing: v.missing, quote: v.quote, reply: null }
}

export type AgentGates = {
  /** Jen e-mail: ověření odesílatele (core/agents/mailAuth.ts). */
  senderAuth?: SenderAuthVerdict | null
  /** Uvedl zákazník místo akce? (Když ano a vzdálenost chybí, selhalo geokódování.) */
  venuePresent: boolean
  autoSendKinds: readonly AutoSendKind[]
}

/** Pojistky agenta nad verdiktem výpočtu (pořadí nehraje roli, kódy se sčítají). */
export function applyAgentGates(v: AgentVerdict, g: AgentGates): AgentVerdict {
  if (v.kind === 'not_inquiry') return v
  const codes: string[] = []
  if (g.senderAuth && !g.senderAuth.ok) codes.push('sender_unverified', ...g.senderAuth.codes)
  if (v.kind === 'ask_info') {
    if (v.missing.includes('segment') || v.reasonCodes.includes('segment_unclear')) codes.push('segment_unclear')
    if (v.missing.includes('distanceKm') && g.venuePresent) codes.push('venue_unresolved')
  }
  if (v.kind === 'escalate' && v.missing.includes('distanceKm') && g.venuePresent) codes.push('venue_unresolved')
  if ((v.kind === 'send_offer' || v.kind === 'ask_info') && !g.autoSendKinds.includes(v.kind)) codes.push('auto_send_kind_off')
  if (codes.length === 0) return v
  return escalateVerdict(v, ...codes)
}

// ---------------------------------------------------------------------------
// Kdo a odkud

export function isFreemailDomain(domain: string | null): boolean {
  return domain !== null && inDomainSet(domain, INTAKE_FREEMAIL)
}

export function domainOf(address: string | null | undefined): string | null {
  const m = /@([a-z0-9.-]+\.[a-z]{2,})$/i.exec((address ?? '').trim())
  return m ? m[1].toLowerCase() : null
}

export type LeadCompany = { name: string; domain: string | null; ico: string | null }

/**
 * Firma leadu. B2C (soukromá osoba) = null → účet soukromé osoby bez aliasu
 * domény. Firemní doména odesílatele = firma podle domény (i bez segmentu).
 * Freemail s názvem firmy z textu/formuláře = firma bez domény.
 */
export function leadCompany(a: { segment: string | null; email: string; companyName: string | null; ico?: string | null }): LeadCompany | null {
  if (a.segment === 'b2c') return null
  const domain = domainOf(a.email)
  const freemail = isFreemailDomain(domain)
  const ico = a.ico && /^\d{8}$/.test(a.ico) ? a.ico : null
  if (domain && !freemail) return { name: (a.companyName ?? companyNameFromDomain(domain)).slice(0, 300), domain, ico }
  if (a.companyName) return { name: a.companyName.slice(0, 300), domain: null, ico }
  return null
}

/** Jméno kontaktu do CRM: ze vstupu, jinak z adresy („jan.novak@" → „Jan Novak"). */
export function contactName(name: string | null | undefined, email: string): string {
  const t = (name ?? '').replace(/\s+/g, ' ').trim()
  if (t.length >= 2 && !t.includes('@')) return t.slice(0, 200)
  const local = email.slice(0, email.indexOf('@'))
  const words = local.split(/[._+-]+/).filter((w) => /^\p{L}+$/u.test(w))
  return words.length ? words.map((w) => w[0].toUpperCase() + w.slice(1)).join(' ').slice(0, 200) : email.slice(0, 200)
}

/** Pilíř a obchodní linka leadu podle segmentu a typu akce (config leadMapping). */
export function leadLine(
  mapping: InquiryAgentConfig['leadMapping'],
  segment: string | null,
  eventType: string | null,
): InquiryLeadMapping & { revenueLine: string } {
  const m = (segment && mapping?.[segment]) || mapping?.['*']
  if (!m) throw new Error('inquiryAgent.leadMapping chybí pro segment i výchozí klíč *')
  const line = (eventType && m.eventTypeRevenueLines?.[eventType]) || m.revenueLine
  return { pillar: m.pillar, revenueLine: line }
}

// ---------------------------------------------------------------------------
// CRM zápis (RPC inquiry_agent_found, 0103)

export type FoundArgs = {
  source: 'email' | 'web'
  sourceKey: string
  runId?: number | null
  webInquiryId?: number | null
  occurredAt: string
  ownerId: string
  dedupDays: number
  email: string
  personName: string
  company: LeadCompany | null
  verdict: AgentVerdict
  facts: { segment: string | null; eventType: string | null; eventTypeLabel: string | null; eventDate: string | null; guests: number | null }
  line: { pillar: string; revenueLine: string; revenueCategory: string }
  /** Dnešní pražský den (termíny dalšího kroku a úkolu). */
  today: string
}

const czDay = (iso: string) => {
  const [y, m, d] = iso.split('-').map(Number)
  return `${d}. ${m}. ${y}`
}

/** Text konceptu verze nabídky (deal_scope_version.scope): rozpis a verze mapy. */
export function scopeText(q: OfferQuote): string {
  return [
    `${q.eventTypeLabel} — ${czDay(q.eventDate)}, ${q.guests} hostů, balíček ${q.package.label}`,
    ...q.lines.map((l) => `- ${l.label}: ${formatCzk(l.total)}`),
    `Celkem bez DPH ${formatCzk(q.subtotal)}, s DPH ${formatCzk(q.total)}`,
    `Verze cenové mapy: ${q.mapVersion}`,
  ].join('\n').slice(0, 4000)
}

const NEXT_STEP: Record<Exclude<AgentKind, 'not_inquiry'>, { text: string; days: number }> = {
  send_offer: { text: 'Počkat na reakci zákazníka na nabídku', days: 3 },
  ask_info: { text: 'Počkat na doplnění údajů od zákazníka', days: 2 },
  escalate: { text: 'Posoudit poptávku a odpovědět zákazníkovi', days: 1 },
}

export function inquiryFoundPayload(a: FoundArgs): Record<string, unknown> {
  if (a.verdict.kind === 'not_inquiry') throw new Error('not_inquiry se do CRM nezapisuje')
  const step = NEXT_STEP[a.verdict.kind]
  const due = addBusinessDays(a.today, step.days)
  const who = a.company?.name ?? a.personName
  const what = a.facts.eventTypeLabel ?? 'Poptávka cateringu'
  const when = a.facts.eventDate ? `, ${czDay(a.facts.eventDate)}` : ''
  const channel = a.source === 'email' ? 'e-mailu' : 'webového formuláře'
  const reasons = a.verdict.reasonCodes.map(reasonLabel)
  return {
    source: a.source,
    source_key: a.sourceKey,
    run_id: a.runId ?? null,
    web_inquiry_id: a.webInquiryId ?? null,
    occurred_at: a.occurredAt,
    owner_id: a.ownerId,
    dedup_days: Math.min(Math.max(Math.round(a.dedupDays), 0), 60),
    email: a.email,
    person_name: a.personName,
    company: a.company,
    deal: {
      title: `${what} — ${who}${when}`.slice(0, 300),
      pillar: a.line.pillar,
      revenue_line: a.line.revenueLine,
      revenue_category: a.line.revenueCategory,
      next_step: step.text,
      next_step_due: due,
      note: [
        `Založil agent poptávek z ${channel}.`,
        a.facts.guests ? `Hostů: ${a.facts.guests}.` : null,
        reasons.length ? `K posouzení: ${reasons.join('; ')}.` : null,
      ].filter(Boolean).join(' ').slice(0, 2000),
      amount: a.verdict.quote?.subtotal ?? 0,
    },
    activity: { subject: `Poptávka z ${channel}: ${what}${when}`.slice(0, 300) },
    task:
      a.verdict.kind === 'escalate'
        ? { title: `Posoudit poptávku — ${who}`.slice(0, 300), due_on: addBusinessDays(a.today, 1), priority: 'high' }
        : null,
    scope: a.verdict.quote ? { amount: a.verdict.quote.subtotal, text: scopeText(a.verdict.quote) } : null,
  }
}

export type FoundResult = {
  status: 'created' | 'reused' | 'duplicate' | 'ambiguous'
  account_id: number | null
  contact_id: number | null
  deal_id: number | null
  scope_version_id: number | null
}

export function parseFoundResult(data: unknown): FoundResult | null {
  if (!data || typeof data !== 'object') return null
  const d = data as Record<string, unknown>
  if (d.status !== 'created' && d.status !== 'reused' && d.status !== 'duplicate' && d.status !== 'ambiguous') return null
  const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : null)
  return { status: d.status, account_id: num(d.account_id), contact_id: num(d.contact_id), deal_id: num(d.deal_id), scope_version_id: num(d.scope_version_id) }
}

/** Po CRM zápisu: opakovaná poptávka a víc klientů nesmí dostat automatickou odpověď. */
export function applyFoundResult(v: AgentVerdict, r: FoundResult): AgentVerdict {
  if (v.kind === 'escalate' || v.kind === 'not_inquiry') return r.status === 'ambiguous' ? escalateVerdict(v, 'ambiguous_account') : v
  if (r.status === 'reused') return escalateVerdict(v, 'existing_open_deal')
  if (r.status === 'ambiguous') return escalateVerdict(v, 'ambiguous_account')
  return v
}

// ---------------------------------------------------------------------------
// Eskalace (case_proposal)

export type EscalationArgs = {
  sourceKey: string
  source: 'email' | 'web'
  occurredAt: string
  node: string
  accountId: number | null
  evidence: EvidenceRef
  reasonCodes: readonly string[]
  eventTypeLabel: string | null
  /** Koncept nabídky existuje (rozhodnutí je jen o výjimce)? */
  hasDraft: boolean
}

export function escalationProposal(a: EscalationArgs): ProposalDraft<Record<string, never>, CaseProposalOutput> {
  const what = a.eventTypeLabel ?? 'catering'
  const reasons = uniq(a.reasonCodes).map(reasonLabel)
  const rationale = [
    `Poptávka (${what}) z ${a.source === 'email' ? 'e-mailu' : 'webového formuláře'} potřebuje rozhodnutí člověka.`,
    reasons.length ? `Důvody: ${reasons.join('; ')}.` : 'Důvod: mimo pravidla samostatné odpovědi.',
    a.hasDraft ? 'Koncept nabídky z mapy je u obchodu (verze nabídky, koncept).' : 'Nabídku z mapy nejde spočítat; je potřeba nabídka na míru nebo doptání.',
  ].join(' ')
  return {
    capability: INQUIRY_ESCALATION_CAPABILITY,
    sourceKey: a.sourceKey,
    event: {
      source: a.source === 'email' ? 'gmail:inbox' : 'web:poptavka',
      type: 'inquiry.received',
      external_id: a.sourceKey,
      occurred_at: a.occurredAt,
      subject: a.accountId ? { kind: 'account', id: a.accountId } : null,
      participants: [],
      evidence: a.evidence,
      title: null,
      payload: {},
    },
    output: { title: `Poptávka k posouzení — ${what}`.slice(0, 200), rationale: rationale.slice(0, 2000) },
    reasons: uniq(a.reasonCodes),
    method: 'rule',
    infoState: 'ai_suggestion',
    target: {
      node: a.node,
      accountId: a.accountId,
      steps: ['Posoudit poptávku a důvody eskalace', 'Připravit nabídku na míru nebo doptání', 'Odpovědět zákazníkovi'],
    },
  }
}

// ---------------------------------------------------------------------------
// Odchozí fronta (P3)

/**
 * Ze které schránky odpovědět. 'lead_owner' = schránka vlastníka leadu;
 * 'receiving_mailbox' = schránka, kam poptávka přišla (sdílená schránka bez
 * člena → vlastník leadu).
 */
export function replyMailboxMember(replyFrom: InquiryAgentConfig['replyFrom'], receivingMemberId: string | null, leadOwnerId: string): string {
  return replyFrom === 'receiving_mailbox' && receivingMemberId ? receivingMemberId : leadOwnerId
}

/**
 * Režim odeslání: odpověď ve vlákně jde jen ze stejné schránky, kam zpráva
 * přišla (id zprávy v Gmailu platí jen v ní); P3 odpovídá vždy na From.
 * Jinak nová zpráva na adresu From (ověřenou), mimo původní vlákno. (Navázání
 * přes In-Reply-To podle inquiry_agent_run.internet_message_id by musel
 * doplnit P3 — zatím ne.)
 */
export function replyMode(a: { senderMemberId: string; receivingMemberId: string | null; gmailMessageId: string | null; replyAddress: string }): OutboxMode {
  if (a.gmailMessageId && a.receivingMemberId && a.receivingMemberId === a.senderMemberId) return { reply: a.gmailMessageId }
  return { to: a.replyAddress }
}

export function outboxItem(a: {
  verdict: AgentVerdict
  sourceRef: string
  dealId: number
  scopeVersionId: number | null
  mailboxMemberId: string
  mode: OutboxMode
  footer: string | null | undefined
}): OutboxEnqueue {
  const v = a.verdict
  if ((v.kind !== 'send_offer' && v.kind !== 'ask_info') || !v.reply) throw new Error(`verdikt ${v.kind} se neodesílá`)
  return {
    kind: v.kind === 'send_offer' ? 'offer' : 'info_request',
    sourceRef: a.sourceRef,
    dealId: a.dealId,
    scopeVersionId: v.kind === 'send_offer' ? a.scopeVersionId : null,
    mailboxMemberId: a.mailboxMemberId,
    mode: a.mode,
    subject: v.reply.subject.slice(0, 250),
    text: composeReplyText(v.reply.body, a.footer),
    priceMapVersion: v.quote?.mapVersion ?? null,
  }
}

type DbErr = { code?: string | null; message?: string | null } | null | undefined

/** RPC chybí (P3 / migrace ještě nejsou nasazené): PostgREST PGRST202, Postgres 42883. */
export function isRpcMissing(err: DbErr): boolean {
  if (!err) return false
  if (err.code === 'PGRST202' || err.code === '42883') return true
  return /could not find the function|function .* does not exist/i.test(err.message ?? '')
}

// ---------------------------------------------------------------------------
// Opakování a výpadek modelu

/** Odklad dalšího pokusu: 15 min, 30 min, 1 h, … nejvýš 6 h. */
export function retryDelaySeconds(attempts: number): number {
  const n = Math.max(1, Math.floor(attempts))
  return Math.min(15 * 60 * 2 ** (n - 1), 6 * 3600)
}

/**
 * Je chyba volání modelu dočasná (přetížení, limit, výpadek, kredit,
 * timeout)? Pak se zpráva vrátí do fronty s odkladem a eskaluje se až po
 * modelMaxAttempts pokusech, ať obchod nedostane lavinu případů.
 */
export function isTransientModelError(e: unknown): boolean {
  if (!(e instanceof Error)) return false
  if (e.name === 'TimeoutError' || e.name === 'AbortError') return true
  if (/ANTHROPIC_API_KEY is not set|fetch failed|network/i.test(e.message)) return true
  const status = (e as { status?: unknown }).status
  if (typeof status === 'number') return status === 408 || status === 409 || status === 429 || status >= 500 || /\((billing|rate_limit_error|overloaded_error)\)/.test(e.message)
  return false
}

/** Začátek pražského dne `day` jako ISO (pro denní strop volání modelu). Přibližně: posun podle offsetu v poledne. */
export function pragueDayStartIso(day: string, timeZone: string): string {
  const noon = new Date(`${day}T12:00:00Z`)
  const local = new Date(noon.toLocaleString('en-US', { timeZone }))
  const offsetMs = local.getTime() - new Date(noon.toLocaleString('en-US', { timeZone: 'UTC' })).getTime()
  return new Date(Date.parse(`${day}T00:00:00Z`) - offsetMs).toISOString()
}

/** Kolik sekund zbývá do půlnoci pražského času (odklad po denním stropu). */
export function secondsUntilNextDay(now: Date, nextDayStartIso: string): number {
  return Math.max(60, Math.ceil((Date.parse(nextDayStartIso) - now.getTime()) / 1000))
}
