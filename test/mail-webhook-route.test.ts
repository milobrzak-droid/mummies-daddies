// @vitest-environment node
// POST /api/ms/notifications — přepínače, handshake, clientState a to, že
// sync běží až po odpovědi (after). Proxy pouští bez session jen tuhle cestu.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NextRequest } from 'next/server'
import { webhookClientState } from '@/domain/crm/mailWebhook'
import { processNotificationWork } from '@/domain/crm/mailWebhookRun'

const scheduled: (() => Promise<void> | void)[] = []

vi.mock('next/server', async (importOriginal) => ({
  ...(await importOriginal<typeof import('next/server')>()),
  after: vi.fn((fn: () => Promise<void> | void) => { scheduled.push(fn) }),
}))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn(() => ({})) }))
vi.mock('@/domain/crm/mailSyncService', () => ({
  createJobDb: vi.fn(() => ({})),
  createNotificationWorkDeps: vi.fn(() => ({})),
}))
vi.mock('@/domain/crm/mailWebhookRun', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/domain/crm/mailWebhookRun')>()),
  processNotificationWork: vi.fn(async () => ({ status: 'succeeded', attempts: 1 })),
}))

const SECRET = 'cron-secret-123'
const SUB = '11111111-2222-3333-4444-555555555555'
const URL_ = 'https://cockpit.example.cz/api/ms/notifications'

function enable() {
  vi.stubEnv('OUTLOOK_MAIL_SYNC_ENABLED', 'true')
  vi.stubEnv('OUTLOOK_MAIL_WEBHOOK_ENABLED', 'true')
  vi.stubEnv('CRON_SECRET', SECRET)
  vi.stubEnv('OUTLOOK_MAIL_SYNC_MEMBER_ID', 'f6d18417-48ac-423b-b459-d09ee5a5103f')
  vi.stubEnv('APP_URL', 'https://cockpit.example.cz')
}

const post = (body: unknown, query = '', headers: Record<string, string> = {}) =>
  new Request(`${URL_}${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })

const notification = (clientState: string) => ({
  value: [{
    subscriptionId: SUB,
    clientState,
    changeType: 'created',
    resource: 'Users/x/Messages/y',
    resourceData: { id: 'AAMkAG=' },
  }],
})

async function route() {
  return (await import('@/app/api/ms/notifications/route')).POST
}

beforeEach(() => { scheduled.length = 0; vi.clearAllMocks() })
afterEach(() => vi.unstubAllEnvs())

describe('/api/ms/notifications — přepínače', () => {
  it('bez přepínačů 404 (ani handshake)', async () => {
    vi.stubEnv('CRON_SECRET', SECRET)
    const POST = await route()
    expect((await POST(post({}, '?validationToken=abc'))).status).toBe(404)
  })

  it('sync zapnutý, webhook ne → 404', async () => {
    vi.stubEnv('OUTLOOK_MAIL_SYNC_ENABLED', 'true')
    vi.stubEnv('CRON_SECRET', SECRET)
    const POST = await route()
    const res = await POST(post(notification(webhookClientState(SECRET, 'inbox'))))
    expect(res.status).toBe(404)
    expect(scheduled).toHaveLength(0)
  })
})

describe('/api/ms/notifications — handshake a ověření', () => {
  beforeEach(enable)

  it('validationToken → 200 text/plain s URL-dekódovaným tokenem, nic se neplánuje', async () => {
    const POST = await route()
    const token = 'Validation: Testing client application reachability for subscription Request-Id: 5c8a'
    const res = await POST(post('', `?validationToken=${encodeURIComponent(token)}`))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/plain')
    expect(await res.text()).toBe(token)
    expect(scheduled).toHaveLength(0)
  })

  it('špatný clientState → 401 a nic se nespustí', async () => {
    const POST = await route()
    const res = await POST(post(notification('podvrzeny-client-state')))
    expect(res.status).toBe(401)
    expect(scheduled).toHaveLength(0)
  })

  it('platná notifikace → 202 hned, sync až po odpovědi (after) jen pro dotčenou složku', async () => {
    const POST = await route()
    const res = await POST(post(notification(webhookClientState(SECRET, 'sent'))))
    expect(res.status).toBe(202)
    expect(await res.text()).toBe('')
    expect(processNotificationWork).not.toHaveBeenCalled()
    expect(scheduled).toHaveLength(1)
    await scheduled[0]()
    expect(processNotificationWork).toHaveBeenCalledTimes(1)
    expect(vi.mocked(processNotificationWork).mock.calls[0][0]).toEqual({
      subscriptionIds: [SUB],
      syncFolders: ['sent'],
      recreateFolders: [],
      renewFolders: [],
    })
  })

  it('neplatný JSON → 400', async () => {
    const POST = await route()
    expect((await POST(post('{nope'))).status).toBe(400)
  })

  it('příliš velké tělo (Content-Length) → 413 bez čtení', async () => {
    const POST = await route()
    const res = await POST(post('{}', '', { 'Content-Length': '5000000' }))
    expect(res.status).toBe(413)
  })

  it('bez OUTLOOK_MAIL_SYNC_MEMBER_ID → 503 (Graph zkusí znovu)', async () => {
    vi.stubEnv('OUTLOOK_MAIL_SYNC_MEMBER_ID', '')
    const POST = await route()
    expect((await POST(post(notification(webhookClientState(SECRET, 'inbox'))))).status).toBe(503)
  })
})

// --- proxy (lib/supabase/middleware.ts)

const getUser = vi.fn()
vi.mock('@supabase/ssr', () => ({
  createServerClient: () => ({ auth: { getUser, mfa: { getAuthenticatorAssuranceLevel: vi.fn() } } }),
}))
vi.mock('@/lib/supabase/env', () => ({ supabaseUrl: 'http://x', supabaseAnonKey: 'k', supabaseSecretKey: 'k' }))

describe('proxy — webhook bez session', () => {
  beforeEach(() => getUser.mockResolvedValue({ data: { user: null } }))

  const req = (path: string, method = 'POST') =>
    new NextRequest(`https://crm.example.cz${path}`, { method, headers: { 'content-type': 'application/json' }, body: method === 'POST' ? '{}' : undefined })

  it('/api/ms/notifications projde bez přihlášení', async () => {
    const { updateSession } = await import('@/lib/supabase/middleware')
    const res = await updateSession(req('/api/ms/notifications'))
    expect(res.status).toBe(200)
    expect(res.headers.get('location')).toBeNull()
  })

  it('ostatní /api/ms zůstává za přihlášením', async () => {
    const { updateSession } = await import('@/lib/supabase/middleware')
    for (const path of ['/api/ms/connect', '/api/ms/callback', '/api/ms/notifications/x', '/api/ms/notificationsx']) {
      const res = await updateSession(req(path, 'GET'))
      expect(res.status, path).toBe(307)
      expect(res.headers.get('location'), path).toContain('/login')
    }
  })
})
