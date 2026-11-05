import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAdminClient } from '@/lib/supabase/admin'
import { runAresEnrichment } from '@/domain/crm/aresEnrich'
import { runIdokladLive } from '@/domain/finance/idokladLive'
import { GET } from '@/app/api/cron/ares-enrich/route'

// Denní cron ares-enrich nese i čtení z iDokladu: vlastní přepínač, vlastní
// zámek, nezávislé selhání. Supabase, ARES i iDoklad jsou podvržené.

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/domain/crm/aresEnrich', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/domain/crm/aresEnrich')>()),
  runAresEnrichment: vi.fn(async () => ({ processed: 2, assigned: 1 })),
  supabaseAresEnrichDb: vi.fn(() => ({})),
}))
vi.mock('@/domain/finance/idokladLive', () => ({ runIdokladLive: vi.fn(async () => ({ invoicesRead: 3, recordsCreated: 1 })) }))

const req = (auth?: string) => new Request('https://x/api/cron/ares-enrich', { headers: auth ? { authorization: auth } : {} })

function admin(locks: Record<string, number | null> = {}) {
  const rpc = vi.fn(async (name: string, args?: { job_name?: string }) =>
    name === 'try_acquire_job_lock' ? { data: args?.job_name && args.job_name in locks ? locks[args.job_name] : 7, error: null } : { data: null, error: null })
  vi.mocked(createAdminClient).mockReturnValue({ rpc, from: vi.fn() } as never)
  return rpc
}

beforeEach(() => { vi.clearAllMocks(); vi.stubEnv('CRON_SECRET', 's3cret') })
afterEach(() => vi.unstubAllEnvs())

describe('cron ares-enrich + iDoklad', () => {
  it('bez obou přepínačů 404 a nic se nespustí (iDoklad je výchozí VYPNUTO)', async () => {
    vi.stubEnv('IDOKLAD_SYNC_ENABLED', '1')
    const res = await GET(req('Bearer s3cret'))
    expect(res.status).toBe(404)
    expect(createAdminClient).not.toHaveBeenCalled()
    expect(runIdokladLive).not.toHaveBeenCalled()
  })

  it('jen iDoklad zapnutý: ARES se nespustí, iDoklad běží pod zámkem idoklad-sync', async () => {
    vi.stubEnv('IDOKLAD_SYNC_ENABLED', 'true')
    const rpc = admin()
    const res = await GET(req('Bearer s3cret'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      status: 'disabled',
      idoklad: { status: 'succeeded', runId: 7, stats: { invoicesRead: 3, recordsCreated: 1 } },
    })
    expect(runAresEnrichment).not.toHaveBeenCalled()
    expect(rpc).toHaveBeenCalledWith('try_acquire_job_lock', { job_name: 'idoklad-sync', ttl_seconds: 120 })
    expect(rpc).toHaveBeenCalledWith('finish_job_run', expect.objectContaining({ run_id: 7, status: 'succeeded' }))
  })

  it('zapnutá route bez správného Bearer vrací 401 a iDoklad se nespustí', async () => {
    vi.stubEnv('IDOKLAD_SYNC_ENABLED', 'true')
    expect((await GET(req('Bearer spatne'))).status).toBe(401)
    expect(runIdokladLive).not.toHaveBeenCalled()
  })

  it('oba zapnuté: běží obě úlohy, každá pod svým zámkem', async () => {
    vi.stubEnv('IDOKLAD_SYNC_ENABLED', 'true')
    vi.stubEnv('ARES_ENRICH_ENABLED', 'true')
    const rpc = admin()
    const body = await (await GET(req('Bearer s3cret'))).json()
    expect(body.status).toBe('succeeded')
    expect(body.idoklad.status).toBe('succeeded')
    const jobs = rpc.mock.calls.filter((c) => c[0] === 'try_acquire_job_lock').map((c) => (c[1] as { job_name: string }).job_name)
    expect(jobs).toEqual(['idoklad-sync', 'ares-enrich'])
  })

  it('rozpočet ARESu: sám má celý (beze změny volání), po iDokladu zbytek, nejméně 10 s', async () => {
    vi.stubEnv('ARES_ENRICH_ENABLED', 'true')
    admin()
    await GET(req('Bearer s3cret'))
    expect(vi.mocked(runAresEnrichment).mock.calls[0][2]).toBeUndefined()

    vi.stubEnv('IDOKLAD_SYNC_ENABLED', 'true')
    vi.mocked(runIdokladLive).mockImplementationOnce(async () => {
      vi.setSystemTime(Date.now() + 47_000) // iDoklad „trval“ 47 s
      return {} as never
    })
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      await GET(req('Bearer s3cret'))
    } finally {
      vi.useRealTimers()
    }
    expect(vi.mocked(runAresEnrichment).mock.calls[1][2]).toEqual({ budgetMs: 10_000 })
  })

  it('selhání iDokladu nezastaví ARES a route hlásí 500; chyba nese jen krátkou českou větu', async () => {
    vi.stubEnv('IDOKLAD_SYNC_ENABLED', 'true')
    vi.stubEnv('ARES_ENRICH_ENABLED', 'true')
    vi.mocked(runIdokladLive).mockRejectedValueOnce(new Error('Chybí IDOKLAD_CLIENT_ID nebo IDOKLAD_CLIENT_SECRET (Vercel → Environment Variables).'))
    const rpc = admin()
    const res = await GET(req('Bearer s3cret'))
    const body = await res.json()
    expect(res.status).toBe(500)
    expect(body.status).toBe('succeeded')
    expect(body.idoklad.status).toBe('failed')
    expect(rpc).toHaveBeenCalledWith('finish_job_run', expect.objectContaining({ status: 'failed', error: expect.stringContaining('IDOKLAD_CLIENT_ID') }))
    expect(runAresEnrichment).toHaveBeenCalledTimes(1)
  })

  it('zámek drží jiný běh: iDoklad přeskočí, nic nedělá', async () => {
    vi.stubEnv('IDOKLAD_SYNC_ENABLED', 'true')
    admin({ 'idoklad-sync': null })
    const body = await (await GET(req('Bearer s3cret'))).json()
    expect(body.idoklad).toEqual({ status: 'skipped' })
    expect(runIdokladLive).not.toHaveBeenCalled()
  })
})
