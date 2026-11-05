// @vitest-environment node
// /api/cron/outlook-mail + pošta s obsahem: bez MAIL_CONTENT_INTAKE_ENABLED se
// složka „Cockpit" nečte vůbec (retence úryvků běží dál), se zapnutým přepínačem
// běží před metadatovým syncem a její selhání sync neshodí.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runMailSync } from '@/domain/crm/mailSync'
import { purgeMailContent, runMailContentIntakeLive } from '@/domain/crm/mailContentService'

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn(() => ({})) }))
vi.mock('@/worker', () => ({
  shortError: (e: unknown) => (e instanceof Error ? e.message : String(e)),
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
    folders: { inbox: { outcome: 'ok', pages: 0, inserted: 0 }, sent: { outcome: 'ok', pages: 0, inserted: 0 } },
    missingScope: false,
    purged: 0,
  })),
}))
vi.mock('@/domain/crm/mailSyncService', () => ({
  // Route jde přes runOutlookMailJob (worker/jobRunner, tvrdá pojistka), ne přes mock '@/worker'.
  createJobDb: vi.fn(() => ({ tryAcquireJobLock: async () => 1, finishJobRun: async () => {} })),
  createMailSyncDb: vi.fn(() => ({})),
  createMailTokenDeps: vi.fn(() => ({})),
  createSubscriptionGraph: vi.fn(() => ({})),
  createSubscriptionStore: vi.fn(() => ({})),
  maintainSubscriptionsSafely: vi.fn(async () => ({ migrationMissing: false, folders: {} })),
}))
vi.mock('@/domain/crm/mailWebhookRun', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/domain/crm/mailWebhookRun')>()),
  retireMailSubscriptions: vi.fn(async () => ({ removed: 0, failed: 0, migrationMissing: false })),
}))
vi.mock('@/domain/crm/mailContentService', () => ({
  runMailContentIntakeLive: vi.fn(async () => ({ folder: 'found', outcome: 'caught_up', pages: 1, messages: 2, proposed: 1, queued: 1 })),
  purgeMailContent: vi.fn(async () => ({ expired: 1, cleared: 2 })),
}))

const SECRET = 's3cret'
const MEMBER = 'f6d18417-48ac-423b-b459-d09ee5a5103f'
const call = async () => {
  const { GET } = await import('@/app/api/cron/outlook-mail/route')
  return GET(new Request('https://x/api/cron/outlook-mail', { headers: { authorization: `Bearer ${SECRET}` } }))
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('CRON_SECRET', SECRET)
  vi.stubEnv('OUTLOOK_MAIL_SYNC_ENABLED', 'true')
  vi.stubEnv('OUTLOOK_MAIL_SYNC_MEMBER_ID', MEMBER)
})
afterEach(() => vi.unstubAllEnvs())

describe('/api/cron/outlook-mail — pošta s obsahem', () => {
  it('bez přepínače složku vůbec nečte a stavy neobsahují mailContent; retence běží', async () => {
    const res = await call()
    expect(res.status).toBe(200)
    expect(runMailContentIntakeLive).not.toHaveBeenCalled()
    expect(runMailSync).toHaveBeenCalledTimes(1)
    const body = await res.json()
    expect(body.stats.mailContent).toBeUndefined()
    // retence uložených úryvků běží i s vypnutou funkcí
    expect(purgeMailContent).toHaveBeenCalledTimes(1)
    expect(body.stats.mailContentPurge).toEqual({ expired: 1, cleared: 2 })
  })

  it('jen přesně "true" zapíná čtení', async () => {
    vi.stubEnv('MAIL_CONTENT_INTAKE_ENABLED', '1')
    await call()
    expect(runMailContentIntakeLive).not.toHaveBeenCalled()
  })

  it('se zapnutým přepínačem běží před metadatovým syncem s tokenem, vlastníkem schránky a rozpočtem', async () => {
    vi.stubEnv('MAIL_CONTENT_INTAKE_ENABLED', 'true')
    const res = await call()
    expect(res.status).toBe(200)
    expect(runMailContentIntakeLive).toHaveBeenCalledTimes(1)
    const arg = vi.mocked(runMailContentIntakeLive).mock.calls[0][0]
    expect(arg).toMatchObject({ accessToken: 'access-token', ownerId: MEMBER })
    expect(arg.budgetMs).toBeGreaterThanOrEqual(16_000)
    expect(arg.budgetMs).toBeLessThanOrEqual(30_000)
    expect(vi.mocked(runMailContentIntakeLive).mock.invocationCallOrder[0])
      .toBeLessThan(vi.mocked(runMailSync).mock.invocationCallOrder[0])
    expect((await res.json()).stats.mailContent).toMatchObject({ outcome: 'caught_up', proposed: 1, queued: 1 })
    // sync pořád dostane aspoň 25 s
    expect(vi.mocked(runMailSync).mock.calls[0][1]?.budgetMs).toBeGreaterThanOrEqual(25_000)
  })

  it('selhání pošty s obsahem sync neshodí; do statistik jde jen krátká chyba', async () => {
    vi.stubEnv('MAIL_CONTENT_INTAKE_ENABLED', 'true')
    vi.mocked(runMailContentIntakeLive).mockRejectedValueOnce(new Error('graph down'))
    const res = await call()
    expect(res.status).toBe(200)
    expect(runMailSync).toHaveBeenCalledTimes(1)
    expect((await res.json()).stats.mailContent).toEqual({ error: 'graph down' })
  })

  it('selhání retence sync neshodí', async () => {
    vi.mocked(purgeMailContent).mockRejectedValueOnce(new Error('rpc down'))
    const res = await call()
    expect(res.status).toBe(200)
    expect((await res.json()).stats.mailContentPurge).toBeUndefined()
  })
})

describe('/api/cron/outlook-mail — okno prvního načtení', () => {
  it('bez MAIL_SYNC_INITIAL_DAYS dostane sync okno 120 dní', async () => {
    await call()
    expect(vi.mocked(runMailSync).mock.calls[0][1]).toMatchObject({ initialDays: 120 })
  })

  it('MAIL_SYNC_INITIAL_DAYS přebírá; nesmysl spadne na výchozích 120', async () => {
    vi.stubEnv('MAIL_SYNC_INITIAL_DAYS', '30')
    await call()
    expect(vi.mocked(runMailSync).mock.calls[0][1]).toMatchObject({ initialDays: 30 })
    vi.stubEnv('MAIL_SYNC_INITIAL_DAYS', 'moc')
    await call()
    expect(vi.mocked(runMailSync).mock.calls[1][1]).toMatchObject({ initialDays: 120 })
  })

  it('ruční režim: jen metadatový sync s oknem — bez údržby webhooku, pošty s obsahem a retence', async () => {
    vi.stubEnv('MAIL_CONTENT_INTAKE_ENABLED', 'true')
    const { runOutlookMailJobBody } = await import('@/worker/outlookMailSync')
    const { maintainSubscriptionsSafely } = await import('@/domain/crm/mailSyncService')
    const out = await runOutlookMailJobBody({
      admin: {} as never,
      jobDb: {} as never,
      memberId: MEMBER,
      mode: 'manual',
      logScope: 'test',
    })
    expect(runMailSync).toHaveBeenCalledTimes(1)
    expect(vi.mocked(runMailSync).mock.calls[0][1]).toMatchObject({ initialDays: 120, purge: false })
    expect(maintainSubscriptionsSafely).not.toHaveBeenCalled()
    expect(runMailContentIntakeLive).not.toHaveBeenCalled()
    expect(purgeMailContent).not.toHaveBeenCalled()
    expect(out.manual).toBe(true)
    expect(out.webhook).toBeUndefined()
  })
})
