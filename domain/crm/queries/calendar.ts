import { createClient } from '@/lib/supabase/server'

// PostgREST / Postgres: sloupec neexistuje (migrace 0060 ještě neaplikovaná).
const MISSING_COLUMN_CODES = new Set(['42703', 'PGRST204'])

export type MyCalendarConnection = {
  connected: boolean
  email: string | null
  /**
   * Udělená oprávnění z posledního připojení (calendar_token.granted_scopes,
   * 0060), mezerami oddělená. null = neznámé (připojeno dřív / sloupec chybí).
   */
  grantedScopes: string | null
}

export async function getMyCalendarConnection(): Promise<MyCalendarConnection> {
  const s = await createClient()
  const { data: { user } } = await s.auth.getUser()
  if (!user) return { connected: false, email: null, grantedScopes: null }

  const full = await s.from('calendar_token').select('account_email, granted_scopes').eq('member_id', user.id).maybeSingle()
  if (!full.error) {
    const row = full.data as { account_email: string | null; granted_scopes: string | null } | null
    return { connected: !!row, email: row?.account_email ?? null, grantedScopes: row?.granted_scopes ?? null }
  }
  // Bez 0060 by chybějící sloupec shodil celý dotaz a Outlook by vypadal
  // odpojený — radši se zeptat bez něj a udělená práva hlásit jako neznámá.
  if (!MISSING_COLUMN_CODES.has(String((full.error as { code?: unknown }).code))) {
    return { connected: false, email: null, grantedScopes: null }
  }
  const { data } = await s.from('calendar_token').select('account_email').eq('member_id', user.id).maybeSingle()
  return { connected: !!data, email: data?.account_email ?? null, grantedScopes: null }
}
