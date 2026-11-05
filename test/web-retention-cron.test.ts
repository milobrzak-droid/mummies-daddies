import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isCronAuthorized, runWebRetention, webRetentionEnabled, WEB_RETENTION_RPC } from '@/domain/web/retention'

const rpcMock = vi.fn()
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ rpc: rpcMock }) }))

afterEach(() => {
  vi.unstubAllEnvs()
  rpcMock.mockReset()
})

describe('retence údajů z webu', () => {
  it('přepínač je ve výchozím stavu vypnutý', () => {
    expect(webRetentionEnabled({})).toBe(false)
    expect(webRetentionEnabled({ WEB_RETENTION_ENABLED: '1' })).toBe(false)
    expect(webRetentionEnabled({ WEB_RETENTION_ENABLED: 'true' })).toBe(true)
  })

  it('Bearer CRON_SECRET, bez tajemství nikdy', () => {
    expect(isCronAuthorized('Bearer s', 's')).toBe(true)
    expect(isCronAuthorized('Bearer x', 's')).toBe(false)
    expect(isCronAuthorized('Bearer s', undefined)).toBe(false)
    expect(isCronAuthorized(null, 's')).toBe(false)
  })

  it('vrací jen počty, chybu jen jako kód', async () => {
    const ok = await runWebRetention(async (fn) => {
      expect(fn).toBe(WEB_RETENTION_RPC)
      return { data: { spam_deleted: 2, inquiries_anonymized: 1, orders_anonymized: 0, extra: 'x' }, error: null }
    })
    expect(ok).toEqual({ ok: true, counts: { spam_deleted: 2, inquiries_anonymized: 1, orders_anonymized: 0 } })
    const bad = await runWebRetention(async () => ({ data: null, error: { code: 'PGRST202', message: 'Could not find function' } }))
    expect(bad).toEqual({ ok: false, code: 'PGRST202' })
  })

  it('route: bez přepínače 404, bez tajemství 401, jinak počty', async () => {
    const { GET } = await import('@/app/api/cron/web-retention/route')
    const req = (auth?: string) => new Request('http://x/api/cron/web-retention', { headers: auth ? { authorization: auth } : {} })
    vi.stubEnv('CRON_SECRET', 's3cret')
    expect((await GET(req('Bearer s3cret'))).status).toBe(404)
    vi.stubEnv('WEB_RETENTION_ENABLED', 'true')
    expect((await GET(req('Bearer nope'))).status).toBe(401)
    expect(rpcMock).not.toHaveBeenCalled()
    rpcMock.mockResolvedValue({ data: { spam_deleted: 0, inquiries_anonymized: 3, orders_anonymized: 1 }, error: null })
    const res = await GET(req('Bearer s3cret'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ spam_deleted: 0, inquiries_anonymized: 3, orders_anonymized: 1 })
    expect(rpcMock).toHaveBeenCalledWith('web_intake_retention')
  })

  it('vercel.json: denní běh', () => {
    const cfg = JSON.parse(readFileSync(join(__dirname, '..', 'vercel.json'), 'utf8')) as { crons: unknown[] }
    expect(cfg.crons).toContainEqual({ path: '/api/cron/web-retention', schedule: '45 2 * * *' })
  })
})
