// Čtení verzí nabídky obchodu (0072). Před nasazením migrace chybí tabulka
// (42P01 / PGRST205) — to je stav „čeká na migraci", ne chyba. Tabulku
// hlídá RESTRICTIVE sales_only; ne-obchodní role dostane prázdný seznam,
// UI sekci stejně nevykreslí.
//
// Od 0084 se čte i schválení k odeslání (send_approved_at) a čekající žádosti
// o schválení odeslání. Před 0084 sloupce chybí (42703) — dotaz je vynechá
// a verze se chovají jako dřív (odeslat jde hned).
import { createClient } from '@/lib/supabase/server'
import type { Loaded } from '@/domain/delivery/queries/documents'
import { isMissingColumn } from '@/core/loopQueries'
import {
  SCOPE_VERSION_COLUMNS,
  SCOPE_VERSION_SEND_COLUMNS,
  isScopeVersionMissing,
  type ScopeCurrency,
  type ScopeVersionRow,
  type ScopeVersionStatus,
} from '@/domain/crm/scopeVersion'
import type { OfferExportRow } from '@/domain/crm/exports'
import type { ScopeVersionForPdf } from '@/domain/crm/offerPdfSource'

export async function getDealScopeVersions(
  dealId: number,
): Promise<Loaded<{ versions: ScopeVersionRow[]; pendingSendVersionIds: number[] }>> {
  const s = await createClient()
  const query = (cols: string) =>
    s.from('deal_scope_version').select(cols).eq('deal_id', dealId).order('version', { ascending: false })
  let res = await query(SCOPE_VERSION_COLUMNS + SCOPE_VERSION_SEND_COLUMNS)
  if (isMissingColumn(res.error)) res = await query(SCOPE_VERSION_COLUMNS)
  const { data, error } = res
  if (isScopeVersionMissing(error)) return { state: 'missing_migration' }
  if (error) return { state: 'error', message: error.message }
  const versions = (data ?? []) as unknown as ScopeVersionRow[]
  return { state: 'ok', versions, pendingSendVersionIds: await pendingSendRequests(versions.map((v) => v.id)) }
}

/** Verze, na jejichž odeslání čeká žádost o schválení (0084); bez migrace nic. */
async function pendingSendRequests(versionIds: readonly number[]): Promise<number[]> {
  if (versionIds.length === 0) return []
  const s = await createClient()
  const { data, error } = await s
    .from('approval_request')
    .select('target_id')
    .eq('action_type', 'send_offer')
    .eq('target_table', 'deal_scope_version')
    .eq('status', 'pending')
    .in('target_id', [...versionIds])
  if (error) return []
  return ((data ?? []) as { target_id: number }[]).map((r) => Number(r.target_id))
}

export type OfferApprovalTarget = {
  version_id: number
  version: number
  amount_one_time: number | string
  expected_mrr: number | string
  currency: ScopeCurrency
  deal_id: number
  deal_title: string | null
  account_id: number | null
}

/**
 * Verze nabídek, o jejichž odeslání se žádá (karta Ke schválení). Verze
 * a obchody jsou obchodní údaj: RLS sales_only ostatním rolím nevrátí nic
 * a karta pak ukáže jen číslo verze bez částky.
 */
export async function getOfferApprovalTargets(versionIds: readonly number[]): Promise<Map<number, OfferApprovalTarget>> {
  if (versionIds.length === 0) return new Map()
  const s = await createClient()
  const { data, error } = await s
    .from('deal_scope_version')
    .select('id, version, amount_one_time, expected_mrr, currency, deal_id, deal(title, account_id)')
    .in('id', [...versionIds])
  if (error) return new Map()
  type Row = {
    id: number
    version: number
    amount_one_time: number | string
    expected_mrr: number | string
    currency: ScopeCurrency
    deal_id: number
    deal: { title: string; account_id: number } | { title: string; account_id: number }[] | null
  }
  return new Map(((data ?? []) as unknown as Row[]).map((r) => {
    const deal = Array.isArray(r.deal) ? (r.deal[0] ?? null) : r.deal
    return [r.id, {
      version_id: r.id,
      version: r.version,
      amount_one_time: r.amount_one_time,
      expected_mrr: r.expected_mrr,
      currency: r.currency,
      deal_id: r.deal_id,
      deal_title: deal?.title ?? null,
      account_id: deal?.account_id ?? null,
    }]
  }))
}

// --- Exporty (P9) -------------------------------------------------------------

const OFFER_EXPORT_SELECT = `${SCOPE_VERSION_COLUMNS}, deal:deal!deal_scope_version_deal_id_fkey(id, title, account:account!deal_account_id_fkey(id, name))`
const OFFER_PDF_SELECT = `${SCOPE_VERSION_COLUMNS}, deal:deal!deal_scope_version_deal_id_fkey(id, title, account:account!deal_account_id_fkey(id, name), primary_contact:contact!deal_primary_contact_id_fkey(id, full_name))`

/** PostgREST vrací vnořený to-one embed jako objekt, výjimečně jako pole. */
type Embed<T> = T | T[] | null | undefined
function one<T>(v: Embed<T>): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null)
}

type Named = { id: number; name: string }
type RawDeal = { id: number; title: string; account?: Embed<Named>; primary_contact?: Embed<{ id: number; full_name: string }> }
type RawVersion = ScopeVersionRow & { deal: Embed<RawDeal> }

/**
 * Všechny verze nabídek s obchodem a klientem pro export „Nabídky"
 * (nejnovější první). RLS sales_only: ne-obchodní role dostane prázdný
 * seznam. Bez migrace 0072 také prázdný seznam.
 */
export async function listScopeVersionsForExport(status: ScopeVersionStatus | null = null): Promise<OfferExportRow[]> {
  const s = await createClient()
  let query = s.from('deal_scope_version').select(OFFER_EXPORT_SELECT)
  if (status) query = query.eq('status', status)
  const { data, error } = await query.order('created_at', { ascending: false }).order('id', { ascending: false }).limit(5000)
  if (isScopeVersionMissing(error)) return []
  if (error) throw error
  return ((data ?? []) as unknown as RawVersion[]).map((r) => {
    const deal = one(r.deal)
    return { ...r, deal: deal ? { id: deal.id, title: deal.title, account: one(deal.account) } : null }
  })
}

/** Jedna verze nabídky pro PDF zákazníkovi; null = neexistuje nebo ji RLS nevrátí. */
export async function getScopeVersionForPdf(versionId: number): Promise<ScopeVersionForPdf | null> {
  const s = await createClient()
  const { data, error } = await s.from('deal_scope_version').select(OFFER_PDF_SELECT).eq('id', versionId).maybeSingle()
  if (isScopeVersionMissing(error)) return null
  if (error) throw error
  if (!data) return null
  const row = data as unknown as RawVersion
  const deal = one(row.deal)
  return {
    ...row,
    deal: deal
      ? { id: deal.id, title: deal.title, account: one(deal.account), primary_contact: one(deal.primary_contact) }
      : null,
  }
}
