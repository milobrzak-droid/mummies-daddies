import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import { supabaseUrl, supabaseAnonKey } from './env'
import { mfaEnforced } from '@/lib/auth/mfa'
import { COCKPIT_HOME, isPublicWebPath, matchesSegment } from '@/lib/routes'

// Server Action: Next 16 (server/lib/server-action-request-meta.js) bere jako
// možnou action nejen POST s hlavičkou `Next-Action`, ale i KAŽDÝ POST
// s multipart/form-data nebo application/x-www-form-urlencoded — no-JS cesta
// čte ID action z pole formuláře `$ACTION_ID_<id>`. Hlavička tedy nestačí.
// Pro účely brány proto bereme jako action jakýkoli ne-GET/HEAD požadavek na
// cestu stránky (mimo /api/* a /.well-known/*, které mají vlastní autentizaci).
// Takový požadavek se nikdy nesmí posoudit jako „veřejná cesta" jen podle URL.
export function isServerActionRequest(request: NextRequest): boolean {
  const method = request.method.toUpperCase()
  if (method === 'GET' || method === 'HEAD') return false
  const path = request.nextUrl.pathname
  return !matchesSegment(path, '/api') && !matchesSegment(path, '/.well-known')
}

// `/login` a `/login/...`, ale ne `/loginx` (lib/routes.ts).
export { matchesSegment }

function deny(request: NextRequest, status: 401 | 403, target: string) {
  // Action volá fetch z klienta — redirect by nepochopil, dostane 401/403.
  if (isServerActionRequest(request)) {
    return NextResponse.json({ error: status === 401 ? 'unauthenticated' : 'mfa_required' }, { status })
  }
  const url = request.nextUrl.clone(); url.pathname = target; url.search = ''
  // Po MFA vrátit tam, kam uživatel mířil (typicky /api/oauth/authorize).
  url.searchParams.set('next', `${request.nextUrl.pathname}${request.nextUrl.search}`)
  return NextResponse.redirect(url)
}

export async function updateSession(request: NextRequest) {
  // Veřejný web (vše mimo /cockpit, /login, /auth, /api — lib/routes.ts):
  // stránky bez přihlášení a bez práce se session. Server Action (POST na
  // stránku) sem nepatří — ta jde dál do plné brány.
  if (!isServerActionRequest(request) && isPublicWebPath(request.nextUrl.pathname)) {
    return NextResponse.next({ request })
  }
  let response = NextResponse.next({ request })
  const supabase = createServerClient(
    supabaseUrl,
    supabaseAnonKey,
    {
      cookies: {
        getAll() { return request.cookies.getAll() },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value))
          response = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            response.cookies.set(name, value, options))
        },
      },
    },
  )
  const { data: { user } } = await supabase.auth.getUser()

  // Brána platí pro Cockpit (/cockpit/**) a /api/**, kromě /login, auth
  // callbacku, interních cest Next.js a strojových rozhraní volaných bez
  // cookie session:
  //   /api/web/*               — veřejná API webu (formuláře); každá routa si
  //                              sama ověří Turnstile a limit (balík P6)
  //   /api/v1, /api/mcp        — API-key auth uvnitř route handleru
  //   /.well-known/*           — OAuth discovery metadata (musí být veřejná)
  //   /api/oauth/register|token — OAuth flow volaný serverem klienta
  //   /api/cron/*              — Vercel Cron volá bez cookie session, ověřuje
  //                              se sám přes Authorization: Bearer CRON_SECRET
  //                              (viz app/api/cron/*/route.ts); bez výjimky
  //                              tady by GET vždy skončil redirectem na /login
  //                              a žádný cron by se nikdy nespustil.
  //   /api/ms/notifications    — webhook Microsoft Graph (clientState uvnitř
  //                              route; jen tahle přesná cesta, zbytek /api/ms
  //                              — connect, callback — zůstává za přihlášením)
  // Ta rozhraní si autentizaci řeší sama; redirect na /login by je rozbil.
  //
  // /api/oauth/authorize schválně NENÍ veřejná — tam se má člověk přihlásit
  // a přístup potvrdit, což je jediné místo, kde v OAuth flow vzniká klíč.
  const path = request.nextUrl.pathname
  const isAction = isServerActionRequest(request)
  const isPublicPath = matchesSegment(path, '/login') || matchesSegment(path, '/auth')
    || path.startsWith('/_next/') || path === '/favicon.ico'
    || matchesSegment(path, '/api/v1') || matchesSegment(path, '/api/mcp')
    // Veřejná API webu (PUBLIC_WEB_API_PREFIX v lib/routes.ts).
    || matchesSegment(path, '/api/web')
    || path.startsWith('/.well-known/')
    || path === '/api/oauth/register' || path === '/api/oauth/token'
    // Vercel cron nemá session; každý handler si sám ověří Bearer CRON_SECRET
    // (constant-time) a bez vypínače vrací 404.
    || matchesSegment(path, '/api/cron')
    || path === '/api/ms/notifications'
    // Browsers POST CSP violation reports with no app session/cookies at all —
    // gating this would just turn every report into a lost redirect to /login.
    || path === '/api/csp-report'
    // Externí uptime monitor nemá session; veřejná odpověď nese jen stav
    // (ok/degraded/down), detail jen s Bearer HEALTH_TOKEN (app/api/health).
    || path === '/api/health'
    // Vercel Cron nemá session a redirect nenásleduje. Autentizace je
    // povinná konstantní kontrola Bearer CRON_SECRET v každé routě
    // app/api/cron/* (hlídá test/route-auth-guard.test.ts).
    || matchesSegment(path, '/api/cron')
  // Server Actions: jediná action, kterou smí volat nepřihlášený, je signIn na
  // /login. Na /auth/* (MFA výzva, odhlášení) stačí přihlášení bez AAL2 —
  // jinak by se člověk z AAL1 nedostal. Všude jinde plná brána.
  const isPublic = isAction ? path === '/login' : isPublicPath
  // Pozor: ID action je globální, na /auth/* jde tedy spustit JAKOUKOLI action
  // s AAL1. Proto si každá action kromě signIn/signOut/MFA sama kontroluje
  // requireUser({ aal2: true }) — hlídá to test/auth-actions-guard.test.ts.
  const mfaExempt = isAction ? path === '/login' || matchesSegment(path, '/auth') : isPublicPath
  if (!user && !isPublic) {
    if (isAction) return deny(request, 401, '/login')
    // Zapamatuj si, kam uživatel mířil, ať ho tam po přihlášení vrátíme.
    // Bez toho by se rozbil OAuth flow: /api/oauth/authorize by po loginu
    // skončil na dashboardu a klient by nikdy nedostal svůj kód.
    const next = `${path}${request.nextUrl.search}`
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    url.search = ''
    url.searchParams.set('next', next)
    return NextResponse.redirect(url)
  }
  if (user && path === '/login' && !isAction) {
    const url = request.nextUrl.clone()
    url.pathname = COCKPIT_HOME
    url.search = ''
    return NextResponse.redirect(url)
  }

  // MFA je vynucené VŽDY, nouzově jde vypnout MFA_ENFORCED=false (loguje se
  // varování). Uživatel s faktorem musí projít TOTP výzvou, bez faktoru jde na
  // enrollment. /auth/* zůstává dostupné (únik přes „Odhlásit").
  // Selhání ověření = zavřeno: radši poslat na /auth/mfa než pustit dál.
  if (user && !mfaExempt && mfaEnforced()) {
    try {
      const { data: aal, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
      if (error || !aal) return deny(request, 403, '/auth/mfa')
      if (aal.currentLevel !== 'aal2') {
        // Bez faktoru → enrollment; s faktorem, ale jen AAL1 → výzva.
        const noFactor = aal.nextLevel === 'aal1'
        return deny(request, 403, noFactor ? '/auth/mfa/enroll' : '/auth/mfa')
      }
    } catch {
      return deny(request, 403, '/auth/mfa')
    }
  }

  return response
}
