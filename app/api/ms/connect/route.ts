import { NextResponse, type NextRequest } from 'next/server'
import { msGraphEnabled } from '@/lib/msGraph'
import { tryRequireUser } from '@/lib/auth/requireUser'
import {
  getAuthUrl,
  msConfigured,
  generateNonce,
  generateCodeVerifier,
  codeChallengeS256,
  OAUTH_STATE_COOKIE,
  OAUTH_VERIFIER_COOKIE,
  OAUTH_COOKIE_MAX_AGE_SECONDS,
  OAUTH_COOKIE_PATH,
} from '@/connectors/graph'

// Kicks off the Microsoft OAuth flow: redirects the logged-in user to the
// Microsoft login/consent screen. Microsoft redirects back to
// /api/ms/callback with a ?code=... once the user approves.
//
// `?reconnect=1` (tlačítko „Znovu připojit (rozšířit oprávnění)" v
// Nastavení) přidá prompt=consent: Microsoft ukáže souhlas i u už
// připojeného účtu, takže starší token dostane nová práva (Mail.Read,
// Mail.Send). Callback pak řádek calendar_token přepíše (upsert) — odpojovat
// předem není potřeba. Jiné hodnoty se ignorují (žádný průchod parametru).
export async function GET(request: NextRequest) {
  // Pošta firmy je Google Workspace; Outlook jen s MS_GRAPH_ENABLED (lib/msGraph.ts).
  if (!msGraphEnabled()) return new NextResponse(null, { status: 404 })
  const user = await tryRequireUser({ aal2: true })
  if (!user) return NextResponse.redirect(new URL('/login', request.url))

  if (!msConfigured()) {
    return NextResponse.redirect(new URL('/cockpit/nastaveni?err=notconfigured', request.url))
  }

  const redirectUri = process.env.MS_REDIRECT_URI ?? new URL('/api/ms/callback', request.url).toString()

  // `state` je náhodný nonce, ne user.id (uuid kolegy jde zjistit a podstrčit
  // mu odkaz). Nonce i PKCE verifier žijí jen v httpOnly cookie prohlížeče,
  // který flow zahájil; callback je porovná. Lax stačí: callback je top-level
  // GET přesměrování z Microsoftu, takže ho prohlížeč s cookie pošle.
  const state = generateNonce()
  const codeVerifier = generateCodeVerifier()

  const prompt = request.nextUrl.searchParams.get('reconnect') === '1' ? 'consent' : undefined
  const response = NextResponse.redirect(getAuthUrl(redirectUri, state, codeChallengeS256(codeVerifier), prompt))
  const cookieOptions = {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax' as const,
    maxAge: OAUTH_COOKIE_MAX_AGE_SECONDS,
    path: OAUTH_COOKIE_PATH,
  }
  response.cookies.set(OAUTH_STATE_COOKIE, state, cookieOptions)
  response.cookies.set(OAUTH_VERIFIER_COOKIE, codeVerifier, cookieOptions)
  return response
}
