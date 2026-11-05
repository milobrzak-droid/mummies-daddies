// @vitest-environment node
// /api/cron/agent-outbox: bez AGENT_OUTBOX_ENABLED 404 (nic neběží), bez
// správného Bearer CRON_SECRET 401, jinak runJob pod zámkem 'agent-outbox'.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const runLive = vi.fn(async () => ({ status: 'ran', sent: 0 }))

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn(() => ({ rpc: vi.fn() })) }))
vi.mock('@/worker', () => ({
  runJob: vi.fn(async (_db: unknown, name: string, _ttl: number, fn: () => Promise<Record<string, unknown>>) => {
    try {
      return { status: 'succeeded', runId: 1, name, stats: await fn() }
    } catch (e) {
      return { status: 'failed', runId: 1, error: e instanceof Error ? e.message : String(e) }
    }
  }),
}))
vi.mock('@/domain/crm/agentOutboxService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/domain/crm/agentOutboxService')>()),
  runAgentOutboxLive: runLive,
}))

const SECRET = 's3cret'
const call = async (auth: string | null = `Bearer ${SECRET}`) => {
  const { GET } = await import('@/app/api/cron/agent-outbox/route')
  return GET(new Request('https://x/api/cron/agent-outbox', { headers: auth ? { authorization: auth } : {} }))
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('CRON_SECRET', SECRET)
  vi.stubEnv('AGENT_OUTBOX_ENABLED', 'true')
})
afterEach(() => vi.unstubAllEnvs())

describe('/api/cron/agent-outbox', () => {
  it('bez přepínače 404 a nic neběží', async () => {
    vi.stubEnv('AGENT_OUTBOX_ENABLED', '')
    const res = await call()
    expect(res.status).toBe(404)
    expect(runLive).not.toHaveBeenCalled()
  })

  it('špatný nebo chybějící Bearer → 401', async () => {
    expect((await call('Bearer jiny')).status).toBe(401)
    expect((await call(null)).status).toBe(401)
    vi.stubEnv('CRON_SECRET', '')
    expect((await call()).status).toBe(401)
    expect(runLive).not.toHaveBeenCalled()
  })

  it('autorizovaný běh pod zámkem agent-outbox', async () => {
    const res = await call()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toMatchObject({ status: 'succeeded', name: 'agent-outbox', stats: { status: 'ran' } })
    expect(runLive).toHaveBeenCalledTimes(1)
  })

  it('selhání běhu → 500', async () => {
    runLive.mockRejectedValueOnce(new Error('boom'))
    expect((await call()).status).toBe(500)
  })

  it('maxDuration 300 s', async () => {
    const mod = await import('@/app/api/cron/agent-outbox/route')
    expect(mod.maxDuration).toBe(300)
  })
})
