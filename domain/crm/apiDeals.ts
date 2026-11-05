import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/admin'
import { createAuditedAdminClient } from '@/core/auditDb'
import type { AuditActor } from '@/core/audit'
import { detectInjectionMarkers, type InjectionFlag } from '@/core/untrusted'
import { dbErrorMessage } from '@/lib/actionResult'
import { logError, logWarn } from '@/lib/log'
import { czkPerEur } from '@/connectors/cnb'
import { shouldFreezeRate } from '@/domain/finance/fx'
import { DEAL_STAGE_KEYS, defaultProbabilityForStage, isPillar, phasesFor } from '@/lib/domain'
import { isRealDay } from '@/lib/validation/schemas'
import { normalizeDealStage } from '@/lib/dealStageLegacy'
import { pragueToday } from '@/lib/pragueDate'
import { DEAL_TRANSITION_MESSAGES, dealTransitionDbMessage, transitionIssues } from '@/domain/crm/dealTransition'
import { hasManualProbability } from '@/domain/crm/sales'
import { SALES_ONLY_ERROR, type WriteResult } from '@/domain/crm/apiWrite'

// Úprava obchodů přes API/MCP (update_deal) a sdílené jádro úprav obchodu
// pro schválené návrhy z konektoru (domain/crm/connectorProposals.ts).
//
// ROZHODNUTÍ MAJITELE (20. 10. 2026): konektor (Claude v claude.ai / Coworku)
// obchod NEZAKLÁDÁ a nemění jeho peníze ani stav napřímo. Přímo (update_deal)
// smí jen bezpečná pole SAFE_UPDATE_DEAL_FIELDS: další krok a termín,
// poznámku, očekávané uzavření a odhad MD. Nový obchod (propose_deal) a změna
// částky, nákladu, fáze, pilíře nebo důvodu prohry (propose_deal_update) jdou
// jako NÁVRH do fronty ke schválení vedením v Cockpitu (/rozhodnuti); teprve
// schválení je provede — přes applyDealChanges níže, jménem schvalovatele.
//
// Pravidla úprav jsou stejná jako v UI (domain/crm/actions/deals.ts a sales.ts):
//   * jen obchodní role (obchody a částky, 0058),
//   * povinná pole při přechodu fáze (dealTransition: Rozhodování jen se
//     známým rozhodovatelem a termínem, Prohráno jen s důvodem); DB trigger
//     0052 to hlídá i tak a jeho chybu (CR001/CR002) překládáme,
//   * EUR se přepočítá živým kurzem ČNB, u uzavřeného obchodu s nezměněnou
//     částkou zůstane zmrazený kurz (shouldFreezeRate),
//   * úprava jen VYJMENOVANÝCH polí (whitelisty níže); nic se nemaže.
//
// Odeslání nabídky tudy NEJDE: verze nabídky (deal_scope_version) a jejich
// schválení k odeslání (approval_request, 0084) se tu nečtou ani nemění.
//
// Audit: zápis jde přes admin klienta s hlavičkou aktéra (API klíč vlastníka,
// u schváleného návrhu přihlášený schvalovatel), takže DB triggery 0034/0035
// (cena, fáze, peníze) a 0064 (ostatní sloupce) zapíšou změnu jeho jménem.
// Textová pole jsou data (často z e-mailů nebo PDF): neprovádí se, jen se
// uloží; známky pokynů pro AI se vrátí jako upozornění a zalogují (bez textu).

export const API_DEAL_TEXT_LIMITS = { title: 300, note: 5_000, nextStep: 300, lostReason: 1_000, phase: 100 } as const
export const API_MONEY_MAX = 10_000_000_000
export const API_MD_MAX = 100_000

export const money = (what: string) => z.number().finite(`${what} musí být číslo`)
  .min(0, `${what} nesmí být záporná`).max(API_MONEY_MAX, `${what} je příliš velká`)
export const text = (max: number, what: string) =>
  z.string().trim().min(1, `${what} nesmí být prázdný`).max(max, `${what} je delší než ${max} znaků`)
export const day = (what: string) => z.string().trim().refine(isRealDay, `${what} musí být datum ve tvaru YYYY-MM-DD`)
export const md = z.number().int('estimate_md musí být celé číslo').min(0, 'estimate_md nesmí být záporné').max(API_MD_MAX, 'estimate_md je příliš velké')
export const pillarField = z.string().trim().refine(isPillar, 'Neznámý pilíř (pillar).')

// Whitelist úprav. `null` = vyprázdnit pole; chybějící klíč = beze změny.
export const UPDATE_DEAL_FIELDS = [
  'amount', 'cogs', 'estimate_md', 'stage', 'lost_reason', 'pillar', 'phase',
  'expected_close', 'next_step', 'next_step_due', 'note',
] as const

export const updateDealInput = z.object({
  deal_id: z.number().int().positive('deal_id musí být kladné celé číslo'),
  amount: money('amount').nullable().optional(),
  cogs: money('cogs').nullable().optional(),
  estimate_md: md.nullable().optional(),
  stage: z.enum(DEAL_STAGE_KEYS).optional(),
  lost_reason: text(API_DEAL_TEXT_LIMITS.lostReason, 'lost_reason').optional(),
  pillar: pillarField.nullable().optional(),
  phase: text(API_DEAL_TEXT_LIMITS.phase, 'phase').nullable().optional(),
  expected_close: day('expected_close').nullable().optional(),
  next_step: text(API_DEAL_TEXT_LIMITS.nextStep, 'next_step').nullable().optional(),
  next_step_due: day('next_step_due').nullable().optional(),
  note: text(API_DEAL_TEXT_LIMITS.note, 'note').nullable().optional(),
}).strict()

/** Co smí konektor změnit přímo (bez schválení). Zbytek = propose_deal_update. */
export const SAFE_UPDATE_DEAL_FIELDS = ['estimate_md', 'expected_close', 'next_step', 'next_step_due', 'note'] as const

export const safeUpdateDealInput = updateDealInput.pick({
  deal_id: true, estimate_md: true, expected_close: true, next_step: true, next_step_due: true, note: true,
})

export type UpdateDealInput = z.infer<typeof updateDealInput>

export const NEEDS_APPROVAL =
  'Tohle pole konektor přímo měnit nesmí (částka, náklad, fáze, pilíř, důvod prohry): pošli změnu přes propose_deal_update, '
  + 'schválí ji vedení v Cockpitu.'

export const DEAL_NOT_FOUND = 'Obchod nenalezen.'
export const FX_FAILED = 'Přepočet z EUR se nepovedl (kurz ČNB je teď nedostupný). Zkus to prosím za chvíli.'
export const LOST_REASON_REQUIRED = 'U prohraného obchodu pošli i důvod prohry (lost_reason).'
export const LOST_REASON_ONLY_WITH_LOST = 'lost_reason jde poslat jen spolu se stage „prohráno".'
export const NOTHING_TO_UPDATE = 'Nic ke změně: pošli aspoň jedno pole z whitelistu.'
export const CLOSED_NEXT_STEP = 'Uzavřený obchod (vyhráno, prohráno) nemá další krok. Neposílej next_step spolu s uzavřením.'

function failed(error: string, status = 400): WriteResult<never> {
  return { ok: false, status, error }
}

function firstIssue(err: z.ZodError): string {
  const issue = err.issues[0]
  if (!issue) return 'Neplatný vstup.'
  if (issue.code === 'unrecognized_keys') {
    return `Tohle pole přes konektor zadat nejde: ${issue.keys.join(', ')}.`
  }
  return issue.message
}

/** Pilíř a fáze: fáze musí patřit pilíři (lib/domain.ts, config firmy). */
export function phaseProblem(pillar: string | null, phase: string | null): string | null {
  if (phase == null) return null
  if (pillar == null) return 'Fáze (phase) jde zadat jen spolu s pilířem (pillar).'
  const phases = phasesFor(pillar)
  if (phases.some((p) => p.key === phase)) return null
  return `Fáze „${phase}" nepatří k pilíři „${pillar}". Možné fáze: ${phases.map((p) => p.key).join(', ')}.`
}

export function injectionFlagsOf(...texts: (string | null | undefined)[]): InjectionFlag[] {
  return detectInjectionMarkers(texts.filter((t): t is string => typeof t === 'string' && t !== '').join('\n'))
}

export type AmountColumns = { amount_one_time: number | null; amount_one_time_original: number | null; fx_rate: number | null }

export async function amountColumns(
  currency: 'CZK' | 'EUR',
  amount: number | null,
  existing: { stage: string; currency: string; amount_one_time: unknown; amount_one_time_original: unknown; fx_rate: unknown } | null,
): Promise<AmountColumns> {
  if (currency === 'CZK') return { amount_one_time: amount, amount_one_time_original: null, fx_rate: null }
  if (amount == null) return { amount_one_time: null, amount_one_time_original: null, fx_rate: null }
  if (existing && shouldFreezeRate(existing as Parameters<typeof shouldFreezeRate>[0], { currency, amount_one_time_original: amount })
    && existing.fx_rate != null && existing.amount_one_time != null) {
    return { amount_one_time: Number(existing.amount_one_time), amount_one_time_original: amount, fx_rate: Number(existing.fx_rate) }
  }
  const rate = await czkPerEur()
  return { amount_one_time: Math.round(amount * rate), amount_one_time_original: amount, fx_rate: rate }
}

type ExistingDeal = {
  id: number
  account_id: number
  stage: string
  currency: string
  amount_one_time: number | string | null
  amount_one_time_original: number | string | null
  fx_rate: number | string | null
  probability_pct: number | string | null
  pillar: string | null
  phase: string | null
  lost_reason?: string | null
  decision_maker?: string | null
  decision_due?: string | null
}

export type UpdatedDeal = {
  id: number
  account_id: number
  /** Názvy změněných sloupců (bez hodnot). */
  changed: string[]
  injection_flags?: InjectionFlag[]
}

/**
 * Úprava obchodu přímo z konektoru/API: jen SAFE_UPDATE_DEAL_FIELDS (další
 * krok a termín, poznámka, očekávané uzavření, MD). Peníze a stav jdou přes
 * návrh (propose_deal_update) a schválení vedením.
 */
export async function updateDealForApi(
  raw: unknown,
  createdBy: string | null,
  canSeeSales: boolean,
): Promise<WriteResult<UpdatedDeal>> {
  if (!canSeeSales) return failed(SALES_ONLY_ERROR, 403)
  const parsed = safeUpdateDealInput.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    if (issue?.code === 'unrecognized_keys' && issue.keys.some((k) => (UPDATE_DEAL_FIELDS as readonly string[]).includes(k))) {
      return failed(NEEDS_APPROVAL, 403)
    }
    return failed(firstIssue(parsed.error))
  }
  return applyDealChanges(parsed.data, { type: 'api_key', id: createdBy })
}

/**
 * Jádro úpravy obchodu: pole z UPDATE_DEAL_FIELDS jménem `actor`. Volá ho
 * update_deal (jen bezpečná pole, už ověřená výš) a schválení návrhu
 * z konektoru (aktér = přihlášený schvalovatel). Změna fáze má stejné
 * důsledky jako přetažení v pipeline (updateDealStage): pravděpodobnost,
 * prognóza, datum uzavření/výhry, u uzavření smazaný další krok.
 * Oprávnění si hlídá volající.
 */
export async function applyDealChanges(input: UpdateDealInput, actor: AuditActor): Promise<WriteResult<UpdatedDeal>> {
  const has = (k: (typeof UPDATE_DEAL_FIELDS)[number]) => Object.prototype.hasOwnProperty.call(input, k) && input[k] !== undefined
  if (!UPDATE_DEAL_FIELDS.some(has)) return failed(NOTHING_TO_UPDATE)
  if (has('lost_reason') && input.stage !== 'prohráno') return failed(LOST_REASON_ONLY_WITH_LOST)

  // select('*'): pole z 0052 (rozhodovatel, termín) před migrací chybí →
  // transitionIssues je nekontroluje (DB je tehdy taky nevynucuje).
  const check = createAdminClient()
  const { data: found, error: readError } = await check.from('deal').select('*').eq('id', input.deal_id).maybeSingle()
  if (readError) return failed(dbErrorMessage('apiDeals.update', readError), 500)
  if (!found) return failed(DEAL_NOT_FOUND, 404)
  const existing = found as ExistingDeal
  const currentStage = normalizeDealStage(existing.stage) ?? existing.stage

  const u: Record<string, unknown> = {}

  // Pilíř a fáze: výsledná dvojice musí dávat smysl.
  if (has('pillar') || has('phase')) {
    const pillar = has('pillar') ? (input.pillar ?? null) : existing.pillar
    const phase = has('phase') ? (input.phase ?? null) : existing.phase
    const problem = phaseProblem(pillar, phase)
    if (problem) {
      return failed(has('phase') ? problem : `${problem} Pošli spolu s pilířem i novou fázi (nebo phase: null).`)
    }
    if (has('pillar')) u.pillar = pillar
    if (has('phase')) u.phase = phase
  }

  if (has('amount')) {
    try {
      Object.assign(u, await amountColumns(existing.currency === 'EUR' ? 'EUR' : 'CZK', input.amount ?? null, existing))
    } catch (e) {
      logError('apiDeals.fx', e)
      return failed(FX_FAILED, 503)
    }
  }
  if (has('cogs')) u.cogs_one_time = input.cogs ?? null
  if (has('estimate_md')) u.estimate_md = input.estimate_md ?? null
  if (has('expected_close')) u.expected_close = input.expected_close ?? null
  if (has('note')) u.note = input.note ?? null
  if (has('next_step')) u.next_step = input.next_step ?? null
  if (has('next_step_due')) u.next_step_due = input.next_step_due ?? null

  const target = input.stage
  if (target && target !== currentStage) {
    if (target === 'prohráno' && !input.lost_reason) return failed(LOST_REASON_REQUIRED)
    const issues = transitionIssues({ ...existing, lost_reason: input.lost_reason ?? null }, target)
    if (issues.length) {
      return failed(`${issues.map((i) => DEAL_TRANSITION_MESSAGES[i]).join(' ')} Doplň to v Cockpitu v úpravě obchodu.`)
    }
    const closed = target === 'vyhráno' || target === 'prohráno'
    if (closed && (input.next_step || input.next_step_due)) return failed(CLOSED_NEXT_STEP)
    const today = pragueToday()
    u.stage = target
    u.forecast_category = closed ? 'closed' : 'pipeline'
    u.closed_at = closed ? today : null
    u.lost_reason = target === 'prohráno' ? input.lost_reason : null
    if (closed || !hasManualProbability(existing)) u.probability_pct = defaultProbabilityForStage(target)
    if (target === 'vyhráno') u.won_at = today
    else if (currentStage === 'vyhráno') u.won_at = null
    if (closed) {
      u.next_step = null
      u.next_step_due = null
    }
  } else if (target === 'prohráno' && input.lost_reason) {
    // Obchod už prohraný je: jen se upřesní důvod.
    u.lost_reason = input.lost_reason
  }

  const changed = Object.keys(u).sort()
  if (changed.length === 0) return { ok: true, data: { id: existing.id, account_id: existing.account_id, changed } }

  const admin = createAuditedAdminClient({ actor })
  const { data, error } = await admin.from('deal').update(u).eq('id', existing.id).select('id').maybeSingle()
  if (error) return failed(dealTransitionDbMessage(error) ?? dbErrorMessage('apiDeals.update', error), dealTransitionDbMessage(error) ? 400 : 500)
  if (!data) return failed(DEAL_NOT_FOUND, 404)

  const flags = injectionFlagsOf(input.note, input.next_step, input.lost_reason)
  if (flags.length > 0) logWarn('api.deal', 'text obchodu nese příznaky možných pokynů pro AI', { flags, deal: existing.id })
  return {
    ok: true,
    data: {
      id: existing.id,
      account_id: existing.account_id,
      changed,
      ...(flags.length > 0 ? { injection_flags: flags } : {}),
    },
  }
}
