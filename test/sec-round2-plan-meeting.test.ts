// N8: plánování schůzky hledá existujícího klienta podle názvu z formuláře.
// Zástupné znaky LIKE se escapují a výsledek se dofiltruje přesnou shodou;
// víc přesných shod klienta nezaloží ani nepřiřadí naslepo.
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createAdminClient } from '@/lib/supabase/admin'
import { createMeetingEvent } from '@/connectors/graph'
import { planMeeting } from '@/domain/crm/actions/planMeeting'
import { createSupabaseFake, hasOp, opArgs, type QueryCall, type QueryResult } from './helpers/supabaseFake'

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

function fakeAdmin(accountRows: { id: number; name: string }[]) {
  const resolve = (call: QueryCall): QueryResult => {
    if (call.table === 'account' && hasOp(call, 'insert')) return { data: { id: 900 }, error: null }
    if (call.table === 'account') return { data: accountRows, error: null }
    if (call.table === 'sales_activity' && hasOp(call, 'insert')) return { data: { id: 77 }, error: null }
    return { data: null, error: null }
  }
  const f = createSupabaseFake({ resolve })
  vi.mocked(createAdminClient).mockReturnValue(f.client as never)
  return f
}

function fd(fields: Record<string, string>): FormData {
  const f = new FormData()
  for (const [k, v] of Object.entries(fields)) f.set(k, v)
  return f
}
const FORM = { account_id: '', title: 'Workshop AI', start: '2026-10-01T10:00', duration_min: '60', follow_up_days: '10' }
const insertedAccounts = (f: ReturnType<typeof fakeAdmin>) => f.calls.filter((c) => c.table === 'account' && hasOp(c, 'insert'))

beforeEach(() => vi.clearAllMocks())

describe('planMeeting: hledání klienta podle názvu', () => {
  test('zástupné znaky se escapují a klient se hledá přesnou shodou', async () => {
    const f = fakeAdmin([{ id: 5, name: 'Spolchemie' }])
    const res = await planMeeting(null, fd({ ...FORM, new_account_name: 'Spolchemie' }))
    expect(res).toMatchObject({ ok: true, accountId: 5, createdAccount: false })
    const lookup = f.calls.find((c) => c.table === 'account' && hasOp(c, 'ilike'))!
    expect(opArgs(lookup, 'ilike')).toEqual(['name', 'Spolchemie'])
    expect(insertedAccounts(f)).toHaveLength(0)
  })

  test('% a _ v názvu se do vzoru dostanou jen escapované', async () => {
    const f = fakeAdmin([])
    await planMeeting(null, fd({ ...FORM, new_account_name: '100%_firma' }))
    const lookup = f.calls.find((c) => c.table === 'account' && hasOp(c, 'ilike'))!
    expect(opArgs(lookup, 'ilike')).toEqual(['name', '100\\%\\_firma'])
  })

  test('podřetězcová shoda (např. `*` v PostgREST) klienta nepřiřadí: založí se nový', async () => {
    const f = fakeAdmin([{ id: 5, name: 'Spolchemie a.s.' }])
    const res = await planMeeting(null, fd({ ...FORM, new_account_name: '*chemie*' }))
    expect(res).toMatchObject({ ok: true, accountId: 900, createdAccount: true })
    expect(insertedAccounts(f)).toHaveLength(1)
  })

  test('víc přesných shod: nic se nezaloží ani nepřiřadí naslepo, událost v Outlooku nevznikne', async () => {
    const f = fakeAdmin([{ id: 5, name: 'Acme' }, { id: 6, name: 'ACME' }])
    const res = await planMeeting(null, fd({ ...FORM, new_account_name: 'acme' }))
    expect(res.ok).toBe(false)
    expect(insertedAccounts(f)).toHaveLength(0)
    expect(createMeetingEvent).not.toHaveBeenCalled()
  })

  test('shoda ignoruje velikost písmen a okolní mezery', async () => {
    fakeAdmin([{ id: 5, name: 'Spolchemie' }])
    const res = await planMeeting(null, fd({ ...FORM, new_account_name: '  SPOLCHEMIE ' }))
    expect(res).toMatchObject({ ok: true, accountId: 5, createdAccount: false })
  })
})

describe('planMeeting: délkové limity a účastníci z formuláře', () => {
  test.each([
    ['název klienta', { new_account_name: 'x'.repeat(201) }],
    ['název schůzky', { title: 'x'.repeat(201) }],
    ['účastníci', { new_account_name: 'Acme', attendees: 'a@b.cz,'.repeat(400) }],
    ['poznámka', { new_account_name: 'Acme', note: 'x'.repeat(4_001) }],
  ])('%s nad limit → chyba, nic se nezaloží', async (_n, over) => {
    const f = fakeAdmin([])
    const res = await planMeeting(null, fd({ ...FORM, new_account_name: 'Acme', ...over }))
    expect(res.ok).toBe(false)
    expect(f.calls).toHaveLength(0)
    expect(createMeetingEvent).not.toHaveBeenCalled()
  })

  test('účastník s parametry v adrese nedostane pozvánku ani kontakt', async () => {
    const f = fakeAdmin([{ id: 5, name: 'Acme' }])
    await planMeeting(null, fd({ ...FORM, new_account_name: 'Acme', attendees: 'ok@firma.cz, zly@firma.cz?bcc=x@y.cz' }))
    const event = vi.mocked(createMeetingEvent).mock.calls[0][1] as { attendees: { emailAddress: { address: string } }[] }
    expect(event.attendees.map((a) => a.emailAddress.address)).toEqual(['ok@firma.cz'])
    const contactInsert = f.calls.find((c) => c.table === 'contact' && hasOp(c, 'insert'))!
    expect(JSON.stringify(opArgs(contactInsert, 'insert'))).not.toContain('bcc')
  })
})
