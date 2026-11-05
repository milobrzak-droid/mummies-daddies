import { createClient } from '@/lib/supabase/server'
import { normalizeDealRows } from '@/lib/dealStageLegacy'
import type { Contact } from '@/lib/types'
import type { SalesActivityLike, SalesDealLike } from '@/domain/crm/sales'

const SALES_DEAL_SELECT = [
  '*',
  'account:account!deal_account_id_fkey(id, name)',
  'owner:team_member!deal_owner_id_fkey(id, full_name, email)',
  'primary_contact:contact!deal_primary_contact_id_fkey(id, full_name)',
].join(', ')

const ACTIVITY_SELECT = [
  '*',
  'account:account!sales_activity_account_id_fkey(id, name)',
  'deal:deal!sales_activity_deal_id_fkey(id, title)',
  'contact:contact!sales_activity_contact_id_fkey(id, full_name)',
  'author:team_member!sales_activity_created_by_fkey(id, full_name)',
].join(', ')

export async function getSalesDeals(): Promise<SalesDealLike[]> {
  const s = await createClient()
  const { data, error } = await s.from('deal')
    .select(SALES_DEAL_SELECT)
    .order('expected_close', { ascending: true, nullsFirst: false })
  if (error) throw error
  return normalizeDealRows((data ?? []) as unknown as SalesDealLike[])
}

export async function getSalesActivities(limit = 100): Promise<SalesActivityLike[]> {
  const s = await createClient()
  const { data, error } = await s.from('sales_activity')
    .select(ACTIVITY_SELECT)
    .order('occurred_at', { ascending: false })
    .limit(limit)
  if (error) throw error
  return (data ?? []) as unknown as SalesActivityLike[]
}

export async function getSalesActivitiesForAccount(accountId: number, limit = 50): Promise<SalesActivityLike[]> {
  const s = await createClient()
  const { data, error } = await s.from('sales_activity')
    .select(ACTIVITY_SELECT)
    .eq('account_id', accountId)
    .order('occurred_at', { ascending: false })
    .limit(limit)
  if (error) throw error
  return (data ?? []) as unknown as SalesActivityLike[]
}

export async function listContacts(): Promise<Contact[]> {
  const s = await createClient()
  const { data, error } = await s.from('contact').select('*').order('full_name')
  if (error) throw error
  return (data ?? []) as Contact[]
}
