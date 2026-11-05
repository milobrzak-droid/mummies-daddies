import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createHash } from 'node:crypto'
import { renderToStaticMarkup } from 'react-dom/server'
import { MemoryDb } from './helpers/memoryDb'

// Bezpečnostní revize S1: OAuth klient smí mít redirect_uri jen na známé
// hosty (claude.ai, claude.com, env OAUTH_REDIRECT_HOSTS) a loopback. Souhlasná
// obrazovka předvybírá zápis jen pro výchozí host Claude. Na konci celý tok
// registrace -> souhlas -> token -> refresh, aby omezení nerozbilo Claude.

let db: MemoryDb
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => db.client }))
vi.mock('@/lib/supabase/server', () => ({ createClient: async () => db.client }))
class RedirectError extends Error { constructor(public url: string) { super(`redirect:${url}`) } }
vi.mock('next/navigation', () => ({ redirect: vi.fn((url: string) => { throw new RedirectError(url) }) }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/lib/auth/requireUser', () => ({
  tryRequireUser: vi.fn(async () => ({ id: 'user-1' })),
  AUTH_ERROR_MESSAGE: 'auth',
}))
let member: { full_name: string; is_admin: boolean; role: string } | null
vi.mock('@/lib/queries/currentMember', async (orig) => ({
  ...(await orig<typeof import('@/lib/queries/currentMember')>()),
  getCurrentMember: vi.fn(async () => ({ user: member ? { id: 'user-1' } : null, member })),
}))
vi.mock('@/components/SubmitButton', () => ({ SubmitButton: () => null }))

import { isAllowedRedirectUri, isDefaultClaudeRedirect, extraRedirectHosts, allowedRedirectHosts } from '@/lib/oauth'
import { POST as register } from '@/app/api/oauth/register/route'
import { POST as token } from '@/app/api/oauth/token/route'
import { approveOAuth } from '@/lib/actions/oauth'
import AuthorizePage from '@/app/api/oauth/authorize/page'

afterEach(() => vi.unstubAllEnvs())

describe('isAllowedRedirectUri: allowlist hostů', () => {
  it.each([
    'https://claude.ai/api/mcp/auth_callback',
    'https://claude.com/api/mcp/auth_callback',
    'https://CLAUDE.AI/cb',
    'http://localhost:6274/callback',
    'http://127.0.0.1:33418/cb',
    'http://[::1]:5000/cb',
  ])('povolí %s', (u) => expect(isAllowedRedirectUri(u)).toBe(true))

  it.each([
    'https://evil.example.com/cb',
    'https://claude.ai.evil.com/cb',
    'https://evilclaude.ai/cb',
    'https://claude.ai@evil.com/cb',
    'https://user:pw@claude.ai/cb',
    'http://claude.ai/cb',
    'http://localhost.evil.com/cb',
    'https://claude.ai/cb#x',
    'javascript:alert(1)',
    'myapp://cb',
  ])('odmítne %s', (u) => expect(isAllowedRedirectUri(u)).toBe(false))

  it('OAUTH_REDIRECT_HOSTS přidává k výchozím a ignoruje nesmysly', () => {
    vi.stubEnv('OAUTH_REDIRECT_HOSTS', ' Cowork.Example.cz , https://x.cz, *.evil.com, a/b, ')
    expect(extraRedirectHosts()).toEqual(['cowork.example.cz'])
    expect(allowedRedirectHosts()).toEqual(['claude.ai', 'claude.com', 'cowork.example.cz'])
    expect(isAllowedRedirectUri('https://cowork.example.cz/cb')).toBe(true)
    expect(isAllowedRedirectUri('https://claude.ai/cb')).toBe(true)
    expect(isAllowedRedirectUri('https://x.cz/cb')).toBe(false)
    expect(isAllowedRedirectUri('https://sub.cowork.example.cz/cb')).toBe(false)
  })

  it('isDefaultClaudeRedirect: jen claude.ai / claude.com přes https, ne env a ne loopback', () => {
    vi.stubEnv('OAUTH_REDIRECT_HOSTS', 'cowork.example.cz')
    expect(isDefaultClaudeRedirect('https://claude.ai/api/mcp/auth_callback')).toBe(true)
    expect(isDefaultClaudeRedirect('https://claude.com/cb')).toBe(true)
    expect(isDefaultClaudeRedirect('https://cowork.example.cz/cb')).toBe(false)
    expect(isDefaultClaudeRedirect('http://localhost:1234/cb')).toBe(false)
    expect(isDefaultClaudeRedirect('nesmysl')).toBe(false)
  })
})

const regReq = (body: unknown, ip: string) =>
  new Request('http://localhost/api/oauth/register', { method: 'POST', headers: { 'x-forwarded-for': ip }, body: JSON.stringify(body) })

describe('/api/oauth/register: cizí host', () => {
  beforeEach(() => { db = new MemoryDb() })

  it('cizí https host = 400 invalid_redirect_uri s jasnou hláškou, nic se neuloží', async () => {
    const res = await register(regReq({ client_name: 'Claude', redirect_uris: ['https://evil.example.com/cb'] }, '10.1.0.1'))
    expect(res.status).toBe(400)
    const json = await res.json()
    expect(json.error).toBe('invalid_redirect_uri')
    expect(json.error_description).toContain('claude.ai')
    expect(db.rows('oauth_client')).toHaveLength(0)
  })

  it('jedno cizí URI mezi povolenými shodí celou registraci', async () => {
    const res = await register(regReq({ redirect_uris: ['https://claude.ai/cb', 'https://evil.example.com/cb'] }, '10.1.0.2'))
    expect(res.status).toBe(400)
  })

  it.each(['https://claude.ai/api/mcp/auth_callback', 'https://claude.com/api/mcp/auth_callback', 'http://localhost:8123/callback', 'http://127.0.0.1:8123/callback'])(
    'povolený %s projde', async (uri) => {
      const res = await register(regReq({ client_name: 'Claude Code', redirect_uris: [uri] }, '10.1.0.3'))
      expect(res.status).toBe(201)
      expect(db.rows('oauth_client')).toHaveLength(1)
    },
  )

  it('host z env projde po přidání', async () => {
    vi.stubEnv('OAUTH_REDIRECT_HOSTS', 'cowork.example.cz')
    const res = await register(regReq({ client_name: 'Cowork', redirect_uris: ['https://cowork.example.cz/cb'] }, '10.1.0.4'))
    expect(res.status).toBe(201)
  })
})

describe('souhlasná obrazovka', () => {
  beforeEach(() => {
    db = new MemoryDb()
    member = { full_name: 'Viktor', is_admin: true, role: 'vedeni' }
  })
  const seedClient = (redirect: string, name = 'Podezřelý Klient') =>
    db.seed('oauth_client', [{ client_id: 'c1', client_name: name, redirect_uris: [redirect] }])
  const render = async (redirect: string) => renderToStaticMarkup(await AuthorizePage({
    searchParams: Promise.resolve({
      client_id: 'c1', redirect_uri: redirect, code_challenge: 'ch', code_challenge_method: 'S256', response_type: 'code', state: 's',
    }),
  }))
  const checked = (html: string, value: string) =>
    new RegExp(`<input[^>]*name="scope"[^>]*value="${value}"[^>]*checked|<input[^>]*name="scope"[^>]*checked[^>]*value="${value}"`).test(html)

  it('host Claude: jméno klienta a host nahoře, předvybráno Čtení i zápis, bez varování', async () => {
    seedClient('https://claude.ai/api/mcp/auth_callback', 'Claude')
    const html = await render('https://claude.ai/api/mcp/auth_callback')
    expect(html).toContain('Claude')
    expect(html).toContain('claude.ai')
    expect(checked(html, 'full')).toBe(true)
    expect(checked(html, 'read')).toBe(false)
    expect(html).not.toContain('role="alert"')
  })

  it('loopback (Claude Code): předvybráno jen čtení a varování', async () => {
    seedClient('http://localhost:8123/callback', 'Claude Code')
    const html = await render('http://localhost:8123/callback')
    expect(checked(html, 'read')).toBe(true)
    expect(checked(html, 'full')).toBe(false)
    expect(html).toContain('role="alert"')
  })

  it('host z env: jen čtení předvybráno, host i jméno zobrazeny', async () => {
    vi.stubEnv('OAUTH_REDIRECT_HOSTS', 'cowork.example.cz')
    seedClient('https://cowork.example.cz/cb', 'Cowork')
    const html = await render('https://cowork.example.cz/cb')
    expect(html).toContain('cowork.example.cz')
    expect(html).toContain('Cowork')
    expect(checked(html, 'read')).toBe(true)
    expect(checked(html, 'full')).toBe(false)
  })

  it('dřív zaregistrovaný klient s cizím hostem: přístup nelze udělit', async () => {
    seedClient('https://evil.example.com/cb')
    const html = await render('https://evil.example.com/cb')
    expect(html).toContain('Přístup nelze udělit')
    expect(html).not.toContain('name="scope"')
  })

  it('výpis popisuje, co token smí (čtení, zápis, nikdy mazat, 90 dní)', async () => {
    seedClient('https://claude.ai/cb')
    const html = await render('https://claude.ai/cb')
    expect(html).toContain('nikdy nesmí')
    expect(html).toContain('90 dní')
    expect(html).toContain('Jen čtení')
  })

  it('approveOAuth odmítne klienta s cizím hostem, i když ho má v DB', async () => {
    seedClient('https://evil.example.com/cb')
    db.seed('team_member', [{ id: 'user-1', is_admin: true, role: 'vedeni' }])
    const fd = new FormData()
    fd.set('client_id', 'c1'); fd.set('redirect_uri', 'https://evil.example.com/cb'); fd.set('code_challenge', 'ch'); fd.set('scope', 'full')
    await expect(approveOAuth(fd)).rejects.toThrow('Adresa pro návrat není povolená.')
    expect(db.rows('oauth_code')).toHaveLength(0)
  })
})

describe('celý tok pro Claude: registrace -> souhlas -> token -> refresh', () => {
  const VERIFIER = 'verifier-verifier-verifier-verifier-verifier-123'
  const CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url')
  const REDIRECT = 'https://claude.ai/api/mcp/auth_callback'

  beforeEach(() => {
    db = new MemoryDb({ defaults: { api_key: () => ({ created_at: new Date().toISOString() }) } })
    db.seed('team_member', [{ id: 'user-1', role: 'vedeni', is_admin: true, deactivated_at: null }])
  })

  it('funguje s výchozím seznamem', async () => {
    const reg = await register(regReq({ client_name: 'Claude', redirect_uris: [REDIRECT] }, '10.2.0.1'))
    expect(reg.status).toBe(201)
    const { client_id } = await reg.json()

    const fd = new FormData()
    fd.set('client_id', client_id); fd.set('redirect_uri', REDIRECT); fd.set('code_challenge', CHALLENGE)
    fd.set('state', 'st'); fd.set('scope', 'full')
    const err = await approveOAuth(fd).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(RedirectError)
    const target = new URL((err as RedirectError).url)
    expect(target.origin + target.pathname).toBe(REDIRECT)
    expect(target.searchParams.get('state')).toBe('st')
    const code = target.searchParams.get('code')!

    const tokRes = await token(new Request('http://localhost/api/oauth/token', {
      method: 'POST',
      body: new URLSearchParams({ grant_type: 'authorization_code', code, client_id, redirect_uri: REDIRECT, code_verifier: VERIFIER }),
    }))
    expect(tokRes.status).toBe(200)
    const tokens = await tokRes.json()
    expect(tokens.scope).toBe('read write')
    expect(tokens.refresh_token).toMatch(/^cockpit_rt_/)

    const refRes = await token(new Request('http://localhost/api/oauth/token', {
      method: 'POST',
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id }),
    }))
    expect(refRes.status).toBe(200)
    const refreshed = await refRes.json()
    expect(refreshed.access_token).toMatch(/^cockpit_/)
    expect(refreshed.access_token).not.toBe(tokens.access_token)
  })
})
