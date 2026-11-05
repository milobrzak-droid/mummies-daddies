import { NextResponse, type NextRequest } from 'next/server'
import { msGraphEnabled } from '@/lib/msGraph'
import { createClient } from '@/lib/supabase/server'
import { tryRequireUser } from '@/lib/auth/requireUser'
import { logError } from '@/lib/log'
import {
  exchangeCodeForToken,
  getMe,
  normalizeGrantedScopes,
  safeEqual,
  OAUTH_STATE_COOKIE,
  OAUTH_VERIFIER_COOKIE,
  OAUTH_COOKIE_PATH,
} from '@/connectors/graph'

// Přesměrování, které zároveň smaže obě OAuth cookie. Nonce je jednorázový,
// takže se maže při každém výsledku (úspěch i chyba), ne jen při úspěchu.
function redirectAndClear(request: NextRequest, path: string): NextResponse {
  const response = NextResponse.redirect(new URL(path, request.url))
  for (const name of [OAUTH_STATE_COOKIE, OAUTH_VERIFIER_COOKIE]) {
    response.cookies.set(name, '', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 0,
      path: OAUTH_COOKIE_PATH,
    })
  }
  return response
}

// Microsoft redirects here after the user approves (or denies) consent.
export async function GET(request: NextRequest) {
  // Pošta firmy je Google Workspace; Outlook jen s MS_GRAPH_ENABLED (lib/msGraph.ts).
  if (!msGraphEnabled()) return new NextResponse(null, { status: 404 })
  const { searchParams } = new URL(request.url)
  const code = searchParams.get('code')
  const state = searchParams.get('state')

  const user = await tryRequireUser({ aal2: true })
  if (!user) return NextResponse.redirect(new URL('/login', request.url))

  const supabase = await createClient()

  // CSRF / login-CSRF kontrola: state musí být nonce z cookie, kterou nastavil
  // /api/ms/connect v TOMTO prohlížeči (porovnání v konstantním čase). Bez
  // cookie (jiný prohlížeč, vypršelých 10 minut) se nic nepropojí.
  const expectedState = request.cookies.get(OAUTH_STATE_COOKIE)?.value
  const codeVerifier = request.cookies.get(OAUTH_VERIFIER_COOKIE)?.value
  if (!code || !state || !codeVerifier || !safeEqual(state, expectedState)) {
    return redirectAndClear(request, '/cockpit/nastaveni?err=oauth')
  }

  const redirectUri = process.env.MS_REDIRECT_URI ?? new URL('/api/ms/callback', request.url).toString()

  const token = await exchangeCodeForToken(code, redirectUri, codeVerifier)
  if (!token) return redirectAndClear(request, '/cockpit/nastaveni?err=oauth')

  const me = await getMe(token.access_token)
  const accountEmail = me?.mail ?? me?.userPrincipalName ?? null

  const expiresAt = new Date(Date.now() + token.expires_in * 1000).toISOString()

  // Od 0031 se access_token/refresh_token do DB zapisují jen přes tuhle
  // SECURITY DEFINER RPC, která je před uložením zašifruje (pgcrypto +
  // klíč z Vaultu) — .upsert() na plaintext sloupce už neexistuje.
  const { error } = await supabase.rpc('calendar_token_upsert_encrypted', {
    p_member_id: user.id,
    p_provider: 'microsoft',
    p_access_token: token.access_token,
    p_refresh_token: token.refresh_token,
    p_expires_at: expiresAt,
    p_account_email: accountEmail,
  })
  if (error) return redirectAndClear(request, '/cockpit/nastaveni?err=oauth')

  // Udělená oprávnění (pole `scope` z výměny kódu) — kvůli upozornění
  // „Chybí oprávnění: …" v Nastavení. Best-effort: bez migrace 0060
  // (sloupec chybí) nebo při chybě se připojení nezmaří, jen se to zaloguje.
  // null = neznámé (Microsoft scope nevrátil) — přepíše i starou hodnotu,
  // ať po novém připojení nezůstane zastaralý stav.
  const { error: scopeError } = await supabase
    .from('calendar_token')
    .update({ granted_scopes: normalizeGrantedScopes(token.scope) })
    .eq('member_id', user.id)
  if (scopeError) logError('ms.callback.grantedScopes', scopeError)

  return redirectAndClear(request, '/cockpit/nastaveni?connected=1')
}
