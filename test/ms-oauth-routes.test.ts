// @vitest-environment node
// happy-dom má vlastní Headers, které zahazují „zakázanou" hlavičku Cookie,
// takže NextRequest v něm nikdy nevidí cookie. Route handlery běží na serveru
// (Node), proto tenhle soubor běží v prostředí node.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { tryRequireUser } from '@/lib/auth/requireUser'
import { codeChallengeS256, exchangeCodeForToken, getMe } from '@/connectors/graph'
import { GET as connect } from '@/app/api/ms/connect/route'
import { GET as callback } from '@/app/api/ms/callback/route'
import { createSupabaseFake, opArgs, type QueryCall, type QueryResult } from './helpers/supabaseFake'

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
// Brána interní role + AAL2 (N13) je mockovaná; její vlastní test je test/auth-*.
vi.mock('@/lib/auth/requireUser', () => ({ tryRequireUser: vi.fn() }))
// Síťové části konektoru jsou mockované; nonce/PKCE/getAuthUrl/safeEqual zůstávají skutečné.
vi.mock('@/connectors/graph', async importOriginal => ({
  ...(await importOriginal<typeof import('@/connectors/graph')>()),
  exchangeCodeForToken: vi.fn(),
  getMe: vi.fn(),
}))

const STATE_COOKIE = 'ms_oauth_state'
const VERIFIER_COOKIE = 'ms_oauth_verifier'
const ORIGIN = 'http://localhost:3000'

function setup(opts: { user?: { id: string } | null; upsert?: QueryResult; scopeUpdate?: QueryResult } = {}) {
  const fake = createSupabaseFake({
    user: opts.user === undefined ? { id: 'member-1' } : opts.user,
    rpc: () => opts.upsert ?? { data: null, error: null },
    resolve: (call: QueryCall) => (call.table === 'calendar_token' ? opts.scopeUpdate : undefined) ?? { data: null, error: null },
  })
  vi.mocked(createClient).mockResolvedValue(fake.client as never)
  vi.mocked(tryRequireUser).mockResolvedValue((opts.user === undefined ? { id: 'member-1' } : opts.user) as never)
  return fake
}

function callbackRequest(query: Record<string, string>, cookies: Record<string, string> = {}) {
  const url = new URL('/api/ms/callback', ORIGIN)
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v)
  const cookie = Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join('; ')
  return new NextRequest(url, { headers: cookie ? { cookie } : {} })
}

const locationOf = (res: Response) => new URL(res.headers.get('location')!, ORIGIN)

function expectBothCookiesCleared(res: { cookies: { get(name: string): { value: string; maxAge?: number; httpOnly?: boolean; path?: string } | undefined } }) {
  for (const name of [STATE_COOKIE, VERIFIER_COOKIE]) {
    expect(res.cookies.get(name)).toMatchObject({ value: '', maxAge: 0, httpOnly: true, path: '/api/ms' })
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('MS_GRAPH_ENABLED', 'true')
  vi.stubEnv('MS_CLIENT_ID', 'client-id-123')
  vi.stubEnv('MS_CLIENT_SECRET', 'client-secret')
  vi.stubEnv('MS_REDIRECT_URI', undefined)
  vi.stubEnv('MS_TENANT_ID', 'common')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('GET /api/ms/connect', () => {
  test('sets both httpOnly cookies and redirects to Microsoft with matching state and PKCE challenge', async () => {
    setup()
    const res = await connect(new NextRequest(`${ORIGIN}/api/ms/connect`))

    expect(res.status).toBe(307)
    const loc = locationOf(res)
    expect(loc.origin + loc.pathname).toBe('https://login.microsoftonline.com/common/oauth2/v2.0/authorize')

    const state = res.cookies.get(STATE_COOKIE)
    const verifier = res.cookies.get(VERIFIER_COOKIE)
    expect(state).toBeDefined()
    expect(verifier).toBeDefined()
    for (const c of [state, verifier]) {
      expect(c).toMatchObject({ httpOnly: true, sameSite: 'lax', path: '/api/ms', maxAge: 600 })
    }
    expect(state!.value).toMatch(/^[0-9a-f]{64}$/)
    expect(verifier!.value).toMatch(/^[A-Za-z0-9_-]{43}$/)

    expect(loc.searchParams.get('state')).toBe(state!.value)
    // State v URL není user.id (uuid kolegy).
    expect(loc.searchParams.get('state')).not.toBe('member-1')
    expect(loc.searchParams.get('code_challenge')).toBe(codeChallengeS256(verifier!.value))
    expect(loc.searchParams.get('code_challenge_method')).toBe('S256')
    // Verifier sám nikdy do URL nejde.
    expect(loc.toString()).not.toContain(verifier!.value)
    expect(loc.searchParams.get('client_id')).toBe('client-id-123')
    expect(loc.searchParams.get('redirect_uri')).toBe(`${ORIGIN}/api/ms/callback`)
  })

  test('MS_REDIRECT_URI overrides the request-derived redirect_uri', async () => {
    setup()
    vi.stubEnv('MS_REDIRECT_URI', 'https://cockpit.example/api/ms/callback')
    const res = await connect(new NextRequest(`${ORIGIN}/api/ms/connect`))
    expect(locationOf(res).searchParams.get('redirect_uri')).toBe('https://cockpit.example/api/ms/callback')
  })

  test('each call issues a fresh nonce and verifier', async () => {
    setup()
    const a = await connect(new NextRequest(`${ORIGIN}/api/ms/connect`))
    const b = await connect(new NextRequest(`${ORIGIN}/api/ms/connect`))
    expect(a.cookies.get(STATE_COOKIE)!.value).not.toBe(b.cookies.get(STATE_COOKIE)!.value)
    expect(a.cookies.get(VERIFIER_COOKIE)!.value).not.toBe(b.cookies.get(VERIFIER_COOKIE)!.value)
  })

  test('cookies are secure in production', async () => {
    setup()
    vi.stubEnv('NODE_ENV', 'production')
    const res = await connect(new NextRequest(`${ORIGIN}/api/ms/connect`))
    expect(res.cookies.get(STATE_COOKIE)).toMatchObject({ secure: true })
    expect(res.cookies.get(VERIFIER_COOKIE)).toMatchObject({ secure: true })
  })

  test('not logged in: redirects to /login and sets no cookies', async () => {
    setup({ user: null })
    const res = await connect(new NextRequest(`${ORIGIN}/api/ms/connect`))
    expect(locationOf(res).pathname).toBe('/login')
    expect(res.cookies.getAll()).toHaveLength(0)
  })

  test('reconnect=1 (Znovu připojit v Nastavení) → prompt=consent se všemi GRAPH_SCOPES', async () => {
    setup()
    const res = await connect(new NextRequest(`${ORIGIN}/api/ms/connect?reconnect=1`))
    const loc = locationOf(res)
    expect(loc.searchParams.get('prompt')).toBe('consent')
    expect(loc.searchParams.get('scope')).toBe('offline_access Calendars.ReadWrite User.Read Mail.Read Mail.Send')
    expect(res.cookies.get(STATE_COOKIE)).toBeDefined()
  })

  test('bez reconnect (nebo s jinou hodnotou) žádný prompt — parametr neprochází dál', async () => {
    setup()
    for (const q of ['', '?reconnect=0', '?reconnect=login', '?prompt=none']) {
      const res = await connect(new NextRequest(`${ORIGIN}/api/ms/connect${q}`))
      expect(locationOf(res).searchParams.has('prompt'), q).toBe(false)
    }
  })

  test('Microsoft not configured: redirects to /nastaveni?err=notconfigured and sets no cookies', async () => {
    setup()
    vi.stubEnv('MS_CLIENT_SECRET', '')
    const res = await connect(new NextRequest(`${ORIGIN}/api/ms/connect`))
    const loc = locationOf(res)
    expect(loc.pathname + loc.search).toBe('/cockpit/nastaveni?err=notconfigured')
    expect(res.cookies.getAll()).toHaveLength(0)
  })
})

describe('GET /api/ms/callback', () => {
  const GOOD_COOKIES = { [STATE_COOKIE]: 'nonce-abc', [VERIFIER_COOKIE]: 'verifier-xyz' }

  test.each([
    ['missing state cookie', { code: 'c', state: 'nonce-abc' }, { [VERIFIER_COOKIE]: 'verifier-xyz' }],
    ['missing verifier cookie', { code: 'c', state: 'nonce-abc' }, { [STATE_COOKIE]: 'nonce-abc' }],
    ['no cookies at all', { code: 'c', state: 'nonce-abc' }, {}],
    ['mismatched state', { code: 'c', state: 'other-nonce' }, GOOD_COOKIES],
    ['missing state param', { code: 'c' }, GOOD_COOKIES],
    ['missing code', { state: 'nonce-abc' }, GOOD_COOKIES],
    ['Microsoft error instead of code', { error: 'access_denied', state: 'nonce-abc' }, GOOD_COOKIES],
  ])('%s: redirects to /nastaveni?err=oauth, clears both cookies, no token exchange', async (_label, query, cookies) => {
    const fake = setup()
    const res = await callback(callbackRequest(query, cookies))

    const loc = locationOf(res)
    expect(loc.pathname + loc.search).toBe('/cockpit/nastaveni?err=oauth')
    expectBothCookiesCleared(res)
    expect(exchangeCodeForToken).not.toHaveBeenCalled()
    expect(getMe).not.toHaveBeenCalled()
    expect(fake.rpc).not.toHaveBeenCalled()
  })

  test('not logged in: redirects to /login before looking at state, exchange not called', async () => {
    setup({ user: null })
    const res = await callback(callbackRequest({ code: 'c', state: 'nonce-abc' }, GOOD_COOKIES))
    expect(locationOf(res).pathname).toBe('/login')
    expect(exchangeCodeForToken).not.toHaveBeenCalled()
  })

  test('matching state: exchanges the code with the cookie verifier, stores encrypted tokens, clears cookies', async () => {
    const fake = setup()
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date('2026-09-28T12:00:00.000Z'))
      vi.mocked(exchangeCodeForToken).mockResolvedValue({ access_token: 'acc', refresh_token: 'ref', expires_in: 3600 })
      vi.mocked(getMe).mockResolvedValue({ mail: 'viktor@mummiesdaddies.com', userPrincipalName: 'upn@mummiesdaddies.com' })

      const res = await callback(callbackRequest({ code: 'the-code', state: 'nonce-abc' }, GOOD_COOKIES))

      expect(exchangeCodeForToken).toHaveBeenCalledWith('the-code', `${ORIGIN}/api/ms/callback`, 'verifier-xyz')
      expect(getMe).toHaveBeenCalledWith('acc')
      expect(fake.rpc).toHaveBeenCalledWith('calendar_token_upsert_encrypted', {
        p_member_id: 'member-1',
        p_provider: 'microsoft',
        p_access_token: 'acc',
        p_refresh_token: 'ref',
        p_expires_at: '2026-09-28T13:00:00.000Z',
        p_account_email: 'viktor@mummiesdaddies.com',
      })
      const loc = locationOf(res)
      expect(loc.pathname + loc.search).toBe('/cockpit/nastaveni?connected=1')
      expectBothCookiesCleared(res)
    } finally {
      vi.useRealTimers()
    }
  })

  test('uloží udělená oprávnění (scope z výměny kódu) k vlastnímu řádku calendar_token', async () => {
    const fake = setup()
    vi.mocked(exchangeCodeForToken).mockResolvedValue({
      access_token: 'acc', refresh_token: 'ref', expires_in: 3600,
      scope: 'https://graph.microsoft.com/Calendars.ReadWrite https://graph.microsoft.com/Mail.Read https://graph.microsoft.com/Mail.Send https://graph.microsoft.com/User.Read openid',
    })
    vi.mocked(getMe).mockResolvedValue({ mail: 'viktor@mummiesdaddies.com' })
    const res = await callback(callbackRequest({ code: 'c', state: 'nonce-abc' }, GOOD_COOKIES))
    expect(locationOf(res).search).toBe('?connected=1')
    const update = fake.calls.find((c) => c.table === 'calendar_token')!
    expect(opArgs(update, 'update')).toEqual([{ granted_scopes: 'Calendars.ReadWrite Mail.Read Mail.Send User.Read openid' }])
    expect(opArgs(update, 'eq')).toEqual(['member_id', 'member-1'])
    // tokeny do tohohle zápisu nepatří
    expect(JSON.stringify(update)).not.toContain('acc')
  })

  test('scope chybí → granted_scopes null (žádný zastaralý stav po novém připojení)', async () => {
    const fake = setup()
    vi.mocked(exchangeCodeForToken).mockResolvedValue({ access_token: 'acc', refresh_token: 'ref', expires_in: 3600 })
    vi.mocked(getMe).mockResolvedValue(null)
    await callback(callbackRequest({ code: 'c', state: 'nonce-abc' }, GOOD_COOKIES))
    expect(opArgs(fake.calls.find((c) => c.table === 'calendar_token')!, 'update')).toEqual([{ granted_scopes: null }])
  })

  test('zápis oprávnění selže (např. bez migrace 0060) → připojení i tak uspěje', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    setup({ scopeUpdate: { data: null, error: { code: 'PGRST204', message: "Could not find the 'granted_scopes' column" } } })
    vi.mocked(exchangeCodeForToken).mockResolvedValue({ access_token: 'acc', refresh_token: 'ref', expires_in: 3600, scope: 'Mail.Send' })
    vi.mocked(getMe).mockResolvedValue(null)
    const res = await callback(callbackRequest({ code: 'c', state: 'nonce-abc' }, GOOD_COOKIES))
    const loc = locationOf(res)
    expect(loc.pathname + loc.search).toBe('/cockpit/nastaveni?connected=1')
    expectBothCookiesCleared(res)
    expect(errSpy).toHaveBeenCalled()
    errSpy.mockRestore()
  })

  test('uses MS_REDIRECT_URI for the exchange when set', async () => {
    setup()
    vi.stubEnv('MS_REDIRECT_URI', 'https://cockpit.example/api/ms/callback')
    vi.mocked(exchangeCodeForToken).mockResolvedValue({ access_token: 'acc', refresh_token: 'ref', expires_in: 3600 })
    vi.mocked(getMe).mockResolvedValue(null)
    await callback(callbackRequest({ code: 'c', state: 'nonce-abc' }, GOOD_COOKIES))
    expect(exchangeCodeForToken).toHaveBeenCalledWith('c', 'https://cockpit.example/api/ms/callback', 'verifier-xyz')
  })

  test('failed token exchange: err=oauth, cookies cleared, nothing stored', async () => {
    const fake = setup()
    vi.mocked(exchangeCodeForToken).mockResolvedValue(null)
    const res = await callback(callbackRequest({ code: 'c', state: 'nonce-abc' }, GOOD_COOKIES))
    const loc = locationOf(res)
    expect(loc.pathname + loc.search).toBe('/cockpit/nastaveni?err=oauth')
    expectBothCookiesCleared(res)
    expect(fake.rpc).not.toHaveBeenCalled()
  })

  test('failed token storage: err=oauth and cookies cleared', async () => {
    setup({ upsert: { data: null, error: { message: 'vault down' } } })
    vi.mocked(exchangeCodeForToken).mockResolvedValue({ access_token: 'acc', refresh_token: 'ref', expires_in: 3600 })
    vi.mocked(getMe).mockResolvedValue({ userPrincipalName: 'upn@mummiesdaddies.com' })
    const res = await callback(callbackRequest({ code: 'c', state: 'nonce-abc' }, GOOD_COOKIES))
    const loc = locationOf(res)
    expect(loc.pathname + loc.search).toBe('/cockpit/nastaveni?err=oauth')
    expectBothCookiesCleared(res)
  })
})

// Pošta firmy je Google Workspace: Outlook je vypnutý, dokud ho výslovně nezapne MS_GRAPH_ENABLED.
describe('Outlook vypnutý (bez MS_GRAPH_ENABLED)', () => {
  test('/api/ms/connect i /api/ms/callback vrací 404 a nesahají na session', async () => {
    vi.stubEnv('MS_GRAPH_ENABLED', '')
    expect((await connect(new NextRequest('https://cockpit.example/api/ms/connect'))).status).toBe(404)
    expect((await callback(new NextRequest('https://cockpit.example/api/ms/callback?code=c&state=s'))).status).toBe(404)
    expect(tryRequireUser).not.toHaveBeenCalled()
  })
})
