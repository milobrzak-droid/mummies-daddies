import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { isProposalsMigrationMissing } from '@/core/agents/caseProposal'

// Příjem zápisů schůzek z diktátu (migrace 0078). Čtení jde přes session
// klienta — RLS pustí jen obchodní role (can_see_sales) s AAL2. Cron
// (domain/crm/digestDelivery.ts) předává servisního klienta.
//
// Bez migrace 0078 (tabulka neexistuje) vrací stats null a fronta prázdné
// pole — stránky a přehled se nerozbijí.

type Db = Pick<SupabaseClient, 'from'>

export type MeetingIntakeStats = {
  /** Zápisů přijatých za posledních 30 dní (všechny stavy). */
  received30d: number
  /** Zápisů čekajících na ruční přiřazení. */
  unmatched: number
  /** Kdy přišel poslední zápis (received_at), nebo null. */
  lastReceivedAt: string | null
}

export const MEETING_INTAKE_WINDOW_DAYS = 30

export async function getMeetingIntakeStats(
  db?: Db,
  now: Date = new Date(),
): Promise<MeetingIntakeStats | null> {
  const s = db ?? (await createClient())
  const since = new Date(now.getTime() - MEETING_INTAKE_WINDOW_DAYS * 86_400_000).toISOString()
  const [recent, waiting, last] = await Promise.all([
    s.from('meeting_note_intake').select('id', { count: 'exact', head: true }).gte('received_at', since),
    s.from('meeting_note_intake').select('id', { count: 'exact', head: true }).eq('status', 'unmatched'),
    s.from('meeting_note_intake').select('received_at').order('received_at', { ascending: false }).limit(1),
  ])
  for (const r of [recent, waiting, last]) {
    if (r.error) {
      if (isProposalsMigrationMissing(r.error)) return null
      throw new Error(`Načtení zápisů schůzek z diktátu selhalo: ${r.error.code ?? 'chyba'}`)
    }
  }
  return {
    received30d: recent.count ?? 0,
    unmatched: waiting.count ?? 0,
    lastReceivedAt: (last.data?.[0] as { received_at: string } | undefined)?.received_at ?? null,
  }
}

export type QueuedNote = {
  id: number
  title: string | null
  body: string
  client_hint: string | null
  occurred_at: string
  received_at: string
}

/** Zápisy čekající na ruční přiřazení, nejstarší první. */
export async function listQueuedNotes(limit = 50, db?: Db): Promise<QueuedNote[]> {
  const s = db ?? (await createClient())
  const { data, error } = await s
    .from('meeting_note_intake')
    .select('id, title, body, client_hint, occurred_at, received_at')
    .eq('status', 'unmatched')
    .order('received_at', { ascending: true })
    .limit(limit)
  if (error) {
    if (isProposalsMigrationMissing(error)) return []
    throw new Error(`Načtení nespárovaných zápisů selhalo: ${error.code ?? 'chyba'}`)
  }
  return ((data ?? []) as QueuedNote[]).filter((n) => typeof n.body === 'string')
}
