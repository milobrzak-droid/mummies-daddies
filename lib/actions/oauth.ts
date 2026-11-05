'use server'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { tryRequireUser } from '@/lib/auth/requireUser'
import { randomToken, isAllowedRedirectUri } from '@/lib/oauth'
import { seesByznys } from '@/lib/domain'
import { normalizeOAuthScope, type OAuthScope } from '@/lib/oauthTokens'
import { dbErrorMessage } from '@/lib/actionResult'
import { readActiveMember } from '@/lib/auth/activeMember'
import { markOAuthClientApproved } from '@/lib/oauthClients'

const CODE_TTL_MS = 60_000

// Schválení přístupu na /api/oauth/authorize. Vydává jen krátkodobý
// jednorázový kód se jménem schvalovatele a zvoleným rozsahem ('read' nebo
// 'full') — API klíč vzniká až při výměně kódu na /api/oauth/token, takže
// v oauth_code nikdy neleží plaintext klíče (migrace 0043). Rozsah 'full'
// (zápis) smí zvolit jen schvalovatel s obchodní rolí; token endpoint to
// při vydání ověří znovu.
//
// Schvalovat smí jen admin s AAL2 (prošlou TOTP výzvou) — tahle action
// otevírá data externí aplikaci, takže nestačí samotné přihlášení.
export async function approveOAuth(formData: FormData): Promise<void> {
  const user = await tryRequireUser({ aal2: true })
  if (!user) redirect('/login')

  const supabase = await createClient()
  const { row: me } = await readActiveMember<{ is_admin?: boolean | null; role?: string | null }>(
    supabase, user.id, 'is_admin, role',
  )
  if (!me?.is_admin) throw new Error('Nemáš oprávnění schválit připojení.')

  const clientId = String(formData.get('client_id') ?? '')
  const redirectUri = String(formData.get('redirect_uri') ?? '')
  const codeChallenge = String(formData.get('code_challenge') ?? '')
  const state = String(formData.get('state') ?? '')
  if (!clientId || !redirectUri || !codeChallenge) throw new Error('Neplatný požadavek.')
  // Bez výslovné volby jen čtení (fail closed).
  const scope: OAuthScope = normalizeOAuthScope(formData.get('scope'))
  if (scope === 'full' && !seesByznys((me as { role?: string | null }).role)) {
    throw new Error('Zápis může povolit jen schvalovatel s obchodní rolí (vedení, obchodník).')
  }

  const admin = createAdminClient()

  // Znovu ověř klienta i redirect_uri proti DB — na hodnoty z formuláře se
  // nedá spolehnout, mohly by být podvržené.
  const { data: client } = await admin
    .from('oauth_client').select('client_id, redirect_uris')
    .eq('client_id', clientId).maybeSingle()
  if (!client || !client.redirect_uris.includes(redirectUri)) throw new Error('Neznámý klient.')
  // Klient zaregistrovaný před zavedením seznamu hostů smí dál jen na povolené.
  if (!isAllowedRedirectUri(redirectUri)) throw new Error('Adresa pro návrat není povolená.')

  const code = randomToken(32)
  const codeRow = {
    code,
    client_id: clientId,
    redirect_uri: redirectUri,
    code_challenge: codeChallenge,
    approved_by: user.id,
    expires_at: new Date(Date.now() + CODE_TTL_MS).toISOString(),
  }
  let { error: codeError } = await admin.from('oauth_code').insert({ ...codeRow, scope })
  // Tolerance k nenasazené 0083 (sloupec scope chybí): jen čtení projde
  // (token se vydá jako 'read'), zápis ne — ten bez migrace slíbit nejde.
  if (codeError && (codeError.code === '42703' || codeError.code === 'PGRST204')) {
    if (scope === 'full') throw new Error('Zápis zatím nejde povolit — chybí migrace 0083.')
    ;({ error: codeError } = await admin.from('oauth_code').insert(codeRow))
  }
  if (codeError) throw new Error(dbErrorMessage('approveOAuth', codeError))
  // Schválený klient se nemaže jako neschválený a nepočítá se do stropu registrací (0096).
  await markOAuthClientApproved(admin, clientId)

  const target = new URL(redirectUri)
  target.searchParams.set('code', code)
  if (state) target.searchParams.set('state', state)
  redirect(target.toString())
}
