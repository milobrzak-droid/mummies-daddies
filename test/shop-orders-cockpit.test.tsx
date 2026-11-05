// Cockpit › Práce › Objednávky (balík P6): seznam objednávek cheesecaků
// z webu a změna stavu (Server Action → RPC shop_order_set_status, 0106).
import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

const db = vi.hoisted(() => ({ rows: [] as unknown[], error: null as { code?: string } | null, calls: [] as string[], rpc: vi.fn() }))
const auth = vi.hoisted(() => ({ user: { id: 'u1' } as { id: string } | null }))

vi.mock('next/navigation', () => ({
  usePathname: () => '/cockpit/objednavky',
  redirect: (to: string) => { throw new Error(`REDIRECT ${to}`) },
  notFound: () => { throw new Error('NOT_FOUND') },
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/app/login/actions', () => ({ signOut: vi.fn() }))
vi.mock('@/lib/auth/requireUser', () => ({ tryRequireUser: vi.fn(async () => auth.user) }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => {
    const q = {
      select(cols: string) { db.calls.push(`select:${cols.includes('delivery_zone') ? '0106' : '0102'}`); return q },
      in(_c: string, v: readonly string[]) { db.calls.push(`in:${v.join(',')}`); return q },
      order() { return q },
      async limit() {
        const last = db.calls.filter((c) => c.startsWith('select')).at(-1)
        if (db.error?.code === '42703' && last === 'select:0106') return { data: null, error: db.error }
        return { data: db.rows, error: db.error?.code === '42703' ? null : db.error }
      },
    }
    return { from: () => q, rpc: db.rpc }
  },
}))

import ShopOrdersPage from '@/app/cockpit/objednavky/page'
import { setShopOrderStatus } from '@/app/cockpit/objednavky/actions'
import { canTransition, parseShopOrderFilter, shopOrderErrorCode, summarizeShopOrders, type ShopOrderRow } from '@/domain/web/shopOrders'

const row = (over: Partial<ShopOrderRow> = {}): ShopOrderRow => ({
  id: 12, received_at: '2026-11-05T09:00:00Z', status: 'new', fulfilment_date: '2026-11-12', fulfilment: 'delivery',
  delivery_address: 'Ulice 1, Praha', delivery_zone: 'praha-30', dedication: 'Pro Janu', note: null,
  customer_name: 'Jana Nováková', email: 'jana@email.example', phone: '+420 600 000 001', company_name: null, ico: null,
  payment_method: 'prevod',
  items: [{ product_key: 'daddy_vanilka', label: 'Daddy vanilkový', quantity: 2, unit_price_czk: 790, total_czk: 1580, inscription: 'Pro Janu' }],
  delivery_czk: 550, total_czk: 2130, status_changed_at: null,
  ...over,
})

async function render(sp: Record<string, string> = {}) {
  return renderToStaticMarkup(await ShopOrdersPage({ searchParams: Promise.resolve(sp) }))
}

describe('Objednávky v Cockpitu', () => {
  it('výchozí filtr „K vyřízení" čte nové, potvrzené a připravené; karta ukáže položky, dopravu a akce', async () => {
    db.rows = [row()]; db.error = null; db.calls = []
    const html = await render()
    expect(db.calls).toContain('in:new,confirmed,ready')
    expect(html).toContain('Objednávka č. 12')
    expect(html).toContain('2× Daddy vanilkový')
    expect(html).toContain('Doprava (Praha + 30 km)')
    expect(html).toContain('1 čeká na potvrzení')
    expect(html).toContain('>Potvrdit<')
    expect(html).toContain('>Zrušit<')
    expect(html).not.toContain('>Předáno<')
    expect(html).toContain('name="expected_status" value="new"')
  })

  it('bez migrace 0106 čte jen základ z 0102', async () => {
    db.rows = [row({ delivery_zone: undefined as never })]; db.error = { code: '42703' }; db.calls = []
    const html = await render({ stav: 'vse' })
    expect(db.calls.filter((c) => c.startsWith('select'))).toEqual(['select:0106', 'select:0102'])
    expect(html).toContain('Objednávka č. 12')
  })

  it('chyba čtení → prázdný stav s „Zkusit znovu"; chyba změny stavu z URL → hláška', async () => {
    db.rows = []; db.error = { code: '500' }
    expect(await render()).toContain('Objednávky se nepodařilo načíst')
    db.error = null
    expect(await render({ chyba: 'SO013' })).toContain('mezitím změnil někdo jiný')
    expect(await render()).toContain('Nic nečeká na vyřízení')
  })

  it('akce: bez AAL2 přihlášení nic nevolá; jinak RPC s očekávaným stavem a návrat na filtr', async () => {
    auth.user = null
    const fd = new FormData()
    fd.set('order_id', '12'); fd.set('status', 'confirmed'); fd.set('expected_status', 'new'); fd.set('back', '?stav=aktivni')
    await expect(setShopOrderStatus(fd)).rejects.toThrow('REDIRECT /cockpit/objednavky?chyba=SO011')
    expect(db.rpc).not.toHaveBeenCalled()
    auth.user = { id: 'u1' }
    db.rpc.mockResolvedValueOnce({ data: { changed: true }, error: null })
    await expect(setShopOrderStatus(fd)).rejects.toThrow('REDIRECT /cockpit/objednavky?stav=aktivni')
    expect(db.rpc).toHaveBeenCalledWith('shop_order_set_status', { p_order_id: 12, p_status: 'confirmed', p_expected_status: 'new' })
    db.rpc.mockResolvedValueOnce({ data: null, error: { code: 'P0001', message: 'SO014: tento přechod stavu není povolený' } })
    await expect(setShopOrderStatus(fd)).rejects.toThrow('REDIRECT /cockpit/objednavky?stav=aktivni&chyba=SO014')
    fd.set('status', 'hack')
    await expect(setShopOrderStatus(fd)).rejects.toThrow('chyba=unknown')
  })

  it('pomocníci: filtr, přechody, kódy chyb, souhrn', () => {
    expect(parseShopOrderFilter('ready')).toBe('ready')
    expect(parseShopOrderFilter('x')).toBe('aktivni')
    expect(canTransition('new', 'confirmed')).toBe(true)
    expect(canTransition('handed_over', 'new')).toBe(false)
    expect(shopOrderErrorCode({ code: 'PGRST202' })).toBe('missing')
    expect(shopOrderErrorCode({ message: 'SO013: …' })).toBe('SO013')
    expect(summarizeShopOrders([row(), row({ status: 'confirmed', fulfilment_date: '2026-11-05' })], '2026-11-05')).toEqual({ waiting: 1, today: 1 })
  })
})
