import { beforeEach, describe, expect, test, vi } from 'vitest'
import { redirect } from 'next/navigation'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { tryRequireUser } from '@/lib/auth/requireUser'
import { getCurrentMember } from '@/lib/queries/currentMember'
import { logError } from '@/lib/log'
import { createDeliveryForDeal } from '@/domain/delivery/actions/autoDelivery'
import { createSupabaseFake, type QueryCall, type QueryResult } from './helpers/supabaseFake'

// Záložní tlačítko „Založit dodávku" (0080): brány předem, RPC ensure_deal_delivery
// jako jediný zápis, klidné hlášky před migrací a u nevyhraného obchodu.

vi.mock('@/lib/auth/requireUser', () => ({ tryRequireUser: vi.fn(async () => ({ id: 'u1' })), requireUser: vi.fn(), AUTH_ERROR_MESSAGE: 'auth' }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/queries/currentMember', async (orig) => ({
  ...(await orig<typeof import('@/lib/queries/currentMember')>()),
  getCurrentMember: vi.fn(),
}))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('next/navigation', () => ({ redirect: vi.fn() }))

let dealRow: unknown
let rpcResult: { data: unknown; error: { code?: string; message?: string } | null }
function fake() {
  const f = createSupabaseFake({
    user: { id: 'u1' },
    resolve: (c: QueryCall): QueryResult => (c.table === 'deal' ? { data: dealRow, error: null } : { data: null, error: null }),
    rpc: () => rpcResult,
  })
  vi.mocked(createClient).mockResolvedValue(f.client as never)
  return f
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(tryRequireUser).mockResolvedValue({ id: 'u1' } as never)
  vi.mocked(getCurrentMember).mockResolvedValue({ user: { id: 'u1' }, member: { full_name: 'Viktor', is_admin: true, role: 'vedeni' } } as never)
  dealRow = { id: 9 }
  rpcResult = { data: { engagement_id: 12, created: true }, error: null }
})

describe('createDeliveryForDeal', () => {
  test('bez AAL2, s neplatným ID a bez obchodní role se nic nezavolá', async () => {
    const f = fake()
    vi.mocked(tryRequireUser).mockResolvedValueOnce(null)
    expect(await createDeliveryForDeal(2, 9)).toEqual({ success: false, error: 'auth' })
    expect(await createDeliveryForDeal(0, 9)).toEqual({ success: false, error: 'Neplatné ID.' })
    vi.mocked(getCurrentMember).mockResolvedValueOnce({ user: { id: 'u1' }, member: { full_name: 'P', is_admin: false, role: 'projektak' } } as never)
    expect((await createDeliveryForDeal(2, 9)).error).toMatch(/přístupem k obchodu/)
    expect(f.rpc).not.toHaveBeenCalled()
  })

  test('obchod jiného klienta se tváří jako neexistující', async () => {
    const f = fake()
    dealRow = null
    expect(await createDeliveryForDeal(2, 9)).toEqual({ success: false, error: 'Obchod nebyl nalezen.' })
    expect(f.rpc).not.toHaveBeenCalled()
  })

  test('úspěch: RPC ensure_deal_delivery, obnovení stránek a přesměrování na dodávku', async () => {
    const f = fake()
    await createDeliveryForDeal(2, 9)
    expect(f.rpc).toHaveBeenCalledWith('ensure_deal_delivery', { p_deal_id: 9 })
    expect(revalidatePath).toHaveBeenCalledWith('/cockpit/clients/2/deals/9')
    expect(redirect).toHaveBeenCalledWith('/cockpit/clients/2/engagements/12/edit')
  })

  test('dodávka už existuje (created=false): jen na ni odkáže', async () => {
    fake()
    rpcResult = { data: { engagement_id: 5, created: false }, error: null }
    await createDeliveryForDeal(2, 9)
    expect(redirect).toHaveBeenCalledWith('/cockpit/clients/2/engagements/5/edit')
  })

  test('před migrací 0080 klidná věta, ne surová chyba', async () => {
    fake()
    rpcResult = { data: null, error: { code: 'PGRST202', message: 'Could not find the function public.ensure_deal_delivery' } }
    const r = await createDeliveryForDeal(2, 9)
    expect(r.success).toBe(false)
    expect(r.error).toContain('0080')
    expect(redirect).not.toHaveBeenCalled()
    expect(logError).not.toHaveBeenCalled()
  })

  test('nevyhraný obchod (AD001) a neznámá chyba', async () => {
    fake()
    rpcResult = { data: null, error: { code: 'AD001', message: 'x' } }
    expect((await createDeliveryForDeal(2, 9)).error).toBe('Dodávku jde založit jen z vyhraného obchodu.')
    rpcResult = { data: null, error: { code: 'XX000', message: 'interní detail tabulky engagement' } }
    const r = await createDeliveryForDeal(2, 9)
    expect(r.error).not.toContain('engagement')
    expect(logError).toHaveBeenCalled()
  })
})
