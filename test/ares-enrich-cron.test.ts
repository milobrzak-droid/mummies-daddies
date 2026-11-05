import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAdminClient } from '@/lib/supabase/admin'
import { runAresEnrichment, supabaseAresEnrichDb } from '@/domain/crm/aresEnrich'
import { GET } from '@/app/api/cron/ares-enrich/route'

// /api/cron/ares-enrich — vypínač, CRON_SECRET, zámek a aktér. Supabase
// i samotná dávka jsou podvržené: žádná DB, žádný ARES.

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/domain/crm/aresEnrich', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/domain/crm/aresEnrich')>()),
  runAresEnrichment: vi.fn(async () => ({ processed: 2, assigned: 1 })),
  supabaseAresEnrichDb: vi.fn(() => ({})),
}))

const req = (auth?: string) =>
  new Request('https://x/api/cron/ares-enrich', { headers: auth ? { authorization: auth } : {} })

function adminWithLock(lock: number | null) {
  const rpc = vi.fn(async (name: string) => (name === 'try_acquire_job_lock' ? { data: lock, error: null } : { data: null, error: null }))
  const admin = { rpc, from: vi.fn() }
  vi.mocked(createAdminClient).mockReturnValue(admin as never)
  return { rpc, admin }
}

beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.unstubAllEnvs())

describe('vercel.json', () => {
  it('ares-enrich běží denně ve 04:00 UTC', () => {
    const config = JSON.parse(readFileSync(join(__dirname, '..', 'vercel.json'), 'utf8')) as { crons?: unknown[] }
    expect(config.crons).toContainEqual({ path: '/api/cron/ares-enrich', schedule: '0 4 * * *' })
  })
})

describe('/api/cron/ares-enrich', () => {
  it('bez ARES_ENRICH_ENABLED=true vrací 404, i se správným CRON_SECRET', async () => {
    vi.stubEnv('CRON_SECRET', 's3cret')
    vi.stubEnv('ARES_ENRICH_ENABLED', '1')
    const res = await GET(req('Bearer s3cret'))
    expect(res.status).toBe(404)
    expect(createAdminClient).not.toHaveBeenCalled()
  })

  it('zapnutá route bez správného Bearer vrací 401', async () => {
    vi.stubEnv('CRON_SECRET', 's3cret')
    vi.stubEnv('ARES_ENRICH_ENABLED', 'true')
    expect((await GET(req('Bearer spatne'))).status).toBe(401)
    expect((await GET(req())).status).toBe(401)
    expect(runAresEnrichment).not.toHaveBeenCalled()
  })

  it('bez CRON_SECRET neprojde nikdo', async () => {
    vi.stubEnv('CRON_SECRET', '')
    vi.stubEnv('ARES_ENRICH_ENABLED', 'true')
    expect((await GET(req('Bearer '))).status).toBe(401)
  })

  it('se správným Bearer spustí dávku přes runJob jako systém job:ares-enrich', async () => {
    vi.stubEnv('CRON_SECRET', 's3cret')
    vi.stubEnv('ARES_ENRICH_ENABLED', 'true')
    const { rpc, admin } = adminWithLock(42)
    const res = await GET(req('Bearer s3cret'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ status: 'succeeded', runId: 42, stats: { processed: 2, assigned: 1 } })
    expect(rpc).toHaveBeenCalledWith('try_acquire_job_lock', { job_name: 'ares-enrich', ttl_seconds: 120 })
    expect(rpc).toHaveBeenCalledWith('finish_job_run', expect.objectContaining({ run_id: 42, status: 'succeeded' }))
    expect(runAresEnrichment).toHaveBeenCalledTimes(1)
    expect(supabaseAresEnrichDb).toHaveBeenCalledWith(admin, { type: 'system', id: 'job:ares-enrich' })
  })

  it('když zámek drží jiný běh (admin nebo druhý cron), nic nedělá', async () => {
    vi.stubEnv('CRON_SECRET', 's3cret')
    vi.stubEnv('ARES_ENRICH_ENABLED', 'true')
    adminWithLock(null)
    const res = await GET(req('Bearer s3cret'))
    expect(await res.json()).toEqual({ status: 'skipped' })
    expect(runAresEnrichment).not.toHaveBeenCalled()
  })
})
