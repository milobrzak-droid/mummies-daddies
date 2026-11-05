import { createClient } from '@/lib/supabase/server'
import type { Subscription } from '@/lib/types'

// Předplatná klienta, nejbližší obnova první — u recurring revenue je to,
// co se blíží k rozhodnutí o obnově, přesně to, na co se má customer
// success podívat jako na první (stejná logika jako getOpenTasksForAccount).
export async function getSubscriptionsForAccount(accountId: number): Promise<Subscription[]> {
  const s = await createClient()
  const { data, error } = await s.from('subscription')
    .select('*')
    .eq('account_id', accountId)
    .order('renewal_date', { ascending: true, nullsFirst: false })
  if (error) throw error
  return data ?? []
}
