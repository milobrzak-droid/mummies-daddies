import { createAdminClient } from '@/lib/supabase/admin'
import {
  randomToken, CORS_HEADERS, isAllowedRedirectUri, allowedRedirectHosts, checkRegisterRate, clientIp,
} from '@/lib/oauth'
import { registerOAuthClient } from '@/lib/oauthClients'
import { readLimitedBody } from '@/lib/httpBody'

// Dynamic Client Registration (RFC 7591). claude.ai se u nás sám zaregistruje
// jako první krok připojení konektoru — bez tohohle endpointu skončí flow
// hláškou „Couldn't register with … sign-in service".
//
// Registrace je otevřená (kdokoli může získat client_id), což je u DCR běžné:
// samotné client_id nedává přístup k datům. redirect_uri je ale omezená na
// známé hosty (claude.ai, claude.com + env OAUTH_REDIRECT_HOSTS) a loopback,
// takže autorizační kód nedoputuje na útočníkův web. Skutečná brána je /authorize,
// kde se musí přihlásit admin Cockpitu a přístup schválit. client_name volí
// registrující, proto ho souhlasná obrazovka ukazuje jako neověřený údaj
// a vedle něj skutečný host redirect_uri. Registrace má per-IP brzdu
// (viz checkRegisterRate v lib/oauth.ts a její omezení na serverless).
//
// Limity proti zaplnění DB anonymními registracemi: tělo max 16 KB,
// každý redirect_uri max 2048 znaků, nejvýš 10 URI.
const MAX_BODY_BYTES = 16 * 1024
const MAX_REDIRECT_URI_LENGTH = 2048

export async function POST(req: Request) {
  if (!checkRegisterRate(clientIp(req))) {
    return Response.json(
      { error: 'rate_limited' },
      { status: 429, headers: { ...CORS_HEADERS, 'Retry-After': '3600' } },
    )
  }

  const declared = Number(req.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    return Response.json({ error: 'invalid_client_metadata' }, { status: 413, headers: CORS_HEADERS })
  }

  let body: { redirect_uris?: unknown; client_name?: unknown }
  try {
    // Content-Length může chybět (chunked): tělo se čte po částech a přeruší na stropu.
    const read = await readLimitedBody(req, MAX_BODY_BYTES)
    if (!read.ok) {
      return Response.json({ error: 'invalid_client_metadata' }, { status: read.status === 413 ? 413 : 400, headers: CORS_HEADERS })
    }
    body = JSON.parse(read.text)
    if (!body || typeof body !== 'object') throw new Error('not an object')
  } catch {
    return Response.json({ error: 'invalid_client_metadata' }, { status: 400, headers: CORS_HEADERS })
  }

  const redirectUris = Array.isArray(body.redirect_uris)
    ? body.redirect_uris.filter((u): u is string => typeof u === 'string' && u.length > 0)
    : []
  if (redirectUris.length === 0) {
    return Response.json(
      { error: 'invalid_redirect_uri', error_description: 'redirect_uris je povinné' },
      { status: 400, headers: CORS_HEADERS },
    )
  }
  if (
    redirectUris.length > 10
    || redirectUris.some((u) => u.length > MAX_REDIRECT_URI_LENGTH)
    || !redirectUris.every(isAllowedRedirectUri)
  ) {
    return Response.json(
      {
        error: 'invalid_redirect_uri',
        error_description:
          'redirect_uri není povolená: https jen na známé hosty konektorů '
          + `(${allowedRedirectHosts().join(', ')}), nebo http na localhost / 127.0.0.1`,
      },
      { status: 400, headers: CORS_HEADERS },
    )
  }

  const clientName = typeof body.client_name === 'string' ? body.client_name.slice(0, 100) : null

  const admin = createAdminClient()

  // Deduplikace: stejný client_name + stejná množina redirect_uris = stejný
  // klient. Claude registruje klienta při každém přidání konektoru a bez
  // tohohle vznikal pro každé připojení nový client_id (a v seznamu klientů
  // Cockpitu hromada shodných záznamů). Client_id je veřejný údaj, takže jeho
  // opětovné vrácení nic neprozrazuje; přístup dál dává až schválení v /authorize.
  const existing = await findExistingClient(admin, clientName, redirectUris)
  if (existing) return registrationResponse(existing, clientName, redirectUris, 201)

  const clientId = `cockpit-client_${randomToken(16)}`
  // Strop neschválených klientů v DB (migrace 0096): limit v paměti instance
  // (checkRegisterRate) zastaví jednu IP, tohle zaplavení tabulky z víc míst.
  const outcome = await registerOAuthClient(admin, { clientId, clientName, redirectUris })
  if (outcome === 'limit') {
    return Response.json(
      { error: 'temporarily_unavailable' },
      { status: 429, headers: { ...CORS_HEADERS, 'Retry-After': '3600' } },
    )
  }
  if (outcome === 'error') {
    return Response.json({ error: 'server_error' }, { status: 500, headers: CORS_HEADERS })
  }

  return registrationResponse(clientId, clientName, redirectUris, 201)
}

function registrationResponse(clientId: string, clientName: string | null, redirectUris: string[], status: number) {
  return Response.json(
    {
      client_id: clientId,
      client_name: clientName,
      redirect_uris: redirectUris,
      // Veřejný klient s PKCE — žádný secret se nevydává ani neukládá.
      token_endpoint_auth_method: 'none',
      // refresh_token: klient si tím může obnovit přístup bez nového schvalování.
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
    },
    { status, headers: CORS_HEADERS },
  )
}

async function findExistingClient(
  admin: ReturnType<typeof createAdminClient>,
  clientName: string | null,
  redirectUris: string[],
): Promise<string | null> {
  const wanted = [...new Set(redirectUris)].sort()
  // `contains` (redirect_uris @> wanted) zúží výběr v DB: bez něj by stovka
  // klientů téhož jména s jinými adresami zatlačila skutečného za limit 50 řádků.
  let q = admin.from('oauth_client').select('client_id, redirect_uris').contains('redirect_uris', wanted)
    .order('created_at', { ascending: true }).limit(50)
  q = clientName === null ? q.is('client_name', null) : q.eq('client_name', clientName)
  const { data, error } = await q
  if (error || !data) return null
  const hit = (data as { client_id: string; redirect_uris: string[] }[]).find((c) => {
    const have = [...new Set(c.redirect_uris)].sort()
    return have.length === wanted.length && have.every((u, i) => u === wanted[i])
  })
  return hit?.client_id ?? null
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS })
}
