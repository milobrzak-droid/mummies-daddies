import { createClient } from '@/lib/supabase/server'
import type { AccountWithReferrer, Contact } from '@/lib/types'
import {
  BLANK_ICO_FILTER, accountSearchOrFilter, clampPage, pageCount, pageRange,
} from '@/domain/crm/accountList'

// Explicit FK-constraint hints keep the to-one embeds unambiguous.
const WITH_REFERRER =
  '*, referred_by:partner!account_referred_by_partner_id_fkey(id, name), owner:team_member!account_owner_id_fkey(id, full_name)'

/**
 * VŠECHNY firmy i s embedy. Po importu radaru ~663 řádků — pro stránky
 * používej listAccountsPage (domain/crm/queries/accountList.ts), pro
 * formuláře components/AccountPicker. Ponecháno pro kompatibilitu.
 */
export async function listAccounts(): Promise<AccountWithReferrer[]> {
  const s = await createClient()
  const { data, error } = await s.from('account').select(WITH_REFERRER).order('name')
  if (error) throw error
  return (data ?? []) as unknown as AccountWithReferrer[]
}
/**
 * id+name VŠECH firem. Do formulářů patří components/AccountPicker (hledá
 * na serveru po 20) — tahle funkce už nemá volajícího a zůstává jen kvůli
 * kompatibilitě s paralelními větvemi.
 */
export async function listAccountOptions(): Promise<{ id: number; name: string }[]> {
  const s = await createClient()
  const { data, error } = await s.from('account').select('id, name').order('name')
  if (error) throw error
  return data ?? []
}

export type AccountOption = { id: number; name: string }

/** Kolik firem vrátí hledání ve výběru firmy (components/AccountPicker). */
export const ACCOUNT_OPTION_LIMIT = 20

/**
 * Hledání firmy pro výběr ve formulářích: název nebo IČO obsahuje dotaz
 * (ILIKE s escapovanými zástupnými znaky), max ACCOUNT_OPTION_LIMIT podle
 * názvu. Náhrada listAccountOptions() tam, kde se dřív posílal do
 * prohlížeče celý seznam (~663 firem po importu radaru).
 */
export async function searchAccountOptions(
  query: string,
  { excludeId = null, limit = ACCOUNT_OPTION_LIMIT }: { excludeId?: number | null; limit?: number } = {},
): Promise<AccountOption[]> {
  const q = query.trim()
  if (!q) return []
  const s = await createClient()
  let builder = s.from('account').select('id, name').or(accountSearchOrFilter(q))
  if (excludeId != null) builder = builder.neq('id', excludeId)
  const { data, error } = await builder.order('name').order('id').limit(limit)
  if (error) throw error
  return (data ?? []) as AccountOption[]
}

/** Jedna firma jako volba (předvyplnění výběru z URL). Neexistující → null. */
export async function getAccountOption(id: number | null | undefined): Promise<AccountOption | null> {
  if (!Number.isSafeInteger(id) || (id as number) <= 0) return null
  const s = await createClient()
  const { data, error } = await s.from('account').select('id, name').eq('id', id as number).maybeSingle()
  if (error) throw error
  return (data as AccountOption | null) ?? null
}

export const MISSING_ICO_PAGE_SIZE = 20

/**
 * Firmy bez IČO (NULL nebo '') po stránkách — pro /clients/doplnit-ico.
 * Po importu radaru jich jsou stovky a stránka pro každou dělá dotaz do
 * ARESu, takže se vždy bere jen jedna stránka.
 */
export async function listAccountsMissingIco(page = 1, pageSize = MISSING_ICO_PAGE_SIZE): Promise<{
  rows: AccountOption[]; total: number; page: number; pageCount: number
}> {
  const s = await createClient()
  const fetchPage = (p: number) => {
    const { from, to } = pageRange(p, pageSize)
    return s.from('account').select('id, name', { count: 'exact' })
      .or(BLANK_ICO_FILTER).order('name').order('id').range(from, to)
  }
  let current = Math.max(1, page)
  let res = await fetchPage(current)
  const outOfRange = res.error?.code === 'PGRST103' || (!res.error && current > 1 && (res.data ?? []).length === 0)
  if (outOfRange) {
    // Starý odkaz na stránku, která mezitím zmizela (IČO se doplňují).
    const head = await s.from('account').select('id', { count: 'exact', head: true }).or(BLANK_ICO_FILTER)
    if (head.error) throw head.error
    const clamped = clampPage(current, head.count ?? 0, pageSize)
    if (clamped !== current) {
      current = clamped
      res = await fetchPage(current)
    }
  }
  if (res.error) throw res.error
  const rows = (res.data ?? []) as AccountOption[]
  const total = res.count ?? rows.length
  return { rows, total, page: current, pageCount: pageCount(total, pageSize) }
}

export async function getAccount(id: number): Promise<AccountWithReferrer | null> {
  const s = await createClient()
  const { data, error } = await s.from('account').select(WITH_REFERRER).eq('id', id).maybeSingle()
  if (error) throw error
  return (data as unknown as AccountWithReferrer) ?? null
}
export async function getContacts(accountId: number): Promise<Contact[]> {
  const s = await createClient()
  const { data, error } = await s.from('contact').select('*')
    .eq('account_id', accountId).order('full_name')
  if (error) throw error
  return data ?? []
}

/** Kontakty jedné firmy jako volby (výběr kontaktu po zvolení firmy). */
export async function listContactOptionsForAccount(accountId: number): Promise<{ id: number; full_name: string }[]> {
  const s = await createClient()
  const { data, error } = await s.from('contact').select('id, full_name')
    .eq('account_id', accountId).order('full_name').limit(200)
  if (error) throw error
  return (data ?? []) as { id: number; full_name: string }[]
}
