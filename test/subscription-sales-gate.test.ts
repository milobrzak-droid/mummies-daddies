// Předplatné (MRR) je od 0058 jen pro obchodní role (RESTRICTIVE sales_only).
// Akce to hlásí srozumitelně dřív, než by zápis tiše skončil na RLS.
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { getCurrentMember } from '@/lib/queries/currentMember'
import { createSubscription, endSubscription, updateSubscription } from '@/domain/finance/actions/subscriptions'
import { createSupabaseFake, hasOp } from './helpers/supabaseFake'

vi.mock('@/lib/auth/requireUser', () => ({
  requireUser: vi.fn(async () => ({ id: 'user-1' })),
  tryRequireUser: vi.fn(async () => ({ id: 'user-1' })),
  AUTH_ERROR_MESSAGE: 'auth',
}))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/lib/queries/currentMember', () => ({
  getCurrentMember: vi.fn(),
  memberSeesSales: (m: { role?: string | null } | null) => m?.role === 'vedeni' || m?.role === 'obchodnik',
}))

const as = (role: string) =>
  vi.mocked(getCurrentMember).mockResolvedValue({ user: { id: 'user-1' } as never, member: { role, full_name: null, is_admin: false } })

function fd(): FormData {
  const f = new FormData()
  f.append('product', 'Copilot')
  f.append('seats', '10')
  f.append('mrr', '5000')
  return f
}

function setup() {
  const fake = createSupabaseFake({ resolve: () => ({ data: null, error: null }) })
  vi.mocked(createClient).mockResolvedValue(fake.client as never)
  return fake
}

beforeEach(() => vi.clearAllMocks())

describe('předplatné jen pro obchodní role', () => {
  test.each(['projektak', 'lektor', 'partner'])('%s: create/update vrátí chybu, do DB nic', async (role) => {
    as(role)
    const fake = setup()
    const c = await createSubscription(1, null, fd())
    const u = await updateSubscription(1, 2, null, fd())
    for (const r of [c, u]) expect(r).toEqual({ success: false, error: 'Předplatné může upravovat jen člen s přístupem k obchodu.' })
    expect(fake.calls).toHaveLength(0)
  })

  test('projekťák: endSubscription vyhodí chybu, žádný update', async () => {
    as('projektak')
    const fake = setup()
    await expect(endSubscription(1, 2)).rejects.toThrow(/přístupem k obchodu/)
    expect(fake.calls).toHaveLength(0)
  })

  test('obchodník: create zapíše předplatné', async () => {
    as('obchodnik')
    const fake = setup()
    expect(await createSubscription(1, null, fd())).toEqual({ success: true })
    expect(fake.calls.some((c) => c.table === 'subscription' && hasOp(c, 'insert'))).toBe(true)
  })
})
