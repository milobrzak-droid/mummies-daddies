// getMyCalendarConnection: udělená oprávnění z calendar_token.granted_scopes
// (migrace 0060) — a bez té migrace se Outlook nesmí tvářit odpojený.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { getMyCalendarConnection } from '@/domain/crm/queries/calendar'
import { createSupabaseFake, opArgs, type QueryCall, type QueryResult } from './helpers/supabaseFake'

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

function setup(resolve: (call: QueryCall) => QueryResult, user: { id: string } | null = { id: 'member-1' }) {
  const fake = createSupabaseFake({ resolve, user })
  vi.mocked(createClient).mockResolvedValue(fake.client as never)
  return fake
}

beforeEach(() => vi.clearAllMocks())

describe('getMyCalendarConnection', () => {
  it('vrací e-mail a udělená oprávnění', async () => {
    const fake = setup(() => ({ data: { account_email: 'viktor@mummiesdaddies.com', granted_scopes: 'Calendars.ReadWrite User.Read' }, error: null }))
    expect(await getMyCalendarConnection()).toEqual({ connected: true, email: 'viktor@mummiesdaddies.com', grantedScopes: 'Calendars.ReadWrite User.Read' })
    expect(opArgs(fake.calls[0], 'select')).toEqual(['account_email, granted_scopes'])
    expect(opArgs(fake.calls[0], 'eq')).toEqual(['member_id', 'member-1'])
  })

  it('bez migrace 0060 (sloupec chybí) → připojeno, oprávnění neznámá', async () => {
    const fake = setup((call) => (opArgs(call, 'select')?.[0] === 'account_email, granted_scopes'
      ? { data: null, error: { code: '42703', message: 'column calendar_token.granted_scopes does not exist' } }
      : { data: { account_email: 'viktor@mummiesdaddies.com' }, error: null }))
    expect(await getMyCalendarConnection()).toEqual({ connected: true, email: 'viktor@mummiesdaddies.com', grantedScopes: null })
    expect(fake.calls).toHaveLength(2)
  })

  it('jiná chyba nebo žádný řádek → nepřipojeno; bez přihlášení nic nečte', async () => {
    setup(() => ({ data: null, error: { code: 'XX000', message: 'boom' } }))
    expect(await getMyCalendarConnection()).toEqual({ connected: false, email: null, grantedScopes: null })
    setup(() => ({ data: null, error: null }))
    expect(await getMyCalendarConnection()).toEqual({ connected: false, email: null, grantedScopes: null })
    const fake = setup(() => ({ data: null, error: null }), null)
    expect(await getMyCalendarConnection()).toEqual({ connected: false, email: null, grantedScopes: null })
    expect(fake.calls).toHaveLength(0)
  })
})
