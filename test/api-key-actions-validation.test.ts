import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { tryRequireUser } from '@/lib/auth/requireUser'
import { createApiKey, revokeApiKey } from '@/lib/actions/apiKeys'
import { createSupabaseFake, opArgs } from './helpers/supabaseFake'

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))
vi.mock('@/lib/auth/requireUser', () => ({ tryRequireUser: vi.fn(), AUTH_ERROR_MESSAGE: 'auth' }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))

let adminFake: ReturnType<typeof createSupabaseFake>
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(tryRequireUser).mockResolvedValue({ id: 'u1' } as never)
  vi.mocked(createClient).mockResolvedValue(
    createSupabaseFake({ resolve: () => ({ data: { is_admin: true }, error: null }) }).client as never,
  )
  adminFake = createSupabaseFake()
  vi.mocked(createAdminClient).mockReturnValue(adminFake.client as never)
})

const fd = (name: string) => { const f = new FormData(); f.set('name', name); return f }

describe('createApiKey — název', () => {
  test('ořeže a uloží', async () => {
    const r = await createApiKey(null, fd('  Zapier  '))
    expect(r.success).toBe(true)
    expect((opArgs(adminFake.calls[0], 'insert')?.[0] as { name: string }).name).toBe('Zapier')
  })
  test.each(['', '   '])('prázdný %j odmítne', async n => {
    expect(await createApiKey(null, fd(n))).toEqual({ success: false, fieldErrors: { name: 'Název je povinný.' } })
    expect(adminFake.calls).toHaveLength(0)
  })
  test('100 znaků projde, 101 ne', async () => {
    expect((await createApiKey(null, fd('a'.repeat(100)))).success).toBe(true)
    expect(await createApiKey(null, fd('a'.repeat(101)))).toEqual({
      success: false, fieldErrors: { name: 'Název může mít nejvýš 100 znaků.' },
    })
  })
  test('gate bez AAL2 uživatele', async () => {
    vi.mocked(tryRequireUser).mockResolvedValue(null)
    expect(await createApiKey(null, fd('x'))).toEqual({ success: false, error: 'auth' })
    expect(tryRequireUser).toHaveBeenCalledWith({ aal2: true })
  })
})

describe('createApiKey — rozsah', () => {
  const withScope = (scope: string) => { const f = fd('Zkratka'); f.set('scope', scope); return f }
  const inserted = () => opArgs(adminFake.calls[0], 'insert')?.[0] as Record<string, unknown>

  test('bez pole scope zůstává výchozí chování (sloupec scope se nezapisuje → DB default full)', async () => {
    await createApiKey(null, fd('Claude'))
    expect(inserted()).not.toHaveProperty('scope')
  })
  test('intake se zapíše jako scope intake', async () => {
    expect((await createApiKey(null, withScope('intake'))).success).toBe(true)
    expect(inserted()).toMatchObject({ name: 'Zkratka', scope: 'intake' })
  })
  test.each(['full', 'read', 'admin', ''])('hodnota %j nikdy nevydá jiný než výchozí (full) klíč', async (v) => {
    await createApiKey(null, withScope(v))
    expect(inserted()).not.toHaveProperty('scope')
  })
  test('intake bez migrace 0079 (CHECK 23514) → česká hláška, ne obecná chyba', async () => {
    adminFake = createSupabaseFake({ resolve: () => ({ data: null, error: { code: '23514', message: 'check' } }) })
    vi.mocked(createAdminClient).mockReturnValue(adminFake.client as never)
    const r = await createApiKey(null, withScope('intake'))
    expect(r.success).toBe(false)
    expect(r.error).toContain('0079')
  })
})

describe('revokeApiKey — id', () => {
  test.each([0, -1, 1.5, Number.NaN, '3' as unknown as number])('neplatné %j', async id => {
    expect(await revokeApiKey(id)).toEqual({ success: false, error: 'Neplatný API klíč.' })
    expect(adminFake.calls).toHaveLength(0)
  })
  test('platné id odvolá', async () => {
    expect(await revokeApiKey(7)).toEqual({ success: true })
    expect(opArgs(adminFake.calls[0], 'eq')).toEqual(['id', 7])
  })
})
