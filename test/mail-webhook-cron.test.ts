// @vitest-environment node
// /api/cron/outlook-mail + webhook: s oběma přepínači cron před syncem
// udržuje předplatná (obnova do 36 h, založení chybějících), bez webhookového
// přepínače je uklidí. Údržba sync nikdy neshodí.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runMailSync } from '@/domain/crm/mailSync'
import { retireMailSubscriptions } from '@/domain/crm/mailWebhookRun'
import { maintainSubscriptionsSafely } from '@/domain/crm/mailSyncService'

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn(() => ({})) }))
vi.mock('@/worker', () => ({
  runJob: vi.fn(async (_db: unknown, _name: string, _ttl: number, fn: () => Promise<Record<string, unknown>>) => {
    try {
      return { status: 'succeeded', runId: 1, stats: await fn() }
    } catch (e) {
      return { status: 'failed', runId: 1, error: e instanceof Error ? e.message : String(e) }
    }
  }),
}))
vi.mock('@/core/connectorState', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/core/connectorState')>()),
  recordConnectorError: vi.fn(async () => {}),
}))
vi.mock('@/domain/crm/mailSync', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/domain/crm/mailSync')>()),
  resolveAccessToken: vi.fn(async () => 'access-token'),
  runMailSync: vi.fn(async () => ({
    pages: 0,
    folders: {
      inbox: { outcome: 'ok', pages: 0, inserted: 0 },
      sent: { outcome: 'ok', pages: 0, inserted: 0 },
    },
    missingScope: false,
    purged: 0,
  })),
}))
vi.mock('@/domain/crm/mailSyncService', () => ({
  createJobDb: vi.fn(() => ({ tryAcquireJobLock: async () => 1, finishJobRun: async () => {} })),
  createMailSyncDb: vi.fn(() => ({})),
  createMailTokenDeps: vi.fn(() => ({})),
  createSubscriptionGraph: vi.fn(() => ({})),
  createSubscriptionStore: vi.fn(() => ({})),
  maintainSubscriptionsSafely: vi.fn(async () => ({ migrationMissing: false, folders: { inbox: { action: 'renew', outcome: 'renewed' } } })),
}))
vi.mock('@/domain/crm/mailWebhookRun', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/domain/crm/mailWebhookRun')>()),
  retireMailSubscriptions: vi.fn(async () => ({ removed: 1, failed: 0, migrationMissing: false })),
}))

const SECRET = 's3cret'
const call = async () => {
  const { GET } = await import('@/app/api/cron/outlook-mail/route')
  return GET(new Request('https://x/api/cron/outlook-mail', { headers: { authorization: `Bearer ${SECRET}` } }))
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('CRON_SECRET', SECRET)
  vi.stubEnv('OUTLOOK_MAIL_SYNC_ENABLED', 'true')
  vi.stubEnv('OUTLOOK_MAIL_SYNC_MEMBER_ID', 'f6d18417-48ac-423b-b459-d09ee5a5103f')
  vi.stubEnv('APP_URL', 'https://cockpit.example.cz')
})
afterEach(() => vi.unstubAllEnvs())

describe('/api/cron/outlook-mail — webhook', () => {
  it('s OUTLOOK_MAIL_WEBHOOK_ENABLED=true udržuje předplatná před syncem', async () => {
    vi.stubEnv('OUTLOOK_MAIL_WEBHOOK_ENABLED', 'true')
    const res = await call()
    expect(res.status).toBe(200)
    expect(maintainSubscriptionsSafely).toHaveBeenCalledTimes(1)
    const arg = vi.mocked(maintainSubscriptionsSafely).mock.calls[0][0]
    expect(arg.secret).toBe(SECRET)
    expect(arg.notificationUrl).toEqual({ ok: true, url: 'https://cockpit.example.cz/api/ms/notifications' })
    expect(retireMailSubscriptions).not.toHaveBeenCalled()
    // Údržba proběhla dřív než sync.
    expect(vi.mocked(maintainSubscriptionsSafely).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(runMailSync).mock.invocationCallOrder[0])
    const body = await res.json()
    expect(body.stats.webhook.folders.inbox.outcome).toBe('renewed')
  })

  it('bez webhookového přepínače předplatná uklidí a sync běží dál', async () => {
    const res = await call()
    expect(res.status).toBe(200)
    expect(maintainSubscriptionsSafely).not.toHaveBeenCalled()
    expect(retireMailSubscriptions).toHaveBeenCalledTimes(1)
    expect(runMailSync).toHaveBeenCalledTimes(1)
    expect((await res.json()).stats.webhook).toMatchObject({ disabled: true, removed: 1 })
  })

  it('selhání úklidu sync neshodí', async () => {
    vi.mocked(retireMailSubscriptions).mockRejectedValueOnce(new Error('graph down'))
    const res = await call()
    expect(res.status).toBe(200)
    expect(runMailSync).toHaveBeenCalledTimes(1)
    expect((await res.json()).stats.webhook).toMatchObject({ disabled: true, error: 'graph down' })
  })

  it('sync dostane zbytek rozpočtu (aspoň 25 s)', async () => {
    vi.stubEnv('OUTLOOK_MAIL_WEBHOOK_ENABLED', 'true')
    await call()
    const opts = vi.mocked(runMailSync).mock.calls[0][1]
    expect(opts?.budgetMs).toBeGreaterThanOrEqual(25_000)
    expect(opts?.budgetMs).toBeLessThanOrEqual(50_000)
  })

  it('bez OUTLOOK_MAIL_SYNC_ENABLED 404 i s webhookovým přepínačem', async () => {
    vi.stubEnv('OUTLOOK_MAIL_SYNC_ENABLED', '')
    vi.stubEnv('OUTLOOK_MAIL_WEBHOOK_ENABLED', 'true')
    expect((await call()).status).toBe(404)
    expect(maintainSubscriptionsSafely).not.toHaveBeenCalled()
  })
})
