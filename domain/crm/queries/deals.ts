import { createClient } from '@/lib/supabase/server'
import { normalizeDealRows } from '@/lib/dealStageLegacy'
import type { DealWithChannel, DealPartner } from '@/lib/types'

export async function getDealsForAccount(accountId: number): Promise<DealWithChannel[]> {
  const s = await createClient()
  const { data, error } = await s.from('deal')
    .select('*, channel:partner!deal_sourced_by_partner_fkey(id, name)')
    .eq('account_id', accountId).order('created_at', { ascending: false })
  if (error) throw error
  return normalizeDealRows((data ?? []) as unknown as DealWithChannel[])
}
export async function getDealPartners(dealId: number): Promise<DealPartner[]> {
  const s = await createClient()
  const { data, error } = await s.from('deal_partner').select('*').eq('deal_id', dealId)
  if (error) throw error
  return data ?? []
}
