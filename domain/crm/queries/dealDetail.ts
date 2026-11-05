import { createClient } from '@/lib/supabase/server'
import { normalizeDealRow } from '@/lib/dealStageLegacy'
import type { Deal, DealPartner, Engagement } from '@/lib/types'
import type { SalesActivityLike } from '@/domain/crm/sales'

// Data pro read-only detail obchodu (/clients/[id]/deals/[dealId]).
// Deal se hledá VČETNĚ account_id — deal z jiného klienta se tváří jako
// neexistující (stránka pak volá notFound()).

export type DealDetail = Deal & {
  follow_up_nudged_on: string | null
  follow_up_escalated_on: string | null
  owner: { id: string; full_name: string } | null
  account: { id: number; name: string } | null
}

export async function getDealForAccount(accountId: number, dealId: number): Promise<DealDetail | null> {
  if (!Number.isInteger(accountId) || !Number.isInteger(dealId) || accountId <= 0 || dealId <= 0) return null
  const s = await createClient()
  const { data, error } = await s.from('deal')
    .select('*, owner:team_member!deal_owner_id_fkey(id, full_name), account:account!deal_account_id_fkey(id, name)')
    .eq('id', dealId).eq('account_id', accountId).maybeSingle()
  if (error) throw error
  return normalizeDealRow((data ?? null) as unknown as DealDetail | null)
}

export type DealPartnerWithName = DealPartner & { partner: { id: number; name: string } | null }

export async function getDealPartnersWithNames(dealId: number): Promise<DealPartnerWithName[]> {
  const s = await createClient()
  const { data, error } = await s.from('deal_partner')
    .select('*, partner:partner(id, name)').eq('deal_id', dealId)
  if (error) throw error
  return (data ?? []) as unknown as DealPartnerWithName[]
}

export async function getEngagementsForDeal(dealId: number): Promise<Engagement[]> {
  const s = await createClient()
  const { data, error } = await s.from('engagement').select('*').eq('deal_id', dealId)
    .order('id', { ascending: false })
  if (error) throw error
  return (data ?? []) as unknown as Engagement[]
}

const ACTIVITY_SELECT = [
  '*',
  'account:account!sales_activity_account_id_fkey(id, name)',
  'deal:deal!sales_activity_deal_id_fkey(id, title)',
  'contact:contact!sales_activity_contact_id_fkey(id, full_name)',
  'author:team_member!sales_activity_created_by_fkey(id, full_name)',
].join(', ')

export async function getSalesActivitiesForDeal(dealId: number, limit = 20): Promise<SalesActivityLike[]> {
  const s = await createClient()
  const { data, error } = await s.from('sales_activity').select(ACTIVITY_SELECT)
    .eq('deal_id', dealId).order('occurred_at', { ascending: false }).limit(limit)
  if (error) throw error
  return (data ?? []) as unknown as SalesActivityLike[]
}

export type AuditRow = {
  id: number
  action: string
  actor_type: string
  actor_id: string | null
  before: Record<string, unknown> | null
  after: Record<string, unknown> | null
  occurred_at: string
}

// audit_event je čitelný jen pro tým s AAL2 (0028). Když čtení selže (RLS,
// chybějící tabulka), stránka nemá spadnout — vrací se `null` = "nedostupné",
// odlišitelné od prázdné historie `[]`.
export async function getDealAuditHistory(dealId: number, limit = 20): Promise<AuditRow[] | null> {
  try {
    const s = await createClient()
    const { data, error } = await s.from('audit_event')
      .select('id, action, actor_type, actor_id, before, after, occurred_at')
      .eq('entity_table', 'deal').eq('entity_id', dealId)
      .order('occurred_at', { ascending: false }).limit(limit)
    if (error) return null
    return (data ?? []) as unknown as AuditRow[]
  } catch {
    return null
  }
}

function fmtValue(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—'
  if (typeof v === 'string') return v.length > 60 ? `${v.slice(0, 57)}…` : v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  const json = JSON.stringify(v)
  return json.length > 60 ? `${json.slice(0, 57)}…` : json
}

const IGNORED_KEYS = new Set(['updated_at'])
// `_columns` (DB audit trigger 0064) = názvy změněných sloupců. Sloupce bez
// uložené hodnoty (volný text, jména) se ukážou jen jako „změněno".
const COLUMNS_KEY = '_columns'

function listedColumns(row: Record<string, unknown> | null): string[] {
  const v = row?.[COLUMNS_KEY]
  return Array.isArray(v) ? v.filter((c): c is string => typeof c === 'string') : []
}

/** Čistá funkce: shrne before/after do řádků "pole: stará → nová" (jen změněná pole). */
export function summarizeAuditChange(
  before: Record<string, unknown> | null,
  after: Record<string, unknown> | null,
  maxItems = 6,
): string[] {
  const keys = Array.from(new Set([...Object.keys(before ?? {}), ...Object.keys(after ?? {})]))
    .filter((k) => !IGNORED_KEYS.has(k) && k !== COLUMNS_KEY).sort()
  const lines: string[] = []
  for (const k of keys) {
    const b = before?.[k]
    const a = after?.[k]
    if (JSON.stringify(b) === JSON.stringify(a)) continue
    if (!before) lines.push(`${k}: ${fmtValue(a)}`)
    else if (!after) lines.push(`${k}: ${fmtValue(b)} → —`)
    else lines.push(`${k}: ${fmtValue(b)} → ${fmtValue(a)}`)
  }
  const withValue = new Set(keys)
  const valueless = Array.from(new Set([...listedColumns(before), ...listedColumns(after)]))
    .filter((c) => !withValue.has(c) && !IGNORED_KEYS.has(c)).sort()
  for (const c of valueless) lines.push(`${c}: změněno (hodnota se neukládá)`)
  if (lines.length > maxItems) return [...lines.slice(0, maxItems), `+ ${lines.length - maxItems} dalších`]
  return lines
}
