import type { SupabaseClient } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'

// Zápisy schůzek. Od 2026-09-28 je jediným zdrojem Wispr Flow: nemá veřejné
// API, takže zápis do Cockpitu přenáší člověk přes Cowork skill
// (cowork-skill/enter-meeting-notes/SKILL.md, sekce „Zdroj: Wispr Flow"),
// který volá MCP nástroj create_activity (lib/mcpServer.ts →
// domain/crm/apiWrite.ts). Ten ukládá `source: 'api'` — stejně jako REST
// /api/v1/activities, oba jsou ale strojový zápis zvenku, ne ruční formulář.
// „Zápis přes skill" proto definujeme konkrétně jako
// sales_activity s kind = 'meeting' a source = 'api'.
//
// Zápis, který doplnil schůzku naplánovanou z Cockpitu (domain/crm/
// plannedMeetingPairing.ts), nový řádek nezaloží — jeho created_at je čas
// plánování. Kdy zápis přišel, nese note_received_at (0085).

type Db = Pick<SupabaseClient, 'from'>

const MISSING_COLUMN = new Set(['42703', 'PGRST204'])

/**
 * Kdy naposledy přišel zápis schůzky přes skill/MCP: později z nového řádku
 * (created_at) a z doplněné naplánované schůzky (note_received_at). Bez
 * migrace 0085 jen created_at. Sdílí stránka (session) i cron přehledu
 * (servisní klient).
 */
export async function lastApiMeetingNoteAt(db: Db): Promise<string | null> {
  const { data, error } = await db.from('sales_activity')
    .select('created_at')
    .eq('kind', 'meeting')
    .eq('source', 'api')
    .order('created_at', { ascending: false })
    .limit(1)
  if (error) throw new Error(`Načtení posledního zápisu schůzky selhalo: ${error.message}`)
  const created = (data?.[0] as { created_at: string } | undefined)?.created_at ?? null

  const paired = await db.from('sales_activity')
    .select('note_received_at')
    .eq('kind', 'meeting')
    .eq('source', 'api')
    .not('note_received_at', 'is', null)
    .order('note_received_at', { ascending: false })
    .limit(1)
  if (paired.error) {
    if (MISSING_COLUMN.has(String((paired.error as { code?: unknown }).code ?? ''))) return created
    throw new Error(`Načtení posledního zápisu schůzky selhalo: ${paired.error.message}`)
  }
  const received = (paired.data?.[0] as { note_received_at: string | null } | undefined)?.note_received_at ?? null
  if (!created) return received
  if (!received) return created
  return Date.parse(received) > Date.parse(created) ? received : created
}

export type MeetingNote = {
  id: number
  subject: string | null
  occurred_at: string
  created_at: string
  source: string | null
  outcome: string | null
  account: { id: number; name: string } | null
}

/** Kdy naposledy přišel zápis schůzky přes skill/MCP, nebo null (viz lastApiMeetingNoteAt). */
export async function getLastSkillMeetingNoteAt(): Promise<string | null> {
  return lastApiMeetingNoteAt(await createClient())
}

/** Poslední schůzky (libovolný zdroj) pro stránku /schuzky. */
export async function getRecentMeetings(limit = 20): Promise<MeetingNote[]> {
  const s = await createClient()
  const { data, error } = await s.from('sales_activity')
    .select('id, subject, occurred_at, created_at, source, outcome, account:account!sales_activity_account_id_fkey(id, name)')
    .eq('kind', 'meeting')
    .order('occurred_at', { ascending: false })
    .limit(limit)
  if (error) throw new Error(`Načtení schůzek selhalo: ${error.message}`)
  return (data ?? []) as unknown as MeetingNote[]
}
