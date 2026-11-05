// Routy outbound agenta (P7): /api/cron/outbound-agent (přepínač, CRON_SECRET,
// zámek) a /api/web/odhlaseni (podepsaný token, One-Click POST). Supabase
// i běh agenta jsou podvržené — žádná DB, žádná síť.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAdminClient } from '@/lib/supabase/admin'
import { runOutboundAgent } from '@/domain/outbound/run'
import { GET as cronGET } from '@/app/api/cron/outbound-agent/route'
import { GET as unsubGET, POST as unsubPOST } from '@/app/api/web/odhlaseni/route'
import { emailHash, unsubscribeToken } from '@/core/outbound/unsubscribe'

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/domain/outbound/run', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/domain/outbound/run')>()),
  runOutboundAgent: vi.fn(async () => ({ new: 1, leads: 1, queued: 0 })),
}))

const SECRET = 'u'.repeat(40)
const cronReq = (auth?: string) => new Request('https://x/api/cron/outbound-agent', { headers: auth ? { authorization: auth } : {} })

function admin(lock: number | null = 7, rpcError: { code: string } | null = null) {
  const rpc = vi.fn(async (name: string) => {
    if (name === 'try_acquire_job_lock') return { data: lock, error: null }
    if (name === 'outbound_unsubscribe') return { data: rpcError ? null : { suppressed: true, contacts: 1 }, error: rpcError }
    return { data: null, error: null }
  })
  vi.mocked(createAdminClient).mockReturnValue({ rpc, from: vi.fn() } as never)
  return rpc
}

beforeEach(() => vi.clearAllMocks())
afterEach(() => vi.unstubAllEnvs())

describe('vercel.json', () => {
  it('outbound-agent má cron ve všední dny', () => {
    const config = JSON.parse(readFileSync(join(__dirname, '..', 'vercel.json'), 'utf8')) as { crons: { path: string; schedule: string }[] }
    const c = config.crons.find((x) => x.path === '/api/cron/outbound-agent')
    expect(c?.schedule).toMatch(/1-5$/)
  })
})

describe('/api/cron/outbound-agent', () => {
  it('bez OUTBOUND_AGENT_ENABLED=true vrací 404 a nic nevolá', async () => {
    vi.stubEnv('CRON_SECRET', 'tajne')
    const rpc = admin()
    const res = await cronGET(cronReq('Bearer tajne'))
    expect(res.status).toBe(404)
    expect(rpc).not.toHaveBeenCalled()
    expect(runOutboundAgent).not.toHaveBeenCalled()
  })

  it('se špatným tajemstvím 401', async () => {
    vi.stubEnv('OUTBOUND_AGENT_ENABLED', 'true')
    vi.stubEnv('CRON_SECRET', 'tajne')
    admin()
    expect((await cronGET(cronReq('Bearer jine'))).status).toBe(401)
    expect((await cronGET(cronReq())).status).toBe(401)
  })

  it('zapnuto: běh pod zámkem, samostatné odeslání jen s druhým přepínačem', async () => {
    vi.stubEnv('OUTBOUND_AGENT_ENABLED', 'true')
    vi.stubEnv('CRON_SECRET', 'tajne')
    vi.stubEnv('OUTBOUND_UNSUBSCRIBE_SECRET', SECRET)
    const rpc = admin()
    const res = await cronGET(cronReq('Bearer tajne'))
    expect(res.status).toBe(200)
    expect(rpc).toHaveBeenCalledWith('try_acquire_job_lock', { job_name: 'outbound-agent', ttl_seconds: 290 })
    expect(vi.mocked(runOutboundAgent).mock.calls[0][2]).toMatchObject({ autosendEnabled: false, unsubscribeSecret: SECRET })
    vi.stubEnv('OUTBOUND_AUTOSEND_ENABLED', 'true')
    await cronGET(cronReq('Bearer tajne'))
    expect(vi.mocked(runOutboundAgent).mock.calls[1][2]).toMatchObject({ autosendEnabled: true })
  })

  it('zámek drží jiný běh → skipped bez běhu', async () => {
    vi.stubEnv('OUTBOUND_AGENT_ENABLED', 'true')
    vi.stubEnv('CRON_SECRET', 'tajne')
    admin(null)
    const res = await cronGET(cronReq('Bearer tajne'))
    expect(res.status).toBe(200)
    expect(runOutboundAgent).not.toHaveBeenCalled()
  })
})

describe('/api/web/odhlaseni', () => {
  const hash = emailHash('karel@alfa.cz')
  const url = (t: string) => `https://web.example/api/web/odhlaseni?t=${encodeURIComponent(t)}`

  it('bez tajemství 404', async () => {
    expect((await unsubGET(new Request(url('x')))).status).toBe(404)
    expect((await unsubPOST(new Request(url('x'), { method: 'POST' }))).status).toBe(404)
  })

  it('GET s platným tokenem ukáže potvrzení a nic nezapíše (prefetch odkazu)', async () => {
    vi.stubEnv('OUTBOUND_UNSUBSCRIBE_SECRET', SECRET)
    const rpc = admin()
    const t = unsubscribeToken({ emailHash: hash, outreachId: 3 }, SECRET)
    const res = await unsubGET(new Request(url(t)))
    expect(res.status).toBe(200)
    const html = await res.text()
    expect(html).toContain('<form method="post"')
    expect(html).not.toContain('karel')
    expect(rpc).not.toHaveBeenCalled()
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('POST (i One-Click z poštovního klienta) zapíše odhlášení otiskem', async () => {
    vi.stubEnv('OUTBOUND_UNSUBSCRIBE_SECRET', SECRET)
    const rpc = admin()
    const t = unsubscribeToken({ emailHash: hash, outreachId: 3 }, SECRET)
    const res = await unsubPOST(new Request(url(t), { method: 'POST', body: 'List-Unsubscribe=One-Click' }))
    expect(res.status).toBe(200)
    expect(rpc).toHaveBeenCalledWith('outbound_unsubscribe', { p: { email_hash: hash, outreach_id: 3, source: 'unsubscribe_link' } })
  })

  it('podvržený token 400 bez zápisu; chyba DB 503', async () => {
    vi.stubEnv('OUTBOUND_UNSUBSCRIBE_SECRET', SECRET)
    const rpc = admin()
    const forged = unsubscribeToken({ emailHash: hash, outreachId: 3 }, 'z'.repeat(40))
    expect((await unsubPOST(new Request(url(forged), { method: 'POST' }))).status).toBe(400)
    expect((await unsubGET(new Request(url(forged)))).status).toBe(400)
    expect(rpc).not.toHaveBeenCalled()
    admin(7, { code: '42883' })
    const t = unsubscribeToken({ emailHash: hash, outreachId: 3 }, SECRET)
    expect((await unsubPOST(new Request(url(t), { method: 'POST' }))).status).toBe(503)
  })
})
