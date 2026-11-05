// Kvalifikace signálu podle ICP firmy (P7). Deterministická pravidla bez
// modelu a bez I/O: co o firmě víme (ARES, CRM) přijde jako kontext.
// Výsledek: skóre 0–100, rozhodnutí a kódy důvodů (do outbound_signal.reason_codes).
//
//   blocked  — tvrdé vyloučení (vyloučená firma/obor, nesouhlas s oslovením)
//   dismiss  — nemá smysl (rozjednaný obchod, nedávno osloveno, nízká relevance)
//   review   — nejasné nebo hraniční → rozhodne CSO na stránce Signály
//   lead     — agent sám založí lead v CRM
import type { OutboundAgentConfig } from './config'
import { fold, type SignalCandidate, type SignalKind } from './signal'

export const QUALIFY_REASONS = [
  'excluded_company', 'excluded_name', 'excluded_nace', 'opted_out',
  'open_deal', 'cooldown', 'low_relevance',
  'company_unknown', 'company_verified', 'natural_person',
  'region_match', 'region_outside', 'region_unknown',
  'size_ok', 'too_small', 'size_unknown',
  'existing_customer', 'facts_rich', 'no_facts',
] as const
export type QualifyReason = (typeof QUALIFY_REASONS)[number]

export const QUALIFY_REASON_LABELS: Readonly<Record<QualifyReason, string>> = {
  excluded_company: 'firma je na seznamu vyloučených',
  excluded_name: 'název firmy obsahuje vyloučené slovo',
  excluded_nace: 'obor firmy se neoslovuje (např. konkurence)',
  opted_out: 'firma nebo kontakt nesouhlasí s oslovením',
  open_deal: 's firmou už běží obchod',
  cooldown: 'firmu jsme nedávno oslovili',
  low_relevance: 'nízká relevance',
  company_unknown: 'firmu se nepodařilo jednoznačně určit',
  company_verified: 'firma ověřená v ARES',
  natural_person: 'jde nejspíš o fyzickou osobu (OSVČ) — oslovení jen ručně',
  region_match: 'sídlo v cílovém regionu',
  region_outside: 'sídlo mimo cílový region',
  region_unknown: 'region neznámý',
  size_ok: 'velikost firmy odpovídá',
  too_small: 'firma je menší než cílová velikost',
  size_unknown: 'velikost firmy neznámá',
  existing_customer: 'stávající klient',
  facts_rich: 'signál má ověřená fakta',
  no_facts: 'signál nemá žádná ověřená fakta',
}

export type QualifyDecision = 'converted' | 'review' | 'dismiss' | 'blocked'

/** Co o firmě signálu víme (ARES a CRM). Vše volitelné — chybějící = neznámé. */
export interface QualifyContext {
  /** Údaje z ARES (ověřené); null = ARES firmu nezná nebo se nevolal. */
  ares: {
    ico: string
    legalName: string
    city: string | null
    region: string | null
    nace: readonly string[]
    /** Právní forma (kód ARES) — 101–108 = fyzická osoba podnikající. */
    legalFormCode?: string | null
    employees?: number | null
  } | null
  crm: {
    accountId: number | null
    relationship: 'klient' | 'aktivni_obchod' | 'prospekt' | null
    /** Všichni lidé u firmy (nebo poznámka firmy) nesouhlasí s oslovením. */
    optedOut: boolean
    /** Oslovení stejné firmy v posledních cooldownDays dnech. */
    recentlyContacted: boolean
    employees?: number | null
  }
}

export interface QualifyResult {
  decision: QualifyDecision
  score: number
  reasons: QualifyReason[]
}

const BASE_SCORE: Readonly<Record<SignalKind, number>> = {
  public_tender: 55,
  crm_anniversary: 55,
  crm_season: 50,
  event: 35,
  job_posting: 30,
  company_change: 25,
}

/** Právní formy fyzických osob v ARES (číselník právních forem ČSÚ 101–108). */
const NATURAL_PERSON_FORMS = new Set(['101', '102', '103', '104', '105', '106', '107', '108'])

function regionMatches(values: readonly (string | null | undefined)[], regions: readonly string[]): boolean | null {
  const present = values.filter((v): v is string => !!v && !!v.trim())
  if (!present.length) return null
  return present.some((v) => regions.some((r) => fold(v).startsWith(fold(r))))
}

export function qualifySignal(signal: SignalCandidate, ctx: QualifyContext, config: OutboundAgentConfig): QualifyResult {
  const { icp, scoring } = config
  const reasons: QualifyReason[] = []
  const ico = ctx.ares?.ico ?? signal.company.ico
  const name = ctx.ares?.legalName ?? signal.company.name ?? ''

  // --- Tvrdé vyloučení: platí vždy, skóre je přebít nemůže.
  if (ico && icp.excludedIcos.includes(ico)) reasons.push('excluded_company')
  if (name && icp.excludedNameKeywords.some((k) => fold(name).includes(fold(k)))) reasons.push('excluded_name')
  if (ctx.ares?.nace.some((n) => icp.excludedNacePrefixes.some((p) => n.startsWith(p)))) reasons.push('excluded_nace')
  if (ctx.crm.optedOut) reasons.push('opted_out')
  if (reasons.length) return { decision: 'blocked', score: 0, reasons }

  // --- Nemá smysl: rozjednané nebo nedávno oslovené.
  if (ctx.crm.relationship === 'aktivni_obchod') return { decision: 'dismiss', score: 0, reasons: ['open_deal'] }
  if (ctx.crm.recentlyContacted) return { decision: 'dismiss', score: 0, reasons: ['cooldown'] }

  let score = BASE_SCORE[signal.kind]
  let capAtReview = false

  const isCustomer = ctx.crm.relationship === 'klient'
  if (isCustomer) { score += 15; reasons.push('existing_customer') }

  if (ctx.ares) { score += 10; reasons.push('company_verified') }
  else if (!ctx.crm.accountId) { capAtReview = true; reasons.push('company_unknown') }

  if (ctx.ares?.legalFormCode && NATURAL_PERSON_FORMS.has(ctx.ares.legalFormCode)) {
    capAtReview = true
    reasons.push('natural_person')
  }

  const region = regionMatches([ctx.ares?.city, ctx.ares?.region], icp.regions)
  if (region === true) { score += 20; reasons.push('region_match') }
  else if (region === false) { score -= 25; capAtReview = true; reasons.push('region_outside') }
  else reasons.push('region_unknown')

  const employees = ctx.ares?.employees ?? ctx.crm.employees ?? null
  if (icp.minEmployees != null) {
    if (employees == null) reasons.push('size_unknown')
    else if (employees >= icp.minEmployees) { score += 10; reasons.push('size_ok') }
    else { score -= 20; reasons.push('too_small') }
  }

  if (signal.facts.length >= 2) { score += 5; reasons.push('facts_rich') }
  else if (signal.facts.length === 0) { score -= 10; reasons.push('no_facts') }

  score = Math.max(0, Math.min(100, Math.round(score)))

  if (score >= scoring.leadThreshold && !capAtReview) return { decision: 'converted', score, reasons }
  if (score >= scoring.reviewThreshold || (capAtReview && score >= scoring.reviewThreshold - 15)) {
    return { decision: 'review', score, reasons }
  }
  return { decision: 'dismiss', score, reasons: [...reasons, 'low_relevance'] }
}
