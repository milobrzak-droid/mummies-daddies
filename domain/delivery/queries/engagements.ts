import { createClient } from '@/lib/supabase/server'
import type { Engagement, ReferenceCard } from '@/lib/types'

export async function getEngagementsForAccount(accountId: number): Promise<Engagement[]> {
  const s = await createClient()
  const { data, error } = await s.from('engagement').select('*')
    .eq('account_id', accountId).order('started_on', { ascending: false })
  if (error) throw error
  return data ?? []
}
export async function getEngagement(id: number): Promise<Engagement | null> {
  const s = await createClient()
  const { data, error } = await s.from('engagement').select('*').eq('id', id).maybeSingle()
  if (error) throw error
  return data
}
export async function getReferenceCards(engagementId: number): Promise<ReferenceCard[]> {
  const s = await createClient()
  const { data, error } = await s.from('reference_card').select('*')
    .eq('engagement_id', engagementId)
  if (error) throw error
  return data ?? []
}
