// /inventura (kap. 5, inventuru dělá Viktor sám): co dotaz vybere jako
// „potřebuje inventuru" a co akce smí zapsat.
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { createSupabaseFake, opArgs } from './helpers/supabaseFake'
import { getInventoryDeals } from '@/domain/crm/queries/inventory'
import { updateInventoryDeal } from '@/domain/crm/actions/inventory'

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/auth/requireUser', () => ({
  tryRequireUser: vi.fn(async () => ({ id: 'user-1' })),
  AUTH_ERROR_MESSAGE: 'Přihlas se prosím znovu.',
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/queries/currentMember', () => ({
  getCurrentMember: vi.fn(async () => ({ user: { id: 'user-1' }, member: { role: 'vedeni' } })),
  memberSeesSales: vi.fn((member: { role?: string | null } | null) => member?.role === 'vedeni' || member?.role === 'obchodnik'),
}))

beforeEach(() => vi.clearAllMocks())

const openRow = (over: Record<string, unknown> = {}) => ({
  id: 1, account_id: 10, title: 'Workshop AI', stage: 'kvalifikace',
  owner_id: 'u1', next_step: 'Zavolat', next_step_due: '2026-10-05',
  no_next_step_reason: null, created_at: '2026-09-01', updated_at: '2026-09-01',
  deal_kind: 'workshop', decision_maker: null, decision_due: null,
  account: { id: 10, name: 'Spolchemie' }, owner: { id: 'u1', full_name: 'Viktor' },
  ...over,
})

describe('getInventoryDeals', () => {
  test('kompletní obchod se nevypisuje a počítá se jako hotový', async () => {
    const fake = createSupabaseFake({ resolve: () => ({ data: [openRow()], error: null }) })
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    const result = await getInventoryDeals()
    expect(result.deals).toEqual([])
    expect(result.totalOpen).toBe(1)
    expect(result.done).toBe(1)
    expect(result.columns0052Available).toBe(true)
  })

  test('chybějící deal_kind se nahlásí', async () => {
    const fake = createSupabaseFake({
      resolve: () => ({ data: [openRow({ deal_kind: null })], error: null }),
    })
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    const result = await getInventoryDeals()
    expect(result.deals).toHaveLength(1)
    expect(result.deals[0].reasons).toEqual(['missing_deal_kind'])
    expect(result.done).toBe(0)
  })

  test('fáze rozhodování bez rozhodovatele a termínu', async () => {
    const fake = createSupabaseFake({
      resolve: () => ({
        data: [openRow({ stage: 'rozhodovani', decision_maker: null, decision_due: null })],
        error: null,
      }),
    })
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    const result = await getInventoryDeals()
    expect(result.deals[0].reasons).toEqual(['missing_decision_maker', 'missing_decision_due'])
  })

  test('rozhodování s vyplněným rozhodovatelem a termínem neprojde jako chybějící', async () => {
    const fake = createSupabaseFake({
      resolve: () => ({
        data: [openRow({ stage: 'rozhodovani', decision_maker: 'CFO Novák', decision_due: '2026-10-15' })],
        error: null,
      }),
    })
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    const result = await getInventoryDeals()
    expect(result.deals).toEqual([])
  })

  test('porušení checkDealInvariant (chybí vlastník) se nahlásí', async () => {
    const fake = createSupabaseFake({
      resolve: () => ({ data: [openRow({ owner_id: null })], error: null }),
    })
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    const result = await getInventoryDeals()
    expect(result.deals[0].reasons).toEqual(['missing_owner'])
  })

  test('starý filtr fáze (withLegacyDealStages) se použije v dotazu', async () => {
    const fake = createSupabaseFake({ resolve: () => ({ data: [], error: null }) })
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    await getInventoryDeals()
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0].table).toBe('deal')
    const inArgs = opArgs(fake.calls[0], 'in')
    expect(inArgs?.[0]).toBe('stage')
    expect(inArgs?.[1]).toEqual(expect.arrayContaining(['kvalifikace', 'rozhodovani']))
  })

  test('chybějící sloupce 0052 (42703) — zopakuje dotaz bez nich a nastaví columns0052Available=false', async () => {
    let call = 0
    const fake = createSupabaseFake({
      resolve: () => {
        call += 1
        if (call === 1) return { data: null, error: { code: '42703' } }
        return { data: [openRow({ deal_kind: undefined, decision_maker: undefined, decision_due: undefined })], error: null }
      },
    })
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    const result = await getInventoryDeals()
    expect(result.columns0052Available).toBe(false)
    expect(fake.calls).toHaveLength(2)
    // Bez 0052 sloupců se deal_kind nekontroluje — obchod je "hotový" i bez něj.
    expect(result.deals).toEqual([])
  })

  test('jiná chyba databáze se nezachytává a vyhodí', async () => {
    const fake = createSupabaseFake({ resolve: () => ({ data: null, error: { code: '23505', message: 'boom' } }) })
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    await expect(getInventoryDeals()).rejects.toBeTruthy()
  })
})

describe('updateInventoryDeal', () => {
  const call = (
    formEntries: Record<string, string>,
    resolve: () => { data: unknown; error: unknown } = () => ({ data: [{ id: 1 }], error: null }),
  ) => {
    const fake = createSupabaseFake({ resolve })
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    const fd = new FormData()
    for (const [k, v] of Object.entries(formEntries)) fd.set(k, v)
    return { fake, result: updateInventoryDeal(1, 10, null, fd) }
  }

  test('odmítne bez přihlášení', async () => {
    const { tryRequireUser } = await import('@/lib/auth/requireUser')
    vi.mocked(tryRequireUser).mockResolvedValueOnce(null)
    const { result } = call({ deal_kind: 'workshop' })
    const res = await result
    expect(res.success).toBe(false)
    expect(res.error).toBeTruthy()
  })

  test('odmítne neplatná ID', async () => {
    const fake = createSupabaseFake({ resolve: () => ({ data: null, error: null }) })
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    const fd = new FormData()
    const res = await updateInventoryDeal(-1, 10, null, fd)
    expect(res.success).toBe(false)
  })

  test('odmítne uživatele bez přístupu k sales CRM', async () => {
    const { memberSeesSales } = await import('@/lib/queries/currentMember')
    vi.mocked(memberSeesSales).mockReturnValueOnce(false)
    const { result } = call({ deal_kind: 'workshop' })
    const res = await result
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/přístup/)
  })

  test('odmítne neplatný deal_kind', async () => {
    const { result } = call({ deal_kind: 'neco-jineho' })
    const res = await result
    expect(res.success).toBe(false)
    expect(res.fieldErrors?.deal_kind).toBeTruthy()
  })

  test('zapíše JEN dovolených šest polí', async () => {
    const { fake, result } = call({
      deal_kind: 'implementace',
      decision_maker: 'CFO Novák',
      decision_due: '2026-10-15',
      next_step: 'Poslat nabídku',
      next_step_due: '2026-10-01',
      no_next_step_reason: '',
      // Cizí pole, které akce NESMÍ zapsat:
      title: 'Pokus o přepsání názvu',
      owner_id: 'jiny-uzivatel',
    })
    const res = await result
    expect(res.success).toBe(true)
    expect(fake.calls).toHaveLength(1)
    const updateArgs = opArgs(fake.calls[0], 'update')
    const row = updateArgs?.[0] as Record<string, unknown>
    expect(row).toEqual({
      deal_kind: 'implementace',
      decision_maker: 'CFO Novák',
      decision_due: '2026-10-15',
      next_step: 'Poslat nabídku',
      next_step_due: '2026-10-01',
      no_next_step_reason: null,
    })
    expect(row.title).toBeUndefined()
    expect(row.owner_id).toBeUndefined()
    expect(opArgs(fake.calls[0], 'eq')).toEqual(['id', 1])
  })

  test('filtruje update i podle account_id (obchod nejde přepsat přes cizí klienta)', async () => {
    const { fake, result } = call({ deal_kind: 'provoz' })
    await result
    const secondEq = fake.calls[0]?.ops.filter((o) => o.method === 'eq')[1]
    expect(secondEq).toEqual({ method: 'eq', args: ['account_id', 10] })
  })

  test('pole, která formulář neposlal (mimo rozhodování), se nezapíšou ani nesmažou', async () => {
    const { fake, result } = call({
      deal_kind: 'workshop',
      next_step: 'Zavolat',
      next_step_due: '2026-10-05',
      no_next_step_reason: '',
    })
    const res = await result
    expect(res.success).toBe(true)
    const row = opArgs(fake.calls[0], 'update')?.[0] as Record<string, unknown>
    expect(row).toEqual({
      deal_kind: 'workshop', next_step: 'Zavolat', next_step_due: '2026-10-05', no_next_step_reason: null,
    })
    expect('decision_maker' in row).toBe(false)
    expect('decision_due' in row).toBe(false)
  })

  test('bez 0052 (deal_kind se nevykreslí) se deal_kind nepřepíše na null', async () => {
    const { fake, result } = call({ next_step: 'Zavolat', next_step_due: '', no_next_step_reason: '' })
    const res = await result
    expect(res.success).toBe(true)
    const row = opArgs(fake.calls[0], 'update')?.[0] as Record<string, unknown>
    expect(row).toEqual({ next_step: 'Zavolat', next_step_due: null, no_next_step_reason: null })
    expect('deal_kind' in row).toBe(false)
  })

  test('prázdný formulář nic nezapíše', async () => {
    const { fake, result } = call({})
    const res = await result
    expect(res.success).toBe(false)
    expect(fake.calls).toHaveLength(0)
  })

  test('update bez zasaženého řádku není úspěch', async () => {
    const { fake, result } = call({ next_step: 'Zavolat' }, () => ({ data: [], error: null }))
    const res = await result
    expect(res.success).toBe(false)
    expect(res.error).toBe('Obchod nebyl nalezen.')
    expect(opArgs(fake.calls[0], 'select')).toEqual(['id'])
  })

  test('další krok nad 500 znaků se odmítne', async () => {
    const { fake, result } = call({ next_step: 'x'.repeat(501) })
    const res = await result
    expect(res.success).toBe(false)
    expect(res.fieldErrors?.next_step).toMatch(/500/)
    expect(fake.calls).toHaveLength(0)
  })

  test('neplatný termín kroku se odmítne (formát i neexistující den)', async () => {
    for (const bad of ['zítra', '2026-02-30', '2026-13-01']) {
      const { fake, result } = call({ next_step: 'Zavolat', next_step_due: bad })
      const res = await result
      expect(res.success).toBe(false)
      expect(res.fieldErrors?.next_step_due).toBeTruthy()
      expect(fake.calls).toHaveLength(0)
    }
  })
})
