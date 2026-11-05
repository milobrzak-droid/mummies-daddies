import { createClient } from '@/lib/supabase/server'
import { addDaysToPragueDay, pragueLocalToUtc } from '@/lib/pragueDate'

// Schůzky jednoho pražského dne pro obrazovku „Dnes“ (sales_activity, druh
// „meeting“: naplánované z Cockpitu i zapsané přes skill). Jen čtení, RLS
// stejná jako u /schuzky; volá se jen pro obchodní role.

export type TodayMeeting = {
  id: number
  subject: string | null
  occurred_at: string
  source: string | null
  outcome: string | null
  account: { id: number; name: string } | null
}

export async function getMeetingsOnDay(day: string): Promise<TodayMeeting[]> {
  const s = await createClient()
  // Hranice dne v pražském čase → okamžiky UTC (ne `${day}T00:00Z`: mezi půlnocí
  // a 1–2 h ráno by to chytalo špatný den).
  const from = pragueLocalToUtc(`${day}T00:00`).toISOString()
  const to = pragueLocalToUtc(`${addDaysToPragueDay(day, 1)}T00:00`).toISOString()
  const { data, error } = await s.from('sales_activity')
    .select('id, subject, occurred_at, source, outcome, account:account!sales_activity_account_id_fkey(id, name)')
    .eq('kind', 'meeting')
    .gte('occurred_at', from)
    .lt('occurred_at', to)
    .order('occurred_at', { ascending: true })
  if (error) throw new Error(`Načtení dnešních schůzek selhalo: ${error.message}`)
  return (data ?? []) as unknown as TodayMeeting[]
}
