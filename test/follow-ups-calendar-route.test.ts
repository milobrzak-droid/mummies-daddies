// /api/cron/follow-ups: kontrola naplánovaných schůzek v Outlooku běží ve
// stejném denním cronu PŘED hlídačem follow-upů (nový cron nepřidáváme —
// Vercel Hobby), má vlastní zámek a její chyba hlídač nezastaví.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const state = vi.hoisted(() => ({ order: [] as string[], locks: [] as string[], calendarFails: false }))

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
    if (state.calendarFails) throw new Error('Graph nedostupný')
    return { checked: 2, moved: 1, cancelled: 0 }
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
import { runMeetingCalendarSyncLive } from '@/domain/crm/meetingCalendarService'

const request = () => new Request('https://x/api/cron/follow-ups', { headers: { authorization: 'Bearer s3cret' } })

beforeEach(() => {
  state.order = []
  state.locks = []
  state.calendarFails = false
  vi.stubEnv('CRON_SECRET', 's3cret')
  vi.stubEnv('FOLLOWUP_WATCH_ENABLED', 'true')
})
afterEach(() => vi.unstubAllEnvs())

describe('/api/cron/follow-ups + kontrola kalendáře', () => {
  test('kalendář běží první (vlastní zámek), pak hlídač; výsledek obou v odpovědi', async () => {
    const res = await GET(request())
    expect(res.status).toBe(200)
    expect(state.order).toEqual(['calendar', 'watch'])
    // Za hlídačem běží ještě vypršení žádostí o schválení (0084, vlastní zámek).
    expect(state.locks).toEqual(['calendar-sync', 'approval-expiry'])
    expect(runMeetingCalendarSyncLive).toHaveBeenCalledWith({ kind: 'cron' }, { budgetMs: 25_000 })
    const body = await res.json() as { status: string; calendar: { status: string; stats: unknown }; approvalExpiry: { status: string } }
    expect(body.status).toBe('succeeded')
    expect(body.calendar).toMatchObject({ status: 'succeeded', stats: { moved: 1 } })
    expect(body.approvalExpiry).toBeDefined()
  })

  test('CALENDAR_SYNC_ENABLED=false → kalendář se přeskočí, hlídač běží', async () => {
    vi.stubEnv('CALENDAR_SYNC_ENABLED', 'false')
    const res = await GET(request())
    expect(state.order).toEqual(['watch'])
    expect((await res.json() as { calendar: unknown }).calendar).toEqual({ status: 'disabled' })
  })

  test('chyba kontroly kalendáře hlídač nezastaví a odpověď zůstane 200', async () => {
    state.calendarFails = true
    const res = await GET(request())
    expect(res.status).toBe(200)
    expect(state.order).toEqual(['calendar', 'watch'])
    expect((await res.json() as { calendar: { status: string } }).calendar.status).toBe('failed')
  })

  test('bez FOLLOWUP_WATCH_ENABLED route dál vrací 404 a kalendář nespustí', async () => {
    vi.stubEnv('FOLLOWUP_WATCH_ENABLED', '')
    const res = await GET(request())
    expect(res.status).toBe(404)
    expect(state.order).toEqual([])
  })
})
