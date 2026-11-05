// Oprava: planMeeting parsoval čas z formuláře (`<input type="datetime-local">`,
// myšlený jako Europe/Prague) přes `new Date(f.start)`, což ho čte v časovém
// pásmu serveru. Na Vercelu (UTC) tak 10:00 pražského (léto: 08:00Z, zima:
// 09:00Z) skončilo uložené jako occurred_at = 10:00Z — o 1–2 h vedle.
//
// Test kryje:
//  - pragueLocalToUtc (lib/pragueDate.ts): zima, léto, podzimní přechod
//    (2026-10-25, dvojznačný čas), jarní přechod (2026-03-29, neexistující čas),
//  - planMeeting: uložené occurred_at odpovídá pražskému místnímu času bez
//    ohledu na to, v jakém pásmu tento test běží,
//  - Graph dostává dateTime jako pražský místní čas + timeZone: Europe/Prague
//    (ne UTC instant přelabelovaný jako Praha).
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createAdminClient } from '@/lib/supabase/admin'
import { tryRequireUser } from '@/lib/auth/requireUser'
import { createMeetingEvent } from '@/connectors/graph'
import { planMeeting } from '@/domain/crm/actions/planMeeting'
import { pragueLocalToUtc } from '@/lib/pragueDate'
import { canCurrentUserSeeSales } from '@/lib/queries/access'
import { createSupabaseFake, opArgs, type QueryCall, type QueryResult } from './helpers/supabaseFake'

vi.mock('@/lib/auth/requireUser', () => ({
  requireUser: vi.fn(async () => ({ id: 'user-1' })),
  tryRequireUser: vi.fn(async () => ({ id: 'user-1' })),
  AUTH_ERROR_MESSAGE: 'auth',
}))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/connectors/ares', () => ({ aresSearchByName: vi.fn(async () => []), pickAresMatch: vi.fn(() => null) }))
vi.mock('@/connectors/graph', () => ({
  graphTokenForCurrentUser: vi.fn(async () => ({ ok: true, accessToken: 'tok' })),
  createMeetingEvent: vi.fn(async () => ({ id: 'ev-1', joinUrl: null })),
}))
vi.mock('@/core/connectorState', () => ({ recordConnectorError: vi.fn(), recordConnectorSuccess: vi.fn() }))
vi.mock('@/lib/queries/access', () => ({ canCurrentUserSeeSales: vi.fn(async () => true) }))

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(tryRequireUser).mockResolvedValue({ id: 'user-1' } as never)
  vi.mocked(canCurrentUserSeeSales).mockResolvedValue(true)
})

function fd(fields: Record<string, string>): FormData {
  const f = new FormData()
  for (const [k, v] of Object.entries(fields)) f.set(k, v)
  return f
}

function fakeAdmin(resolve: (call: QueryCall) => QueryResult = () => ({ data: null, error: null })) {
  const f = createSupabaseFake({ resolve })
  vi.mocked(createAdminClient).mockReturnValue(f.client as never)
  return f
}

describe('pragueLocalToUtc (lib/pragueDate.ts) — čistá funkce', () => {
  test('zima (CET, UTC+1): 10:00 Praha = 09:00Z', () => {
    expect(pragueLocalToUtc('2026-01-15T10:00').toISOString()).toBe('2026-01-15T09:00:00.000Z')
  })
  test('léto (CEST, UTC+2): 10:00 Praha = 08:00Z', () => {
    expect(pragueLocalToUtc('2026-07-15T10:00').toISOString()).toBe('2026-07-15T08:00:00.000Z')
  })
  test('podzimní přechod 2026-10-25: 07:00 před a po', () => {
    expect(pragueLocalToUtc('2026-10-24T07:00').toISOString()).toBe('2026-10-24T05:00:00.000Z') // CEST
    expect(pragueLocalToUtc('2026-10-25T07:00').toISOString()).toBe('2026-10-25T06:00:00.000Z') // CET
  })
  test('podzimní přechod 2026-10-25: dvojznačný místní čas 02:30 se vyřeší jednoznačně', () => {
    const d = pragueLocalToUtc('2026-10-25T02:30')
    // 02:30 nastává dvakrát (CEST i CET) — funkce musí vrátit platný okamžik,
    // který se zpětně na 02:30 pražského času skutečně převádí.
    expect(['2026-10-25T00:30:00.000Z', '2026-10-25T01:30:00.000Z']).toContain(d.toISOString())
  })
  test('jarní přechod 2026-03-29: 07:00 zůstává jednoznačné', () => {
    expect(pragueLocalToUtc('2026-03-29T07:00').toISOString()).toBe('2026-03-29T05:00:00.000Z')
  })
  test('jarní přechod 2026-03-29: neexistující čas 02:30 (skok 02:00→03:00) vrátí okamžik po skoku', () => {
    const d = pragueLocalToUtc('2026-03-29T02:30')
    // Skok proběhne v 01:00 UTC (02:00 CET → 03:00 CEST) — 02:30 neexistuje,
    // funkce musí vrátit určitý okamžik, ne selhat/NaN.
    expect(Number.isNaN(d.getTime())).toBe(false)
    expect(d >= new Date('2026-03-29T00:00:00.000Z')).toBe(true)
    expect(d <= new Date('2026-03-29T02:00:00.000Z')).toBe(true)
  })
  test('neplatný vstup vyhodí chybu', () => {
    expect(() => pragueLocalToUtc('not-a-date')).toThrow()
  })
})

describe('planMeeting: occurred_at odpovídá pražskému místnímu času (bez ohledu na TZ serveru)', () => {
  test('zimní termín (CET): occurred_at = 09:00Z pro 10:00 Praha', async () => {
    const f = fakeAdmin((call) =>
      call.table === 'sales_activity' ? { data: { id: 1 }, error: null } : { data: null, error: null })
    const res = await planMeeting(null, fd({
      account_id: '5', title: 'Zimní schůzka', start: '2026-01-15T10:00', duration_min: '60', follow_up_days: '10',
    }))
    expect(res.ok).toBe(true)
    const activity = opArgs(f.calls.find((c) => c.table === 'sales_activity')!, 'insert')?.[0] as Record<string, unknown>
    expect(activity.occurred_at).toBe('2026-01-15T09:00:00.000Z')
  })

  test('letní termín (CEST): occurred_at = 08:00Z pro 10:00 Praha', async () => {
    const f = fakeAdmin((call) =>
      call.table === 'sales_activity' ? { data: { id: 1 }, error: null } : { data: null, error: null })
    const res = await planMeeting(null, fd({
      account_id: '5', title: 'Letní schůzka', start: '2026-07-15T10:00', duration_min: '60', follow_up_days: '10',
    }))
    expect(res.ok).toBe(true)
    const activity = opArgs(f.calls.find((c) => c.table === 'sales_activity')!, 'insert')?.[0] as Record<string, unknown>
    expect(activity.occurred_at).toBe('2026-07-15T08:00:00.000Z')
  })

  test('Graph dostává pražský místní čas + timeZone Europe/Prague, ne UTC instant', async () => {
    fakeAdmin((call) => call.table === 'sales_activity' ? { data: { id: 1 }, error: null } : { data: null, error: null })
    const res = await planMeeting(null, fd({
      account_id: '5', title: 'Zimní schůzka', start: '2026-01-15T10:00', duration_min: '30', follow_up_days: '10',
    }))
    expect(res.ok).toBe(true)
    const [, event] = vi.mocked(createMeetingEvent).mock.calls[0] as [string, { start: { dateTime: string; timeZone: string }; end: { dateTime: string; timeZone: string } }]
    expect(event.start).toEqual({ dateTime: '2026-01-15T10:00:00', timeZone: 'Europe/Prague' })
    expect(event.end).toEqual({ dateTime: '2026-01-15T10:30:00', timeZone: 'Europe/Prague' })
  })
})

describe('planMeeting — jen obchodní role', () => {
  test('ne-obchodní role: odmítnuto, nic se nezapíše ani nevolá Graph', async () => {
    vi.mocked(canCurrentUserSeeSales).mockResolvedValue(false)
    const f = fakeAdmin()
    const res = await planMeeting(null, fd({ account_id: '5', title: 'x', start: '2026-10-01T10:00' }))
    expect(res).toEqual({ ok: false, error: 'Nemáš oprávnění.' })
    expect(f.calls).toHaveLength(0)
    expect(createMeetingEvent).not.toHaveBeenCalled()
  })

  test('chyba zápisu nevrací surovou hlášku z Postgresu', async () => {
    fakeAdmin((call) => call.table === 'sales_activity'
      ? { data: null, error: { message: 'duplicate key value violates unique constraint "secret_idx"' } }
      : { data: null, error: null })
    const res = await planMeeting(null, fd({ account_id: '5', title: 'x', start: '2026-10-01T10:00' }))
    expect(res).toEqual({ ok: false, error: 'Záznam se nepodařilo uložit.' })
  })
})
