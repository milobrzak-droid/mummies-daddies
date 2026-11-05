// /api/cron/inquiry-agent (P2) — vypínač, CRON_SECRET, zámek úlohy.
// Supabase i tělo úlohy jsou podvržené: žádná DB, žádný Gmail ani model.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAdminClient } from '@/lib/supabase/admin'
import { runInquiryAgentJobBody } from '@/worker/inquiryAgent'
import { GET, maxDuration } from '@/app/api/cron/inquiry-agent/route'
import { INQUIRY_AGENT_MAX_DURATION_S } from '@/worker/inquiryAgent'

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/worker/inquiryAgent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/worker/inquiryAgent')>()),
  runInquiryAgentJobBody: vi.fn(async () => ({ mailbox: { mailboxes: 0 }, agent: { claimed: 0 }, purged: 0 })),
}))

const req = (auth?: string) => new Request('https://x/api/cron/inquiry-agent', { headers: auth ? { authorization: auth } : {} })

function adminWithLock(lock: number | null) {
  const rpc = vi.fn(async (name: string) => (name === 'try_acquire_job_lock' ? { data: lock, error: null } : { data: null, error: null }))
  vi.mocked(createAdminClient).mockReturnValue({ rpc, from: vi.fn() } as never)
  return rpc
}

beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.unstubAllEnvs())

describe('/api/cron/inquiry-agent', () => {
  it('vercel.json má cron a maxDuration sedí s workerem', () => {
    const config = JSON.parse(readFileSync(join(__dirname, '..', 'vercel.json'), 'utf8')) as { crons?: { path: string }[] }
    expect(config.crons?.map((c) => c.path)).toContain('/api/cron/inquiry-agent')
    expect(maxDuration).toBe(INQUIRY_AGENT_MAX_DURATION_S)
  })

  it('bez INQUIRY_AGENT_ENABLED=true vrací 404, i se správným CRON_SECRET', async () => {
    vi.stubEnv('CRON_SECRET', 's3cret')
    vi.stubEnv('INQUIRY_AGENT_ENABLED', '1')
    expect((await GET(req('Bearer s3cret'))).status).toBe(404)
    expect(createAdminClient).not.toHaveBeenCalled()
  })

  it('zapnutá route bez správného Bearer vrací 401; bez CRON_SECRET neprojde nikdo', async () => {
    vi.stubEnv('INQUIRY_AGENT_ENABLED', 'true')
    vi.stubEnv('CRON_SECRET', 's3cret')
    expect((await GET(req('Bearer spatne'))).status).toBe(401)
    expect((await GET(req())).status).toBe(401)
    vi.stubEnv('CRON_SECRET', '')
    expect((await GET(req('Bearer '))).status).toBe(401)
    expect(runInquiryAgentJobBody).not.toHaveBeenCalled()
  })

  it('se zámkem spustí tělo úlohy a zapíše výsledek', async () => {
    vi.stubEnv('INQUIRY_AGENT_ENABLED', 'true')
    vi.stubEnv('CRON_SECRET', 's3cret')
    const rpc = adminWithLock(42)
    const res = await GET(req('Bearer s3cret'))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: 'succeeded', runId: 42 })
    expect(runInquiryAgentJobBody).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('try_acquire_job_lock', { job_name: 'inquiry-agent', ttl_seconds: 330 })
  })

  it('bez zámku (běží jiný běh) = skipped, tělo se nespustí', async () => {
    vi.stubEnv('INQUIRY_AGENT_ENABLED', 'true')
    vi.stubEnv('CRON_SECRET', 's3cret')
    adminWithLock(null)
    expect(await (await GET(req('Bearer s3cret'))).json()).toEqual({ status: 'skipped' })
    expect(runInquiryAgentJobBody).not.toHaveBeenCalled()
  })
})
