import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const getUser = vi.fn()
const getAAL = vi.fn()
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({ auth: { getUser, mfa: { getAuthenticatorAssuranceLevel: getAAL } } }),
}))
vi.mock('@/lib/supabase/env', () => ({ supabaseUrl: 'http://x', supabaseAnonKey: 'k' }))

import { updateSession } from '@/lib/supabase/middleware'

function req(path: string, action = false) {
  return new NextRequest(`https://crm.example.cz${path}`, {
    method: action ? 'POST' : 'GET',
    headers: action ? { 'Next-Action': 'abc123' } : {},
  })
}

describe('proxy — Server Actions', () => {
  beforeEach(() => { getUser.mockReset(); getAAL.mockReset(); delete process.env.MFA_ENFORCED })

  it('nepřihlášená action na /auth/* dostane 401', async () => {
    getUser.mockResolvedValue({ data: { user: null } })
    const res = await updateSession(req('/auth/mfa', true))
    expect(res.status).toBe(401)
  })

  it('nepřihlášená action na /login projde (signIn)', async () => {
    getUser.mockResolvedValue({ data: { user: null } })
    const res = await updateSession(req('/login', true))
    expect(res.status).toBe(200)
  })

  it('AAL1 action na /login/xyz dostane 403', async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'u' } } })
    getAAL.mockResolvedValue({ data: { currentLevel: 'aal1', nextLevel: 'aal2' }, error: null })
    const res = await updateSession(req('/login/xyz', true))
    expect(res.status).toBe(403)
  })

  it('AAL1 action na /auth/mfa projde (odhlášení, výzva)', async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'u' } } })
    const res = await updateSession(req('/auth/mfa', true))
    expect(res.status).toBe(200)
  })

  it('AAL2 action projde', async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'u' } } })
    getAAL.mockResolvedValue({ data: { currentLevel: 'aal2', nextLevel: 'aal2' }, error: null })
    const res = await updateSession(req('/cockpit/klienti', true))
    expect(res.status).toBe(200)
  })

  it('výjimka z MFA kontroly = redirect na /auth/mfa (fail closed)', async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'u' } } })
    getAAL.mockRejectedValue(new Error('down'))
    const res = await updateSession(req('/cockpit/klienti'))
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toContain('/auth/mfa')
  })

  it('běžná stránka /login zůstává veřejná', async () => {
    getUser.mockResolvedValue({ data: { user: null } })
    const res = await updateSession(req('/login'))
    expect(res.status).toBe(200)
  })
})

function formPost(path: string, contentType: string) {
  return new NextRequest(`https://crm.example.cz${path}`, {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: contentType.startsWith('multipart') ? '--x--' : 'a=b',
  })
}

describe('proxy — actions bez hlavičky Next-Action (no-JS formulář)', () => {
  beforeEach(() => { getUser.mockReset(); getAAL.mockReset(); delete process.env.MFA_ENFORCED })

  it.each(['/auth/mfa', '/auth', '/loginx', '/', '/catering', '/cockpit/klienti'])('nepřihlášený multipart POST na %s dostane 401', async (path) => {
    getUser.mockResolvedValue({ data: { user: null } })
    const res = await updateSession(formPost(path, 'multipart/form-data; boundary=x'))
    expect(res.status).toBe(401)
  })

  it('nepřihlášený urlencoded POST na /auth/mfa dostane 401', async () => {
    getUser.mockResolvedValue({ data: { user: null } })
    const res = await updateSession(formPost('/auth/mfa', 'application/x-www-form-urlencoded'))
    expect(res.status).toBe(401)
  })

  it('nepřihlášený POST bez content-type na stránku dostane 401', async () => {
    getUser.mockResolvedValue({ data: { user: null } })
    const res = await updateSession(new NextRequest('https://crm.example.cz/cockpit/klienti', { method: 'POST' }))
    expect(res.status).toBe(401)
  })

  it('nepřihlášený multipart POST na /login projde (signIn)', async () => {
    getUser.mockResolvedValue({ data: { user: null } })
    const res = await updateSession(formPost('/login', 'multipart/form-data; boundary=x'))
    expect(res.status).toBe(200)
  })

  it('AAL1 multipart POST mimo /auth dostane 403', async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'u' } } })
    getAAL.mockResolvedValue({ data: { currentLevel: 'aal1', nextLevel: 'aal2' }, error: null })
    const res = await updateSession(formPost('/cockpit/nastaveni', 'multipart/form-data; boundary=x'))
    expect(res.status).toBe(403)
  })

  it('POST na /api/v1 se nebere jako action (API klíč řeší route)', async () => {
    getUser.mockResolvedValue({ data: { user: null } })
    const res = await updateSession(formPost('/api/v1/tasks', 'application/x-www-form-urlencoded'))
    expect(res.status).toBe(200)
  })
})

describe('proxy — veřejné cesty po segmentech', () => {
  beforeEach(() => { getUser.mockReset(); getAAL.mockReset(); delete process.env.MFA_ENFORCED })

  it('cron bez session projde proxy (handler si ověří CRON_SECRET)', async () => {
    getUser.mockResolvedValue({ data: { user: null } })
    const res = await updateSession(req('/api/cron/ares-enrich'))
    expect(res.status).toBe(200)
  })

  it('veřejná API webu (/api/web) projdou proxy bez session — Turnstile řeší route', async () => {
    getUser.mockResolvedValue({ data: { user: null } })
    expect((await updateSession(req('/api/web/poptavka'))).status).toBe(200)
    const post = await updateSession(formPost('/api/web/poptavka', 'application/json'))
    expect(post.status).toBe(200)
  })

  it.each(['/', '/catering', '/cheesecaky/objednavka', '/loginx', '/authx', '/cockpitx'])('veřejný web: GET %s bez přihlášení projde a session se neřeší', async (path) => {
    getUser.mockResolvedValue({ data: { user: null } })
    const res = await updateSession(req(path))
    expect(res.status).toBe(200)
    expect(getUser).not.toHaveBeenCalled()
  })

  it.each(['/cockpit', '/cockpit/clients', '/api/v1x', '/api/mcpx', '/api/cronx', '/api/webx', '/api/ingest/x'])('GET %s nepřihlášeně → /login', async (path) => {
    getUser.mockResolvedValue({ data: { user: null } })
    const res = await updateSession(req(path))
    expect(res.status).toBe(307)
    expect(new URL(res.headers.get('location')!).pathname).toBe('/login')
  })

  it.each(['/api/cron/weekly-digest', '/api/cron/outlook-mail'])('GET %s nepřihlášeně projde (cron se ověřuje sám přes CRON_SECRET)', async (path) => {
    getUser.mockResolvedValue({ data: { user: null } })
    const res = await updateSession(req(path))
    expect(res.status).toBe(200)
  })

  it('AAL1 GET na /api/oauth/authorize → /auth/mfa s next', async () => {
    getUser.mockResolvedValue({ data: { user: { id: 'u' } } })
    getAAL.mockResolvedValue({ data: { currentLevel: 'aal1', nextLevel: 'aal2' }, error: null })
    const res = await updateSession(req('/api/oauth/authorize?client_id=c'))
    const loc = new URL(res.headers.get('location')!)
    expect(loc.pathname).toBe('/auth/mfa')
    expect(loc.searchParams.get('next')).toBe('/api/oauth/authorize?client_id=c')
  })
})
