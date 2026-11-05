import { createClient } from '@/lib/supabase/server'
import { logError } from '@/lib/log'
import { refreshAccessToken, refreshAccessTokenForFiles } from './client'
import type { CalendarToken } from '@/lib/types'

// Platný přístupový token přihlášeného uživatele pro Microsoft Graph.
// Tokeny z Entry žijí ~1 hodinu, takže se obnovují skoro při každém použití —
// jedno místo, ať se ta logika nerozjede mezi voláními.
//
// Od 0031 access_token/refresh_token v DB nejsou čitelné přímo — tabulka
// drží jen šifrované bytea sloupce a appka k nim smí jedině přes tyhle dvě
// SECURITY DEFINER RPC (calendar_token_get_decrypted na čtení,
// calendar_token_update_tokens na zápis po obnově). Klíč z Vaultu se z nich
// nikdy nevrací — jen už dešifrovaný token, resp. nic (void).
export type TokenResult = { ok: true; accessToken: string } | { ok: false; error: string }

export async function graphTokenForCurrentUser(): Promise<TokenResult> {
  const s = await createClient()
  const { data: { user } } = await s.auth.getUser()
  if (!user) return { ok: false, error: 'Nejsi přihlášený.' }

  const { data } = await s.rpc('calendar_token_get_decrypted', { p_member_id: user.id })
  const token = (data?.[0] ?? null) as CalendarToken | null
  if (!token?.access_token || !token.refresh_token) {
    return { ok: false, error: 'Outlook není připojený. Připoj ho na dashboardu.' }
  }

  const valid = token.expires_at && new Date(token.expires_at).getTime() > Date.now()
  if (valid) return { ok: true, accessToken: token.access_token }

  const refreshed = await refreshAccessTokenForFiles(token.refresh_token, refreshAccessToken)
  if (!refreshed) {
    return { ok: false, error: 'Přihlášení k Outlooku vypršelo. Připoj účet znovu.' }
  }
  const { error: updateError } = await s.rpc('calendar_token_update_tokens', {
    p_member_id: user.id,
    p_access_token: refreshed.access_token,
    p_refresh_token: refreshed.refresh_token,
    p_expires_at: new Date(Date.now() + refreshed.expires_in * 1000).toISOString(),
  })
  // Microsoft mohl refresh token při obnově rotovat. Když se nový token
  // neuloží, starý už nemusí platit a nový by se tiše ztratil — proto
  // nepokračujeme, jako by bylo uloženo, a vracíme selhání.
  if (updateError) {
    logError('graph.tokenUpdate', updateError, { memberId: user.id })
    return { ok: false, error: 'Nepodařilo se uložit obnovené přihlášení k Outlooku. Zkus to znovu, případně připoj účet znovu v Nastavení.' }
  }
  return { ok: true, accessToken: refreshed.access_token }
}
