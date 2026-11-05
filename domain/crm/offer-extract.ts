// Pure sanitization of whatever JSON the extraction model returned. No
// network, no DB — keeps the risky "trust an LLM's output" boundary
// unit-testable and separate from the Anthropic call and the DB write.
//
// Výstup modelu je NEDŮVĚRYHODNÝ (model četl cizí PDF, které mohlo obsahovat
// pokyny pro AI). Proto:
// - každé pole prochází zod schématem (offerExtractionSchema): špatný typ,
//   neznámá hodnota číselníku nebo podezřele dlouhý text = null + varování,
//   nikdy výjimka kvůli jednomu poli,
// - z textových polí a z hlášení modelu (document_instructions) se počítají
//   příznaky možné prompt injection (core/untrusted.ts) — neblokují, jen se
//   ukážou člověku a zapíšou do auditu,
// - výsledek je jen NÁVRH AI (info_state ai_suggestion); obchod z něj
//   zakládá až potvrzení člověkem v domain/crm/actions/offers.ts.
import { z } from 'zod'
import { isPillar, phasesFor, type Pillar } from '@/lib/domain'
import type { RevenueLine } from '@/lib/types'
import type { RawExtraction } from '@/connectors/anthropic'
import { detectInjectionMarkers, mergeInjectionFlags, sanitizeUntrustedText, type InjectionFlag } from '@/core/untrusted'

export const REVENUE_LINES: RevenueLine[] = [
  'catering_firemni', 'oslava_soukroma', 'svatebni_hostina', 'cheesecaky_eshop',
  'firemni_pravidelny', 'pronajem_prostor', 'provize',
]
const DEFAULT_REVENUE_LINE: RevenueLine = 'svatebni_hostina'

// Stropy délek. Delší text z nabídky není název firmy ani projektu — je to
// skoro jistě vytažený odstavec (nebo pokus něco propašovat), proto null.
export const OFFER_TEXT_LIMITS = { account_name: 200, title: 300, phase: 60, document_instructions: 500 } as const
// Horní mez částek a MD — nad tím jde o nesmysl (nebo manipulaci), ne o nabídku.
export const OFFER_AMOUNT_MAX = 1_000_000_000
export const OFFER_MD_MAX = 10_000

export type SanitizedOfferFields = {
  account_name: string
  title: string
  pillar: Pillar | null
  phase: string | null
  revenue_line: RevenueLine
  // Měna, ve které jsou amount_one_time/cogs_one_time zapsané — ještě NEJSOU
  // přepočtené na Kč. Přepočet (živý kurz ČNB) dělá domain/crm/actions/offers.ts,
  // stejně jako u ručního formuláře, aby byl kurz konzistentní napříč appkou.
  currency: 'CZK' | 'EUR'
  amount_one_time: number | null
  cogs_one_time: number | null
  estimate_md: number | null
  expected_close: string | null
}

// Pole, které nikdy neselže: chybějící klíč i jakákoli hodnota projde přes
// `fn` (zod 4 bez .optional() by chybějící klíč odmítl jako „nonoptional").
const field = <T>(fn: (v: unknown) => T) => z.unknown().optional().transform(fn)

// Text: očistit neviditelné znaky, ořezat; prázdné/příliš dlouhé/ne-string = null.
const lenientText = (max: number) =>
  field((v) => {
    if (typeof v !== 'string') return null
    const clean = sanitizeUntrustedText(v, Number.MAX_SAFE_INTEGER).text.trim()
    return clean && clean.length <= max ? clean : null
  })

// Číslo: number nebo číselný řetězec; konečné, v mezích. Jinak null.
const lenientNumber = (max: number) =>
  field((v) => {
    if (v == null || v === '' || typeof v === 'boolean') return null
    const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.replace(/\s/g, '').replace(',', '.')) : NaN
    return Number.isFinite(n) && n >= 0 && n <= max ? n : null
  })

const isoDate = field((v) => {
  if (typeof v !== 'string') return null
  const s = v.trim()
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null
  const d = new Date(`${s}T00:00:00Z`)
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s ? s : null
})

/**
 * Zod schéma výstupu modelu. Nikdy neselže na jednotlivém poli — každé
 * pole se buď přijme, nebo je null (sanitizeExtraction pak přidá varování).
 * Selže jen, když výstup vůbec není objekt.
 */
export const offerExtractionSchema = z.object({
  account_name: lenientText(OFFER_TEXT_LIMITS.account_name),
  title: lenientText(OFFER_TEXT_LIMITS.title),
  pillar: field((v): Pillar | null => (isPillar(v) ? v : null)),
  phase: lenientText(OFFER_TEXT_LIMITS.phase),
  revenue_line: field((v): RevenueLine | null =>
    REVENUE_LINES.includes(v as RevenueLine) ? (v as RevenueLine) : null),
  currency: field((v): 'CZK' | 'EUR' => (v === 'EUR' ? 'EUR' : 'CZK')),
  amount_one_time: lenientNumber(OFFER_AMOUNT_MAX),
  cogs_one_time: lenientNumber(OFFER_AMOUNT_MAX),
  estimate_md: lenientNumber(OFFER_MD_MAX),
  expected_close: isoDate,
  document_instructions: lenientText(OFFER_TEXT_LIMITS.document_instructions),
})

export type OfferExtraction = {
  fields: SanitizedOfferFields
  warnings: string[]
  /** Příznaky možné prompt injection (prázdné = nic podezřelého). */
  flags: InjectionFlag[]
}

export function sanitizeExtraction(raw: RawExtraction | unknown): OfferExtraction {
  const parsed = offerExtractionSchema.safeParse(raw ?? {})
  if (!parsed.success) throw new Error('sanitizeExtraction: model output is not an object')
  const p = parsed.data

  const account_name = p.account_name
  if (!account_name) throw new Error('sanitizeExtraction: account_name missing from model output')

  const warnings: string[] = []

  const title = p.title ?? account_name
  if (!p.title) warnings.push('chybí název projektu (použit název klienta)')

  const pillar = p.pillar
  if (!pillar) warnings.push('chybí pilíř')

  const phase = pillar && p.phase && phasesFor(pillar).some((ph) => ph.key === p.phase) ? p.phase : null
  if (pillar && !phase) warnings.push('chybí fáze')

  const revenue_line = p.revenue_line ?? DEFAULT_REVENUE_LINE
  if (!p.revenue_line) warnings.push('chybí typ výnosu (nastaven výchozí)')

  const amount_one_time = p.amount_one_time
  if (amount_one_time == null) warnings.push('chybí částka')

  // Příznaky: text, který model z PDF vytáhl (surový, před ořezáním, aby se
  // počítaly i neviditelné znaky), a co model sám nahlásil jako pokyny.
  const rawText = [raw && typeof raw === 'object' ? (raw as RawExtraction) : {}]
    .flatMap((r) => [r.account_name, r.title, r.phase, r.expected_close, r.document_instructions])
    .filter((v): v is string => typeof v === 'string')
    .join('\n')
  const flags = mergeInjectionFlags(
    detectInjectionMarkers(rawText),
    p.document_instructions ? ['model_reported'] : [],
  )
  if (flags.length > 0) warnings.push('dokument obsahuje text, který vypadá jako pokyny pro AI — ověř údaje proti PDF')

  return {
    fields: {
      account_name, title, pillar, phase, revenue_line, currency: p.currency,
      amount_one_time, cogs_one_time: p.cogs_one_time, estimate_md: p.estimate_md, expected_close: p.expected_close,
    },
    warnings,
    flags,
  }
}
