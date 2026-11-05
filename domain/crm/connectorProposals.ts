// Návrhy zakázek z konektoru (Claude v claude.ai / Coworku přes /api/mcp) —
// čistá logika bez I/O: vstup nástrojů propose_deal / propose_deals /
// propose_deal_update / check_deals_coverage, uložený tvar návrhu, varování,
// podobnost názvů a popisek dávky. Modul nesahá na `node:` ani na síť, takže
// ho smí importovat i klientská komponenta (karta návrhu na /rozhodnuti).
//
// ROZHODNUTÍ (majitel, 20. 10. 2026; docs/PROVOZ.md):
//   * Konektor obchod NEZAKLÁDÁ. Návrh čeká ve frontě a obchod vznikne až po
//     schválení člověkem s rolí vedení (nebo admin) v Cockpitu (/rozhodnuti).
//   * Fronta = existující tabulka mail_content_intake (0091, návrh zakázky
//     wait_reason 'offer_draft' z 0099) se zdrojem source = 'mcp_connector'.
//     Proč ne nový systém: tabulka už má RLS jen pro obchodní role + AAL2,
//     zápis jen přes server, měkký audit, retenci 30 dní a idempotenci
//     (dedupe_key UNIQUE, obchod podle deal.source_pdf_path z 0070). Proč ne
//     Loop Core approval_request: provedení tam běží v SQL (approval_execute),
//     ale založení obchodu potřebuje serverovou logiku (kurz ČNB, ARES u
//     nového klienta, kontakt) a parametry s částkami by v approval_request
//     viděl celý tým. Proč ne case_proposal: ten z návrhu nese jen případ,
//     záměrně bez obchodu a částek.
//   * Čtyři oči: návrh je „od Claude jménem X" (created_by = X, záznam
//     „api_key:X" v auditu), schvaluje přihlášený člověk (decided_by
//     „user:<id>"). Schválit smí vedení/admin včetně X — Viktor je jediný admin
//     a návrhy z konektoru si schvaluje sám. Konektor sám schválit nemůže
//     (žádný nástroj na to není, server akce chce přihlášení s 2FA).
//   * Text z e-mailu je jen data: uloží se, neprovede; známky pokynů pro AI
//     se ukážou jako varování na kartě.
import { z } from 'zod'
import { INJECTION_FLAGS, type InjectionFlag } from '@/core/untrusted'
import { IMPORT_STAGE_DEAL, IMPORT_STAGE_LABEL, fold, type ImportStage } from '@/domain/crm/bulkImport'
import { isPillar, phasesFor, seesByznys } from '@/lib/domain'
import { dealCurrency, isRealDay, revenueLine } from '@/lib/validation/schemas'

export const CONNECTOR_SOURCE = 'mcp_connector'
/** Nejvíc položek v jednom volání propose_deals. */
export const PROPOSE_BATCH_MAX = 30
/** Nejvíc položek v jednom volání check_deals_coverage. */
export const COVERAGE_MAX = 50
export const PROPOSAL_TEXT_LIMITS = {
  title: 300, note: 2_000, nextStep: 300, lostReason: 1_000, phase: 100, account: 200,
  contactName: 200, contactRole: 200, email: 320, phone: 50,
  sourceSubject: 200, sourcePerson: 200, sourceLabel: 200, messageId: 400, batchLabel: 120, reason: 500,
} as const
export const PROPOSAL_MONEY_MAX = 10_000_000_000
export const PROPOSAL_MD_MAX = 100_000
/** Strop jsonb návrhu (CHECK offer_check z 0099). */
export const PROPOSAL_DRAFT_MAX_BYTES = 16_384

// ---------------------------------------------------------------------------
// Stav navržené zakázky (stejná tři slova jako hromadný import, 0098)

export const PROPOSAL_STAGES = ['rozjednano', 'nabidka_odeslana', 'vyhrano'] as const
export type ProposalStage = (typeof PROPOSAL_STAGES)[number]
const STAGE_TO_IMPORT: Record<ProposalStage, ImportStage> = { rozjednano: 'draft', nabidka_odeslana: 'sent', vyhrano: 'won' }
export const PROPOSAL_STAGE_LABEL: Record<ProposalStage, string> = {
  rozjednano: IMPORT_STAGE_LABEL.draft,
  nabidka_odeslana: IMPORT_STAGE_LABEL.sent,
  vyhrano: IMPORT_STAGE_LABEL.won,
}
export function dealStageForProposal(stage: ProposalStage): (typeof IMPORT_STAGE_DEAL)[ImportStage] {
  return IMPORT_STAGE_DEAL[STAGE_TO_IMPORT[stage]]
}

// ---------------------------------------------------------------------------
// Zdroj návrhu

export const SOURCE_KINDS = ['email', 'pdf', 'transcript', 'other'] as const
export type SourceKind = (typeof SOURCE_KINDS)[number]
export const SOURCE_KIND_LABEL: Record<SourceKind, string> = {
  email: 'e-mail', pdf: 'PDF', transcript: 'přepis schůzky', other: 'jiný zdroj',
}

/**
 * Odkaz na zdroj, který se v Cockpitu ukáže jako klikací: jen https na
 * Outlook / SharePoint (odkud Claude zprávu nebo soubor čte). Jiný odkaz se
 * neuloží jako odkaz — přišel od modelu, ne ze zdrojového systému.
 */
const SOURCE_LINK_HOSTS = ['outlook.office.com', 'outlook.office365.com', 'outlook.live.com']
export function isAllowedSourceLink(raw: string | null | undefined): boolean {
  if (!raw) return false
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return false
  }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return false
  const host = url.hostname.toLowerCase()
  return SOURCE_LINK_HOSTS.includes(host) || /^[a-z0-9-]+(\.[a-z0-9-]+)*\.sharepoint\.com$/.test(host)
}

const DATE_OR_DATETIME = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/

// ---------------------------------------------------------------------------
// Vstup nástrojů

const t = (max: number, what: string) =>
  z.string().trim().min(1, `${what} nesmí být prázdné`).max(max, `${what} je delší než ${max} znaků`)
const money = (what: string) => z.number().finite(`${what} musí být číslo`)
  .min(0, `${what} nesmí být záporná`).max(PROPOSAL_MONEY_MAX, `${what} je příliš velká`)
const day = (what: string) => z.string().trim().refine(isRealDay, `${what} musí být datum ve tvaru YYYY-MM-DD`)
const md = z.number().int('estimate_md musí být celé číslo').min(0).max(PROPOSAL_MD_MAX, 'estimate_md je příliš velké')
export const contactEmailField = z.string().trim().max(PROPOSAL_TEXT_LIMITS.email, 'e-mail je moc dlouhý')
  .regex(/^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]+$/, 'e-mail nemá platný tvar')
  .transform((v) => v.toLowerCase())
export const contactPhoneField = z.string().trim().min(3, 'telefon je moc krátký').max(PROPOSAL_TEXT_LIMITS.phone, 'telefon je moc dlouhý')
  .regex(/^[0-9+()\-./ ]+$/, 'telefon smí obsahovat jen číslice, mezery a znaky + ( ) - . /')

export const proposalSourceInput = z.object({
  kind: z.enum(SOURCE_KINDS),
  message_id: t(PROPOSAL_TEXT_LIMITS.messageId, 'message_id').optional(),
  web_link: z.string().trim().max(2048).optional(),
  subject: t(PROPOSAL_TEXT_LIMITS.sourceSubject, 'subject').optional(),
  sender: t(PROPOSAL_TEXT_LIMITS.sourcePerson, 'sender').optional(),
  recipient: t(PROPOSAL_TEXT_LIMITS.sourcePerson, 'recipient').optional(),
  date: z.string().trim().regex(DATE_OR_DATETIME, 'date musí být datum (YYYY-MM-DD) nebo ISO 8601').optional(),
  label: t(PROPOSAL_TEXT_LIMITS.sourceLabel, 'label').optional(),
}).strict().refine((s) => !!(s.message_id || s.subject || s.label), {
  message: 'Zdroj (source) potřebuje aspoň message_id, subject, nebo label (název souboru / přepisu).',
})
export type ProposalSourceInput = z.infer<typeof proposalSourceInput>

export const proposalContactInput = z.object({
  full_name: t(PROPOSAL_TEXT_LIMITS.contactName, 'contact.full_name'),
  email: contactEmailField.optional(),
  phone: contactPhoneField.optional(),
  role: t(PROPOSAL_TEXT_LIMITS.contactRole, 'contact.role').optional(),
}).strict()

const accountRef = {
  account_id: z.number().int().positive().optional(),
  account_name: z.string().trim().min(2, 'account_name je moc krátký').max(PROPOSAL_TEXT_LIMITS.account).optional(),
  account_ico: z.string().trim().max(20).optional(),
}

export const proposeDealInput = z.object({
  ...accountRef,
  title: t(PROPOSAL_TEXT_LIMITS.title, 'title'),
  amount: money('amount').optional(),
  amount_min: money('amount_min').optional(),
  amount_max: money('amount_max').optional(),
  currency: dealCurrency.optional(),
  stage: z.enum(PROPOSAL_STAGES).optional(),
  cogs: money('cogs').optional(),
  estimate_md: md.optional(),
  pillar: z.string().trim().refine(isPillar, 'Neznámý pilíř (pillar).').optional(),
  phase: t(PROPOSAL_TEXT_LIMITS.phase, 'phase').optional(),
  revenue_line: revenueLine.optional(),
  expected_close: day('expected_close').optional(),
  next_step: t(PROPOSAL_TEXT_LIMITS.nextStep, 'next_step').optional(),
  next_step_due: day('next_step_due').optional(),
  note: t(PROPOSAL_TEXT_LIMITS.note, 'note').optional(),
  contact: proposalContactInput.optional(),
  source: proposalSourceInput,
}).strict().superRefine((v, ctx) => {
  if (v.account_id == null && !v.account_name) {
    ctx.addIssue({ code: 'custom', path: ['account_name'], message: 'Vyplň klienta: account_id, nebo account_name (případně s account_ico).' })
  }
  if (v.account_id != null && (v.account_name || v.account_ico)) {
    ctx.addIssue({ code: 'custom', path: ['account_id'], message: 'Vyplň jen jedno: account_id, nebo account_name.' })
  }
  if (v.amount != null && (v.amount_min != null || v.amount_max != null)) {
    ctx.addIssue({ code: 'custom', path: ['amount'], message: 'Pošli buď amount, nebo rozpětí amount_min + amount_max.' })
  }
  if ((v.amount_min == null) !== (v.amount_max == null)) {
    ctx.addIssue({ code: 'custom', path: ['amount_min'], message: 'Rozpětí potřebuje obě meze: amount_min i amount_max.' })
  } else if (v.amount_min != null && v.amount_max != null && v.amount_min > v.amount_max) {
    ctx.addIssue({ code: 'custom', path: ['amount_min'], message: 'amount_min nesmí být větší než amount_max.' })
  }
  if (v.phase && (!v.pillar || !phasesFor(v.pillar).some((p) => p.key === v.phase))) {
    ctx.addIssue({ code: 'custom', path: ['phase'], message: 'Fáze (phase) musí patřit k pilíři (pillar) a jde jen spolu s ním.' })
  }
  if (v.next_step_due && !v.next_step) {
    ctx.addIssue({ code: 'custom', path: ['next_step_due'], message: 'next_step_due jde poslat jen spolu s next_step.' })
  }
  if (v.stage === 'vyhrano' && v.next_step) {
    ctx.addIssue({ code: 'custom', path: ['next_step'], message: 'Vyhraná zakázka nemá další krok (po schválení vznikne dodávka s vlastním úkolem).' })
  }
})
export type ProposeDealInput = z.infer<typeof proposeDealInput>

/** Pole obchodu, jejichž změnu konektor jen navrhuje (schválí vedení). */
export const PROPOSE_UPDATE_FIELDS = [
  'amount', 'cogs', 'estimate_md', 'stage', 'lost_reason', 'pillar', 'phase', 'expected_close', 'next_step', 'next_step_due', 'note',
] as const
export type ProposeUpdateField = (typeof PROPOSE_UPDATE_FIELDS)[number]

export const PROPOSE_UPDATE_STAGES = ['kvalifikace', 'diagnostika', 'rozsah_nabidka', 'rozhodovani', 'vyhráno', 'prohráno', 'odloženo'] as const

export const proposeDealUpdateInput = z.object({
  deal_id: z.number().int().positive('deal_id musí být kladné celé číslo'),
  amount: money('amount').optional(),
  cogs: money('cogs').optional(),
  estimate_md: md.optional(),
  stage: z.enum(PROPOSE_UPDATE_STAGES).optional(),
  lost_reason: t(PROPOSAL_TEXT_LIMITS.lostReason, 'lost_reason').optional(),
  pillar: z.string().trim().refine(isPillar, 'Neznámý pilíř (pillar).').optional(),
  phase: t(PROPOSAL_TEXT_LIMITS.phase, 'phase').optional(),
  expected_close: day('expected_close').optional(),
  next_step: t(PROPOSAL_TEXT_LIMITS.nextStep, 'next_step').optional(),
  next_step_due: day('next_step_due').optional(),
  note: t(PROPOSAL_TEXT_LIMITS.note, 'note').optional(),
  reason: t(PROPOSAL_TEXT_LIMITS.reason, 'reason').optional(),
  source: proposalSourceInput,
}).strict().superRefine((v, ctx) => {
  if (!PROPOSE_UPDATE_FIELDS.some((k) => v[k] !== undefined)) {
    ctx.addIssue({ code: 'custom', path: ['deal_id'], message: 'Nic ke změně: pošli aspoň jedno pole (amount, cogs, stage, …).' })
  }
  if (v.stage === 'prohráno' && !v.lost_reason) {
    ctx.addIssue({ code: 'custom', path: ['lost_reason'], message: 'U prohry pošli i důvod (lost_reason).' })
  }
  if (v.lost_reason && v.stage !== 'prohráno') {
    ctx.addIssue({ code: 'custom', path: ['lost_reason'], message: 'lost_reason jde poslat jen spolu se stage „prohráno".' })
  }
})
export type ProposeDealUpdateInput = z.infer<typeof proposeDealUpdateInput>

export const coverageItemInput = z.object({
  ref: z.string().trim().max(100).optional(),
  ...accountRef,
  title: t(PROPOSAL_TEXT_LIMITS.title, 'title'),
  amount: money('amount').optional(),
  currency: dealCurrency.optional(),
  message_id: t(PROPOSAL_TEXT_LIMITS.messageId, 'message_id').optional(),
  date: z.string().trim().regex(DATE_OR_DATETIME).optional(),
}).strict().refine((v) => v.account_id != null || !!v.account_name, { message: 'Položka potřebuje account_id nebo account_name.' })
export type CoverageItemInput = z.infer<typeof coverageItemInput>

/** První chyba zod jako česká věta (neznámé pole = srozumitelně). */
export function firstProposalIssue(err: z.ZodError): string {
  const issue = err.issues[0]
  if (!issue) return 'Neplatný vstup.'
  if (issue.code === 'unrecognized_keys') return `Tohle pole v návrhu není: ${issue.keys.join(', ')}.`
  if (issue.code === 'custom' || issue.path.length === 0) return issue.message
  return `${issue.path.join('.')}: ${issue.message}`
}

// ---------------------------------------------------------------------------
// Uložený návrh (offer_draft jsonb, píše ho jen server)

export const PROPOSAL_WARNINGS = [
  'client_ambiguous', 'client_not_found', 'price_missing', 'price_estimate', 'duplicate_deal', 'duplicate_source',
  'injection', 'link_dropped', 'eur',
] as const
export type ProposalWarning = (typeof PROPOSAL_WARNINGS)[number]
export const PROPOSAL_WARNING_LABEL: Record<ProposalWarning, string> = {
  client_ambiguous: 'Klient není jistý — víc kandidátů. Vyber správného.',
  client_not_found: 'Klient v Cockpitu není — vyber z podobných, nebo založ nového.',
  price_missing: 'Chybí cena.',
  price_estimate: 'Cena je odhad (střed rozpětí).',
  duplicate_deal: 'U klienta už je podobný obchod — zvaž „Aktualizovat existující".',
  duplicate_source: 'Ze stejného zdroje už obchod nebo návrh je.',
  injection: 'Text ze zdroje vypadá, že obsahuje pokyny pro AI. Ber ho jen jako data a ověř údaje ve zdroji.',
  link_dropped: 'Odkaz na zdroj nebyl z Outlooku/SharePointu, neuložil se.',
  eur: 'Částka je v EUR — přepočte se kurzem ČNB v den schválení.',
}

const candidateSchema = z.object({ id: z.number().int().positive(), name: z.string().max(300) })
const duplicateSchema = z.object({
  deal_id: z.number().int().positive(),
  title: z.string().max(300),
  stage: z.string().max(40),
  amount_czk: z.number().nullable(),
  reason: z.enum(['same_title', 'similar_title', 'same_source']),
})

export const connectorDraftSchema = z.object({
  version: z.literal(1),
  kind: z.literal('connector_deal'),
  info_state: z.literal('ai_suggestion'),
  mode: z.enum(['create', 'update']),
  proposed_by: z.string().max(64).nullable(),
  proposed_by_name: z.string().max(200).nullable(),
  proposed_at: z.string(),
  batch: z.object({ id: z.string().max(64), label: z.string().max(PROPOSAL_TEXT_LIMITS.batchLabel) }).nullable(),
  account: z.object({
    id: z.number().int().positive().nullable(),
    name: z.string().max(300),
    ico: z.string().max(20).nullable(),
    status: z.enum(['matched', 'ambiguous', 'not_found']),
    matched_by: z.enum(['id', 'ico', 'name', 'alias']).nullable(),
    candidates: z.array(candidateSchema).max(10),
  }),
  deal_id: z.number().int().positive().nullable(),
  fields: z.object({
    title: z.string().max(PROPOSAL_TEXT_LIMITS.title),
    stage: z.enum(PROPOSAL_STAGES).nullable(),
    amount: z.number().nullable(),
    amount_range: z.object({ min: z.number(), max: z.number() }).nullable(),
    currency: dealCurrency,
    cogs: z.number().nullable(),
    estimate_md: z.number().nullable(),
    pillar: z.string().nullable(),
    phase: z.string().max(PROPOSAL_TEXT_LIMITS.phase).nullable(),
    revenue_line: revenueLine.nullable(),
    expected_close: z.string().nullable(),
    next_step: z.string().max(PROPOSAL_TEXT_LIMITS.nextStep).nullable(),
    next_step_due: z.string().nullable(),
    note: z.string().max(PROPOSAL_TEXT_LIMITS.note).nullable(),
  }),
  /** Jen u mode 'update': navržené změny existujícího obchodu. */
  changes: z.record(z.string(), z.union([z.string(), z.number(), z.null()])).nullable(),
  reason: z.string().max(PROPOSAL_TEXT_LIMITS.reason).nullable(),
  contact: z.object({
    full_name: z.string().max(PROPOSAL_TEXT_LIMITS.contactName),
    email: z.string().max(PROPOSAL_TEXT_LIMITS.email).nullable(),
    phone: z.string().max(PROPOSAL_TEXT_LIMITS.phone).nullable(),
    role: z.string().max(PROPOSAL_TEXT_LIMITS.contactRole).nullable(),
  }).nullable(),
  source: z.object({
    kind: z.enum(SOURCE_KINDS),
    message_id: z.string().max(PROPOSAL_TEXT_LIMITS.messageId).nullable(),
    web_link: z.string().max(2048).nullable(),
    subject: z.string().max(PROPOSAL_TEXT_LIMITS.sourceSubject).nullable(),
    sender: z.string().max(PROPOSAL_TEXT_LIMITS.sourcePerson).nullable(),
    recipient: z.string().max(PROPOSAL_TEXT_LIMITS.sourcePerson).nullable(),
    date: z.string().max(40).nullable(),
    label: z.string().max(PROPOSAL_TEXT_LIMITS.sourceLabel).nullable(),
  }),
  duplicates: z.array(duplicateSchema).max(10),
  warnings: z.array(z.enum(PROPOSAL_WARNINGS)).max(PROPOSAL_WARNINGS.length),
  injection_flags: z.array(z.enum(INJECTION_FLAGS)).max(INJECTION_FLAGS.length),
})
export type ConnectorDraft = z.infer<typeof connectorDraftSchema>

export function parseConnectorDraft(json: unknown): ConnectorDraft | null {
  const parsed = connectorDraftSchema.safeParse(json)
  return parsed.success ? parsed.data : null
}

/** Střed rozpětí (zaokrouhlený na koruny/eura). */
export function rangeMidpoint(min: number, max: number): number {
  return Math.round((min + max) / 2)
}

/** Varování, kvůli kterým jde návrh schválit jen po jednom (ne „Schválit vše"). */
export function blocksBulkApprove(d: Pick<ConnectorDraft, 'warnings' | 'mode' | 'account'>): boolean {
  if (d.mode === 'update') return true
  if (d.account.status !== 'matched' || d.account.id == null) return true
  return d.warnings.some((w) => w !== 'eur')
}

export function injectionWarnings(flags: readonly InjectionFlag[]): ProposalWarning[] {
  return flags.length > 0 ? ['injection'] : []
}

// ---------------------------------------------------------------------------
// Podobnost názvů obchodů (duplicity a pokrytí)

const STOP = new Set(['pro', 'and', 'the', 'nabidka', 'nabidky', 'projekt', 'zakazka', 'cenova', 'offer'])
const tokens = (s: string) => new Set(fold(s).split(' ').filter((w) => w.length >= 3 && !STOP.has(w)))

/** 1 = stejný název (bez diakritiky a velikosti), jinak Jaccard slov (0–1); obsažení = 0.8. */
export function titleSimilarity(a: string, b: string): number {
  const fa = fold(a)
  const fb = fold(b)
  if (!fa || !fb) return 0
  if (fa === fb) return 1
  if ((fa.length >= 5 && fb.includes(fa)) || (fb.length >= 5 && fa.includes(fb))) return 0.8
  const ta = tokens(a)
  const tb = tokens(b)
  if (ta.size === 0 || tb.size === 0) return 0
  let common = 0
  for (const w of ta) if (tb.has(w)) common++
  return common / (ta.size + tb.size - common)
}

export const SIMILAR_TITLE_MIN = 0.34
export const SAME_TITLE_MIN = 0.8

/** Částky „sedí", když se liší nejvýš o 2 % (zaokrouhlení, přepočet). */
export function amountsMatch(a: number | null | undefined, b: number | null | undefined): boolean {
  if (a == null || b == null) return false
  if (a === b) return true
  const max = Math.max(Math.abs(a), Math.abs(b))
  return max > 0 && Math.abs(a - b) / max <= 0.02
}

export type DealLike = {
  id: number
  title: string
  stage: string
  currency: string | null
  amount_one_time: number | null
  amount_one_time_original: number | null
}

/** Částka obchodu v měně položky (EUR obchod → původní EUR, jinak Kč). */
export function dealAmountIn(deal: DealLike, currency: 'CZK' | 'EUR'): number | null {
  if (currency === 'EUR') return deal.currency === 'EUR' ? deal.amount_one_time_original : null
  return deal.amount_one_time
}

export type DuplicateHit = z.infer<typeof duplicateSchema>

/** Podobné obchody u klienta, nejpodobnější první (nejvýš 5). */
export function similarDeals(title: string, deals: readonly DealLike[], amount: number | null, currency: 'CZK' | 'EUR'): DuplicateHit[] {
  return deals
    .map((d) => ({ d, score: titleSimilarity(title, d.title) + (amountsMatch(amount, dealAmountIn(d, currency)) ? 0.2 : 0) }))
    .filter((x) => x.score >= SIMILAR_TITLE_MIN)
    .sort((x, y) => y.score - x.score || y.d.id - x.d.id)
    .slice(0, 5)
    .map(({ d, score }) => ({
      deal_id: d.id,
      title: d.title.slice(0, 300),
      stage: d.stage,
      amount_czk: d.amount_one_time,
      reason: score >= SAME_TITLE_MIN ? 'same_title' as const : 'similar_title' as const,
    }))
}

// ---------------------------------------------------------------------------
// Pokrytí (check_deals_coverage)

export type CoverageStatus = 'in_cockpit' | 'probably_in_cockpit' | 'already_proposed' | 'missing'
export const COVERAGE_STATUS_LABEL: Record<CoverageStatus, string> = {
  in_cockpit: 'už v Cockpitu',
  probably_in_cockpit: 'pravděpodobně v Cockpitu',
  already_proposed: 'už navrženo, čeká na schválení',
  missing: 'chybí',
}

export type CoverageDiff = { amount?: { cockpit: number | null; source: number; currency: 'CZK' | 'EUR' }; stage?: string }

/**
 * Jedna položka proti obchodům klienta: stejný název (nebo podobný + stejná
 * částka) = v Cockpitu; podobný název nebo stejná částka = pravděpodobně;
 * jinak chybí. Rozdíly jen u obchodu „v Cockpitu".
 */
export function classifyAgainstDeals(
  item: { title: string; amount?: number | null; currency?: 'CZK' | 'EUR' },
  deals: readonly DealLike[],
): { status: 'in_cockpit' | 'probably_in_cockpit' | 'missing'; deal: DealLike | null; candidates: DealLike[]; diff: CoverageDiff } {
  const currency = item.currency ?? 'CZK'
  const amount = item.amount ?? null
  const scored = deals
    .map((d) => {
      const sim = titleSimilarity(item.title, d.title)
      const sameAmount = amountsMatch(amount, dealAmountIn(d, currency))
      return { d, sim, sameAmount }
    })
    .sort((a, b) => b.sim - a.sim || Number(b.sameAmount) - Number(a.sameAmount) || b.d.id - a.d.id)
  const best = scored[0]
  if (best && (best.sim >= SAME_TITLE_MIN || (best.sim >= SIMILAR_TITLE_MIN && best.sameAmount))) {
    const diff: CoverageDiff = {}
    const have = dealAmountIn(best.d, currency)
    if (amount != null && !amountsMatch(amount, have)) diff.amount = { cockpit: have, source: amount, currency }
    diff.stage = best.d.stage
    return { status: 'in_cockpit', deal: best.d, candidates: [], diff }
  }
  const candidates = scored.filter((s) => s.sim >= SIMILAR_TITLE_MIN || s.sameAmount).slice(0, 5).map((s) => s.d)
  if (candidates.length > 0) return { status: 'probably_in_cockpit', deal: null, candidates, diff: {} }
  return { status: 'missing', deal: null, candidates: [], diff: {} }
}

// ---------------------------------------------------------------------------
// Dávka

const czPlural = (n: number) => (n === 1 ? 'zakázka' : n >= 2 && n <= 4 ? 'zakázky' : 'zakázek')

/** „Z odeslané pošty 20.–24. 10., 6 zakázek" z dat zdrojů (YYYY-MM-DD…). */
export function batchLabel(dates: readonly (string | null | undefined)[], count: number, prefix = 'Z odeslané pošty'): string {
  const days = dates
    .map((d) => /^(\d{4})-(\d{2})-(\d{2})/.exec(d ?? ''))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ key: `${m[1]}${m[2]}${m[3]}`, d: Number(m[3]), m: Number(m[2]) }))
    .sort((a, b) => a.key.localeCompare(b.key))
  const tail = `${count} ${czPlural(count)}`
  if (days.length === 0) return `${prefix}, ${tail}`.slice(0, PROPOSAL_TEXT_LIMITS.batchLabel)
  const first = days[0]
  const last = days[days.length - 1]
  const span = first.key === last.key
    ? `${first.d}. ${first.m}.`
    : first.m === last.m ? `${first.d}.–${last.d}. ${last.m}.` : `${first.d}. ${first.m}.–${last.d}. ${last.m}.`
  return `${prefix} ${span}, ${tail}`.slice(0, PROPOSAL_TEXT_LIMITS.batchLabel)
}

// ---------------------------------------------------------------------------
// Kdo schvaluje

/**
 * Schválit nebo zamítnout návrh z konektoru smí člen s přístupem k obchodu
 * (vedení, obchodník) a zároveň s rolí vedení, nebo admin. Včetně toho, jehož
 * jménem Claude návrh poslal (rozhodnutí majitele — viz hlavička souboru).
 * Deaktivovaný člen sem nedojde (getCurrentMember vrací member null).
 */
export function canApproveConnectorProposals(
  member: { role?: string | null; is_admin?: boolean | null; deactivated_at?: string | null } | null | undefined,
): boolean {
  if (!member || member.deactivated_at) return false
  if (!seesByznys(member.role)) return false
  return member.role === 'vedeni' || member.is_admin === true
}

export const APPROVER_REQUIRED = 'Návrhy zakázek z konektoru schvaluje jen vedení nebo admin (s přístupem k obchodu).'

// ---------------------------------------------------------------------------
// Výsledek pro get_proposals

export const PROPOSAL_STATUS_LABEL = {
  pending: 'čeká na schválení',
  approved: 'schváleno',
  rejected: 'zamítnuto',
  expired: 'vypršelo (30 dní bez rozhodnutí)',
} as const
export type ProposalStatus = keyof typeof PROPOSAL_STATUS_LABEL

export function proposalStatusOf(status: string): ProposalStatus {
  if (status === 'queued') return 'pending'
  if (status === 'proposed') return 'approved'
  if (status === 'discarded') return 'rejected'
  return 'expired'
}

/** Mezera, kterou fronta potřebuje: návrhy bez migrace 0091/0099. */
export const PROPOSALS_PENDING_MESSAGE =
  'Fronta návrhů zakázek v Cockpitu se teprve připravuje (chybí migrace 0091/0099). Nic se nezapsalo — řekni uživateli, ať návrh zatím založí ručně.'
