import type { createAdminClient } from '@/lib/supabase/admin'
import { logError } from '@/lib/log'

// Registrace a schválení OAuth klientů (tabulka oauth_client) s ohledem na
// zaplavení. Registrace je anonymní (Dynamic Client Registration), takže jediné
// místo, které DB skutečně zaplní, je počet klientů, které nikdo nikdy neschválil.
//
// Migrace 0096: oauth_client.approved_at (nastaví souhlas admina) a RPC
// oauth_client_register (strop neschválených + úklid starších než 3 dny, vše pod
// zámkem). Bez migrace se klient vloží přímo jako dřív (bez stropu) a
// approved_at se nezapisuje; nic se nerozbije.

type Admin = ReturnType<typeof createAdminClient>

/** Kolik neschválených klientů smí naráz existovat. Legitimních je řádově jednotky. */
export const UNAPPROVED_CLIENT_LIMIT = 200

export type RegisterOutcome = 'created' | 'limit' | 'error'

function isMissingRpc(error: { code?: string } | null | undefined): boolean {
  return error?.code === '42883' || error?.code === 'PGRST202' || error?.code === 'rpc_unavailable'
}

export async function registerOAuthClient(
  admin: Admin,
  client: { clientId: string; clientName: string | null; redirectUris: string[] },
  limit: number = UNAPPROVED_CLIENT_LIMIT,
): Promise<RegisterOutcome> {
  let res: { data: unknown; error: { code?: string; message?: string } | null }
  try {
    res = (await admin.rpc('oauth_client_register', {
      p_client_id: client.clientId,
      p_client_name: client.clientName,
      p_redirect_uris: client.redirectUris,
      p_max_unapproved: limit,
    })) as typeof res
  } catch {
    res = { data: null, error: { code: 'rpc_unavailable' } }
  }
  if (!res.error) return res.data === true ? 'created' : 'limit'
  if (!isMissingRpc(res.error)) {
    logError('oauth.register', res.error)
    return 'error'
  }

  // Původní cesta (migrace 0096 ještě není nasazená).
  const { error } = await admin.from('oauth_client').insert({
    client_id: client.clientId,
    client_name: client.clientName,
    redirect_uris: client.redirectUris,
  })
  if (error) {
    logError('oauth.register', error)
    return 'error'
  }
  return 'created'
}

/** Souhlas admina: klient přestává být „jen zaregistrovaný". Chyba (chybí sloupec) se toleruje. */
export async function markOAuthClientApproved(admin: Admin, clientId: string): Promise<void> {
  try {
    const { error } = await admin
      .from('oauth_client')
      .update({ approved_at: new Date().toISOString() })
      .eq('client_id', clientId)
      .is('approved_at', null)
    if (error && error.code !== '42703' && error.code !== 'PGRST204') logError('oauth.approve', error)
  } catch (e) {
    logError('oauth.approve', e)
  }
}
