// /api/cron/follow-ups: denní kontrola dokumentů dodávek v SharePointu (0094)
// běží ve stejném denním cronu (nový cron nepřidáváme — Vercel Hobby), je
// VÝCHOZÍ VYPNUTÁ, má vlastní zámek a její chyba hlídač nezastaví.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const state = vi.hoisted(() => ({ order: [] as string[], locks: [] as string[], docsFail: false }))

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
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/core/connectorState', () => ({ recordConnectorError: vi.fn(), recordConnectorSuccess: vi.fn() }))
vi.mock('@/domain/crm/meetingCalendarService', () => ({
  runMeetingCalendarSyncLive: vi.fn(async () => {
    state.order.push('calendar')
    return { checked: 0 }
  }),
}))
vi.mock('@/domain/delivery/documentSyncService', () => ({
  runDocumentSyncLive: vi.fn(async () => {
    state.order.push('documents')
    if (state.docsFail) throw new Error('Graph nedostupný')
    return { state: 'ok', docs: 3, opened: 1 }
  }),
}))
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

import { GET } from '@/app/api/cron/follow-ups/route'
import { runDocumentSyncLive } from '@/domain/delivery/documentSyncService'

const request = () => new Request('https://x/api/cron/follow-ups', { headers: { authorization: 'Bearer s3cret' } })

beforeEach(() => {
  state.order = []
  state.locks = []
  state.docsFail = false
  vi.clearAllMocks()
  vi.stubEnv('CRON_SECRET', 's3cret')
  vi.stubEnv('FOLLOWUP_WATCH_ENABLED', 'true')
})
afterEach(() => vi.unstubAllEnvs())

describe('/api/cron/follow-ups + kontrola dokumentů', () => {
  test('výchozí je vypnuto: nic se nespustí, žádný zámek, odpověď říká „disabled"', async () => {
    const res = await GET(request())
    expect(res.status).toBe(200)
    expect(state.order).toEqual(['calendar', 'watch'])
    expect(state.locks).not.toContain('sharepoint-doc-sync')
    expect(runDocumentSyncLive).not.toHaveBeenCalled()
    expect((await res.json() as { documents: unknown }).documents).toEqual({ status: 'disabled' })
  })

  test('jen přesně „true" ji zapne', async () => {
    for (const v of ['1', 'TRUE', 'yes', '']) {
      vi.stubEnv('SHAREPOINT_DOC_SYNC_ENABLED', v)
      await GET(request())
    }
    expect(runDocumentSyncLive).not.toHaveBeenCalled()
  })

  test('zapnuto: běží po kalendáři a před hlídačem, pod vlastním zámkem, s rozpočtem', async () => {
    vi.stubEnv('SHAREPOINT_DOC_SYNC_ENABLED', 'true')
    const res = await GET(request())
    expect(res.status).toBe(200)
    expect(state.order).toEqual(['calendar', 'documents', 'watch'])
    expect(state.locks).toEqual(['calendar-sync', 'sharepoint-doc-sync', 'approval-expiry'])
    expect(runDocumentSyncLive).toHaveBeenCalledWith({ budgetMs: 15_000 })
    expect((await res.json() as { documents: { status: string; stats: unknown } }).documents).toMatchObject({ status: 'succeeded', stats: { docs: 3, opened: 1 } })
  })

  test('chyba kontroly dokumentů hlídač nezastaví a odpověď zůstane 200', async () => {
    vi.stubEnv('SHAREPOINT_DOC_SYNC_ENABLED', 'true')
    state.docsFail = true
    const res = await GET(request())
    expect(res.status).toBe(200)
    expect(state.order).toEqual(['calendar', 'documents', 'watch'])
    expect((await res.json() as { documents: { status: string } }).documents.status).toBe('failed')
  })

  test('bez FOLLOWUP_WATCH_ENABLED route dál vrací 404 i se zapnutou kontrolou dokumentů', async () => {
    vi.stubEnv('FOLLOWUP_WATCH_ENABLED', '')
    vi.stubEnv('SHAREPOINT_DOC_SYNC_ENABLED', 'true')
    expect((await GET(request())).status).toBe(404)
    expect(runDocumentSyncLive).not.toHaveBeenCalled()
  })
})
