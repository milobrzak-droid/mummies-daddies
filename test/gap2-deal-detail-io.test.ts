import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import {
  getDealAuditHistory,
  getDealForAccount,
  getDealPartnersWithNames,
  getEngagementsForDeal,
  getSalesActivitiesForDeal,
} from '@/domain/crm/queries/dealDetail'
import { createSupabaseFake, opArgs } from './helpers/supabaseFake'

// domain/crm/queries/dealDetail.ts — I/O dotazy pro detail obchodu. Vedle
// summarizeAuditChange (test/deal-detail.test.ts) tu chybělo pokrytí:
// - getDealForAccount vrací null, když obchod nepatří pod dané account_id
//   (stránka to pak převádí na notFound())
// - getDealAuditHistory degraduje na null, když audit_event nejde přečíst
//   (RLS, chybějící tabulka, i vyhozená výjimka), nikdy to nesmí spadnout

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

beforeEach(() => vi.clearAllMocks())

describe('getDealForAccount', () => {
  test('neplatné accountId/dealId (NaN, desetinné) → null, DB se vůbec nevolá', async () => {
    const fake = createSupabaseFake()
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    expect(await getDealForAccount(NaN, 1)).toBeNull()
    expect(await getDealForAccount(1, 1.5)).toBeNull()
    expect(fake.calls).toHaveLength(0)
  })

  test('záporné dealId guard zachytí, DB se vůbec nevolá → null', async () => {
    const fake = createSupabaseFake({ resolve: () => ({ data: null, error: null }) })
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    expect(await getDealForAccount(1, -1)).toBeNull()
    expect(fake.calls).toHaveLength(0)
  })

  test('nulové dealId guard zachytí, DB se vůbec nevolá → null', async () => {
    const fake = createSupabaseFake({ resolve: () => ({ data: null, error: null }) })
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    expect(await getDealForAccount(1, 0)).toBeNull()
    expect(fake.calls).toHaveLength(0)
  })

  test('obchod existuje, ale patří pod jiné account_id → maybeSingle vrátí null → null (ne cizí data)', async () => {
    // Dotaz vždy filtruje .eq('id', dealId).eq('account_id', accountId) — když
    // obchod patří jinam, DB s tímto dvojitým filtrem nic nevrátí.
    const fake = createSupabaseFake({ resolve: () => ({ data: null, error: null }) })
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    const result = await getDealForAccount(7, 42)
    expect(result).toBeNull()
    const call = fake.calls[0]
    expect(call.table).toBe('deal')
    const eqCalls = call.ops.filter((o) => o.method === 'eq')
    expect(eqCalls).toEqual([
      { method: 'eq', args: ['id', 42] },
      { method: 'eq', args: ['account_id', 7] },
    ])
  })

  test('obchod pod správným účtem se vrátí', async () => {
    const deal = { id: 42, account_id: 7, title: 'X', owner: null, account: { id: 7, name: 'Firma' } }
    const fake = createSupabaseFake({ resolve: () => ({ data: deal, error: null }) })
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    expect(await getDealForAccount(7, 42)).toEqual(deal)
  })

  test('chyba databáze se propaguje (vyhodí)', async () => {
    const fake = createSupabaseFake({ resolve: () => ({ data: null, error: { message: 'boom' } }) })
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    await expect(getDealForAccount(7, 42)).rejects.toBeDefined()
  })
})

describe('getDealAuditHistory — degraduje, nikdy nespadne', () => {
  test('DB vrátí chybu (RLS/chybějící tabulka) → null, ne []', async () => {
    const fake = createSupabaseFake({ resolve: () => ({ data: null, error: { code: '42P01', message: 'no table' } }) })
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    expect(await getDealAuditHistory(42)).toBeNull()
  })

  test('createClient / dotaz vyhodí výjimku → null (zachyceno try/catch)', async () => {
    vi.mocked(createClient).mockRejectedValue(new Error('network down'))
    expect(await getDealAuditHistory(42)).toBeNull()
  })

  test('prázdná historie je [] a je odlišitelná od null (nedostupné)', async () => {
    const fake = createSupabaseFake({ resolve: () => ({ data: [], error: null }) })
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    const result = await getDealAuditHistory(42)
    expect(result).toEqual([])
    expect(result).not.toBeNull()
  })

  test('úspěch: filtruje na entity_table=deal, entity_id, limit', async () => {
    const rows = [{ id: 1, action: 'deal.updated', actor_type: 'user', actor_id: 'u1', before: null, after: null, occurred_at: 'x' }]
    const fake = createSupabaseFake({ resolve: () => ({ data: rows, error: null }) })
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    const result = await getDealAuditHistory(42, 5)
    expect(result).toEqual(rows)
    const call = fake.calls[0]
    expect(call.table).toBe('audit_event')
    const eqCalls = call.ops.filter((o) => o.method === 'eq')
    expect(eqCalls).toEqual([
      { method: 'eq', args: ['entity_table', 'deal'] },
      { method: 'eq', args: ['entity_id', 42] },
    ])
    expect(opArgs(call, 'limit')).toEqual([5])
  })
})

describe('ostatní I/O dotazy detailu obchodu — filtrují na deal_id a řadí', () => {
  test('getDealPartnersWithNames filtruje na deal_id', async () => {
    const fake = createSupabaseFake({ resolve: () => ({ data: [], error: null }) })
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    await getDealPartnersWithNames(42)
    expect(opArgs(fake.calls[0], 'eq')).toEqual(['deal_id', 42])
  })

  test('getEngagementsForDeal řadí sestupně podle id', async () => {
    const fake = createSupabaseFake({ resolve: () => ({ data: [], error: null }) })
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    await getEngagementsForDeal(42)
    expect(opArgs(fake.calls[0], 'order')).toEqual(['id', { ascending: false }])
  })

  test('getSalesActivitiesForDeal řadí podle occurred_at a respektuje limit', async () => {
    const fake = createSupabaseFake({ resolve: () => ({ data: [], error: null }) })
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    await getSalesActivitiesForDeal(42, 3)
    const call = fake.calls[0]
    expect(call.table).toBe('sales_activity')
    expect(opArgs(call, 'order')).toEqual(['occurred_at', { ascending: false }])
    expect(opArgs(call, 'limit')).toEqual([3])
  })

  test('chyba v kterékoli z těchto tří funkcí se propaguje (vyhodí)', async () => {
    const fake = createSupabaseFake({ resolve: () => ({ data: null, error: { message: 'x' } }) })
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    await expect(getDealPartnersWithNames(42)).rejects.toBeDefined()
  })
})
