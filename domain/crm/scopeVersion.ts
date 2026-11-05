// Verze rozsahu nabídky (kap. 5 plánu přestavby, migrace 0072).
//
// Čisté funkce bez I/O: stavy a přechody verzí, návrh nové verze z poslední,
// validace formuláře a překlad chyb strážce z DB na českou větu.
// SCOPE_VERSION_TRANSITIONS MUSÍ zůstat shodná s funkcí
// deal_scope_version_transition_ok v 0072 (test/scope-version.test.ts je
// porovnává).
import { z } from 'zod'
import { approvalActionsConfig } from '@/core/approvalActions'

export const SCOPE_VERSION_STATUSES = ['draft', 'sent', 'accepted', 'rejected', 'superseded'] as const
export type ScopeVersionStatus = (typeof SCOPE_VERSION_STATUSES)[number]
export type ScopeCurrency = 'CZK' | 'EUR'

export const SCOPE_VERSION_STATUS_LABEL: Record<ScopeVersionStatus, string> = {
  draft: 'Koncept',
  sent: 'Odesláno',
  accepted: 'Přijato',
  rejected: 'Odmítnuto',
  superseded: 'Nahrazeno',
}

export const SCOPE_VERSION_STATUS_TONE: Record<ScopeVersionStatus, string> = {
  draft: 'neutral',
  sent: 'steel',
  accepted: 'pos',
  rejected: 'neg',
  superseded: 'ink',
}

export const SCOPE_VERSION_TRANSITIONS: Record<ScopeVersionStatus, readonly ScopeVersionStatus[]> = {
  draft: ['sent', 'superseded'],
  sent: ['accepted', 'rejected', 'superseded'],
  accepted: ['superseded'],
  rejected: [],
  superseded: [],
}

export function isScopeVersionStatus(v: unknown): v is ScopeVersionStatus {
  return typeof v === 'string' && (SCOPE_VERSION_STATUSES as readonly string[]).includes(v)
}

export function canTransitionScopeVersion(from: ScopeVersionStatus, to: ScopeVersionStatus): boolean {
  return SCOPE_VERSION_TRANSITIONS[from].includes(to)
}

// Akce, které člověk v UI smí u verze spustit. superseded se ručně nenastavuje —
// dělá ho přijetí jiné verze. Koncept, který před odesláním potřebuje schválení
// (0084), nabídne místo „Odeslat" žádost o schválení; čekající žádost nenabídne nic.
export type ScopeVersionAction = 'send' | 'accept' | 'reject' | 'request_send'
export function scopeVersionActions(status: ScopeVersionStatus, sendState: ScopeSendState = 'free'): ScopeVersionAction[] {
  if (status === 'draft') {
    if (sendState === 'needs_approval') return ['request_send']
    if (sendState === 'pending') return []
    return ['send']
  }
  if (status === 'sent') return ['accept', 'reject']
  return []
}

// --- Schválení odeslání (0084) --------------------------------------------------
//
// „Odeslat nabídku klientovi" je nevratná externí akce: Cockpit nic neodesílá.
// Když to šablona procesu vyžaduje (config: approvalActions.sendOffer
// .requireApprovalFromCzk), jde koncept označit jako odeslaný až po schválené
// žádosti (DB strážce SV006). Zrcadlo SQL funkce approval_offer_requires_approval.

/**
 * Potřebuje verze před odesláním schválení? Hodnota = jednorázově + 12 ×
 * měsíčně; hranice null = nikdy, 0 = vždy; jiná měna než Kč vždy (bez kurzu).
 */
export function offerNeedsSendApproval(
  v: Pick<ScopeVersionRow, 'amount_one_time' | 'expected_mrr' | 'currency'>,
  threshold: number | null | undefined = approvalActionsConfig()?.sendOffer.requireApprovalFromCzk,
): boolean {
  if (threshold === null || threshold === undefined) return false
  if (v.currency !== 'CZK') return true
  return (Number(v.amount_one_time) || 0) + 12 * (Number(v.expected_mrr) || 0) >= threshold
}

/**
 *   free            odeslat jde hned (schválení se nevyžaduje, nebo migrace 0084 ještě neběží)
 *   needs_approval  nejdřív požádat o schválení odeslání
 *   pending         žádost čeká na rozhodnutí
 *   approved        schváleno k odeslání — pošle člověk a verzi označí jako odeslanou
 */
export type ScopeSendState = 'free' | 'needs_approval' | 'pending' | 'approved'

export function scopeSendState(
  v: Pick<ScopeVersionRow, 'id' | 'status' | 'amount_one_time' | 'expected_mrr' | 'currency' | 'send_approved_at'>,
  pendingSendVersionIds: readonly number[],
): ScopeSendState {
  if (v.status !== 'draft') return 'free'
  // Bez migrace 0084 sloupec chybí (undefined) a DB odeslání nehlídá.
  if (v.send_approved_at === undefined) return 'free'
  if (v.send_approved_at) return 'approved'
  if (pendingSendVersionIds.includes(v.id)) return 'pending'
  return offerNeedsSendApproval(v) ? 'needs_approval' : 'free'
}

export type ScopeVersionRow = {
  id: number
  deal_id: number
  version: number
  scope: string | null
  amount_one_time: number | string
  expected_mrr: number | string
  currency: ScopeCurrency
  status: ScopeVersionStatus
  sent_at: string | null
  decided_at: string | null
  evidence_id: number | null
  created_by: string | null
  created_at: string
  // 0084: schváleno k odeslání; undefined = migrace ještě neběžela.
  send_approved_at?: string | null
  send_approval_request_id?: number | null
}

export const SCOPE_VERSION_COLUMNS =
  'id, deal_id, version, scope, amount_one_time, expected_mrr, currency, status, sent_at, decided_at, evidence_id, created_by, created_at'

/** Sloupce schválení k odeslání (0084); dotaz je před migrací vynechá. */
export const SCOPE_VERSION_SEND_COLUMNS = ', send_approved_at, send_approval_request_id'

export function nextVersionNumber(versions: readonly Pick<ScopeVersionRow, 'version'>[]): number {
  return versions.reduce((max, v) => Math.max(max, v.version), 0) + 1
}

export function latestVersion<T extends Pick<ScopeVersionRow, 'version'>>(versions: readonly T[]): T | null {
  return versions.reduce<T | null>((best, v) => (best === null || v.version > best.version ? v : best), null)
}

export type ScopeDraftDefaults = {
  scope: string
  amount_one_time: number
  expected_mrr: number
  currency: ScopeCurrency
}

// Nová verze = kopie poslední (rozsah + ceny), jinak částky obchodu.
// U obchodu v EUR bereme původní EUR částku, ne přepočet v Kč.
export function draftDefaults(
  latest: Pick<ScopeVersionRow, 'scope' | 'amount_one_time' | 'expected_mrr' | 'currency'> | null,
  deal: {
    currency: string | null
    amount_one_time: number | string | null
    amount_one_time_original: number | string | null
    expected_mrr: number | string | null
    fx_rate: number | string | null
  },
): ScopeDraftDefaults {
  if (latest) {
    return {
      scope: latest.scope ?? '',
      amount_one_time: Number(latest.amount_one_time) || 0,
      expected_mrr: Number(latest.expected_mrr) || 0,
      currency: latest.currency,
    }
  }
  if (deal.currency === 'EUR') {
    const rate = Number(deal.fx_rate)
    return {
      scope: '',
      amount_one_time: Number(deal.amount_one_time_original) || 0,
      expected_mrr: rate > 0 ? Math.round((Number(deal.expected_mrr) || 0) / rate) : 0,
      currency: 'EUR',
    }
  }
  return {
    scope: '',
    amount_one_time: Number(deal.amount_one_time) || 0,
    expected_mrr: Number(deal.expected_mrr) || 0,
    currency: 'CZK',
  }
}

const money = (label: string) => z.preprocess(
  (v) => {
    if (v === '' || v === undefined || v === null) return 0
    if (typeof v === 'string') return Number(v.replace(/\s/g, '').replace(',', '.'))
    return v
  },
  z.number({ error: `${label} musí být číslo.` })
    .refine(Number.isFinite, `${label} musí být číslo.`)
    .min(0, `${label} nesmí být záporná.`)
    .max(999_999_999, `${label} je příliš vysoká.`),
)

export const scopeVersionSchema = z.object({
  scope: z.preprocess(
    (v) => (typeof v === 'string' ? v.trim() : v),
    z.string().min(1, 'Popiš rozsah nabídky.').max(4000, 'Rozsah může mít nejvýš 4000 znaků.'),
  ),
  amount_one_time: money('Jednorázová částka'),
  expected_mrr: money('Měsíční částka'),
  currency: z.enum(['CZK', 'EUR'], { error: 'Neplatná měna.' }),
})
export type ScopeVersionInput = z.infer<typeof scopeVersionSchema>

// Stabilní SQLSTATE strážce z 0072 → česká věta.
export const SCOPE_VERSION_DB_CODES: Record<string, string> = {
  SV001: 'Verzi nabídky nejde do tohoto stavu převést. Načti prosím stránku znovu.',
  SV002: 'Odeslanou verzi nabídky nejde měnit — založ novou verzi.',
  SV003: 'Obchod, číslo ani autora verze nabídky nejde změnit.',
  SV004: 'U verze v EUR chybí kurz pro přepočet na Kč.',
  SV005: 'Verze nabídky nepatří k tomuto obchodu.',
  // 0084 — schválení odeslání.
  SV006: 'Tuhle verzi je potřeba před odesláním schválit (čtyři oči). Požádej o schválení odeslání.',
  SV007: 'Schválení k odeslání nastavuje jen schválená žádost.',
  SV008: 'Schválenou verzi nabídky nejde měnit — založ novou verzi.',
}

export function scopeVersionDbMessage(error: { code?: string | null } | null | undefined): string | null {
  if (!error?.code) return null
  return SCOPE_VERSION_DB_CODES[error.code] ?? null
}

// Tabulka nebo RPC z 0072 ještě není nasazená.
export function isScopeVersionMissing(error: { code?: string | null; message?: string | null } | null | undefined): boolean {
  if (!error) return false
  if (['42P01', 'PGRST205', '42883', 'PGRST202'].includes(error.code ?? '')) return true
  return /relation .*deal_scope_version.* does not exist|could not find the (table|function)/i.test(error.message ?? '')
}

export const SCOPE_VERSION_MISSING_MESSAGE = 'Verze nabídky ještě nejsou dostupné — čekají na migraci 0072.'

// Verze 1 z importovaného PDF nabídky (status sent). Částky tak, jak byly
// v nabídce (v její měně); MRR z PDF nečteme.
export function versionFromOffer(fields: {
  title: string
  amount_one_time: number | null
  currency: ScopeCurrency
}): { version: 1; status: 'sent'; scope: string; amount_one_time: number; expected_mrr: 0; currency: ScopeCurrency } {
  return {
    version: 1,
    status: 'sent',
    scope: fields.title.slice(0, 4000),
    amount_one_time: Math.max(0, fields.amount_one_time ?? 0),
    expected_mrr: 0,
    currency: fields.currency,
  }
}
