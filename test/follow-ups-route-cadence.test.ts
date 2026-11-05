// /api/cron/follow-ups + follow-up cadence (balík P4): bez
// FOLLOWUP_CADENCE_ENABLED běží jen dnešní úlohy (hlídač, vypršení žádostí);
// se zapnutým přepínačem i cadence, za hlídačem a pod vlastním zámkem.
// Chyba cadence hlídač nezastaví.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const state = vi.hoisted(() => ({ order: [] as string[], locks: [] as string[], cadenceThrows: false }))

vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    rpc: vi.fn(async (name: string, args: { job_name?: string }) => {
      if (name === 'try_acquire_job_lock') {
        state.locks.push(String(args.job_name))
        return { data: state.locks.length, error: null }
      }
      return { data: null, error: null }
    }),
  }),
}))
vi.mock('@/core/auditDb', () => ({ createAuditedAdminClient: vi.fn(() => ({ rpc: vi.fn(async () => ({ data: [], error: null })) })) }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/core/connectorState', () => ({ recordConnectorError: vi.fn(), recordConnectorSuccess: vi.fn() }))
vi.mock('@/domain/crm/jobHealth', () => ({ runJobHealthCheck: vi.fn(async () => ({ closed: 0, health: null })) }))
vi.mock('@/worker', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/worker')>()
  return {
    ...actual,
    createFollowUpWatchDb: vi.fn(() => ({})),
    runFollowUpWatchJob: vi.fn(async () => {
      state.order.push('watch')
      return { status: 'succeeded', runId: 99, stats: { opened: 0 } }
    }),
  }
})
vi.mock('@/domain/crm/followUpCadenceService', () => ({
  runFollowUpCadence: vi.fn(async () => {
    state.order.push('cadence')
    if (state.cadenceThrows) throw new Error('DB nedostupná')
    return { state: 'ok', enqueued: 2 }
  }),
}))

import { GET } from '@/app/api/cron/follow-ups/route'
import { runFollowUpCadence } from '@/domain/crm/followUpCadenceService'
import { COMPANY } from '@/config'

const request = () => new Request('https://x/api/cron/follow-ups', { headers: { authorization: 'Bearer s3cret' } })

beforeEach(() => {
  state.order = []
  state.locks = []
  state.cadenceThrows = false
  vi.mocked(runFollowUpCadence).mockClear()
  vi.stubEnv('CRON_SECRET', 's3cret')
  vi.stubEnv('FOLLOWUP_WATCH_ENABLED', 'true')
  vi.stubEnv('CALENDAR_SYNC_ENABLED', 'false')
})
afterEach(() => vi.unstubAllEnvs())

describe('/api/cron/follow-ups + follow-up cadence', () => {
  test('bez FOLLOWUP_CADENCE_ENABLED běží jen hlídač a vypršení žádostí', async () => {
    const res = await GET(request())
    expect(res.status).toBe(200)
    expect(state.order).toEqual(['watch'])
    expect(state.locks).toEqual(['approval-expiry'])
    expect(runFollowUpCadence).not.toHaveBeenCalled()
    expect((await res.json() as { followUpCadence: unknown }).followUpCadence).toEqual({ status: 'disabled' })
  })

  test.each(['1', 'yes', 'TRUE'])('FOLLOWUP_CADENCE_ENABLED=%s nestačí (jen přesně „true")', async (v) => {
    vi.stubEnv('FOLLOWUP_CADENCE_ENABLED', v)
    await GET(request())
    expect(runFollowUpCadence).not.toHaveBeenCalled()
  })

  test('se zapnutým přepínačem běží obě úlohy, cadence za hlídačem a pod vlastním zámkem', async () => {
    vi.stubEnv('FOLLOWUP_CADENCE_ENABLED', 'true')
    const res = await GET(request())
    expect(res.status).toBe(200)
    expect(state.order).toEqual(['watch', 'cadence'])
    expect(state.locks).toEqual(['approval-expiry', 'follow-up-send'])
    const [, , opts] = vi.mocked(runFollowUpCadence).mock.calls[0]
    expect(opts.cfg).toBe(COMPANY.capabilities.followUpCadence)
    expect(typeof opts.passed).toBe('function')
    const body = await res.json() as { status: string; followUpCadence: { status: string; stats: unknown } }
    expect(body.status).toBe('succeeded')
    expect(body.followUpCadence).toMatchObject({ status: 'succeeded', stats: { enqueued: 2 } })
  })

  test('chyba cadence hlídač nezastaví; odpověď 500 kvůli monitoringu', async () => {
    vi.stubEnv('FOLLOWUP_CADENCE_ENABLED', 'true')
    state.cadenceThrows = true
    const res = await GET(request())
    expect(state.order).toEqual(['watch', 'cadence'])
    expect(res.status).toBe(500)
    expect((await res.json() as { followUpCadence: { status: string } }).followUpCadence.status).toBe('failed')
  })

  test('bez FOLLOWUP_WATCH_ENABLED je route 404 a cadence neběží ani se zapnutým přepínačem', async () => {
    vi.stubEnv('FOLLOWUP_WATCH_ENABLED', '')
    vi.stubEnv('FOLLOWUP_CADENCE_ENABLED', 'true')
    expect((await GET(request())).status).toBe(404)
    expect(state.order).toEqual([])
  })

  test('druhý denní běh v okně odesílání ve vercel.json', async () => {
    const { readFileSync } = await import('node:fs')
    const cfg = JSON.parse(readFileSync(`${__dirname}/../vercel.json`, 'utf8')) as { crons: unknown[] }
    expect(cfg.crons).toContainEqual({ path: '/api/cron/follow-ups', schedule: '5 8 * * *' })
  })
})
