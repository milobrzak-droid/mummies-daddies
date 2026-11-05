import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { tryRequireUser } from '@/lib/auth/requireUser'
import { findAccountOptions, findContactOptionsForAccount } from '@/domain/crm/actions/accountPicker'
import {
  ACCOUNT_OPTION_LIMIT, MISSING_ICO_PAGE_SIZE, getAccountOption, listAccountsMissingIco, searchAccountOptions,
} from '@/domain/crm/queries/accounts'
import { getOutreachQueue } from '@/domain/crm/queries/outreach'
import { getAccountRollup } from '@/lib/queries/dashboard'
import { createSupabaseFake, hasOp, opArgs, type QueryCall, type QueryResult } from './helpers/supabaseFake'

// Výběr firmy ve formulářích (AccountPicker → findAccountOptions) a další
// místa, kde se dřív tahala celá tabulka account: hledá se na serveru po
// 20, s escapovaným ILIKE, přes RLS klienta a za AAL2 guardem.

vi.mock('@/lib/auth/requireUser', () => ({
  requireUser: vi.fn(async () => ({ id: 'user-1' })),
  tryRequireUser: vi.fn(async () => ({ id: 'user-1' })),
  AUTH_ERROR_MESSAGE: 'auth',
}))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))

beforeEach(() => vi.clearAllMocks())

function setup(resolve: (call: QueryCall) => QueryResult = () => ({ data: [{ id: 1, name: 'Acme' }], error: null })) {
  const fake = createSupabaseFake({ resolve })
  vi.mocked(createClient).mockResolvedValue(fake.client as never)
  return fake
}

describe('searchAccountOptions / findAccountOptions', () => {
  test('jméno nebo IČO, escapované zástupné znaky, řazení a limit 20', async () => {
    const fake = setup()
    const r = await findAccountOptions('a_b%', null)
    expect(r).toEqual({ ok: true, options: [{ id: 1, name: 'Acme' }] })
    const call = fake.calls[0]
    expect(call.table).toBe('account')
    expect(opArgs(call, 'select')).toEqual(['id, name'])
    expect(opArgs(call, 'or')).toEqual(['name.ilike."%a\\\\_b\\\\%%",ico.ilike."%a\\\\_b\\\\%%"'])
    expect(call.ops.filter((o) => o.method === 'order').map((o) => o.args[0])).toEqual(['name', 'id'])
    expect(opArgs(call, 'limit')).toEqual([ACCOUNT_OPTION_LIMIT])
    expect(ACCOUNT_OPTION_LIMIT).toBe(20)
    expect(hasOp(call, 'neq')).toBe(false)
  })

  test('excludeId (vztah firmy) → neq id', async () => {
    const fake = setup()
    await findAccountOptions('acme', 12)
    expect(opArgs(fake.calls[0], 'neq')).toEqual(['id', 12])
  })

  test('prázdný dotaz → žádný dotaz do DB', async () => {
    const fake = setup()
    expect(await findAccountOptions('   ', null)).toEqual({ ok: true, options: [] })
    expect(fake.calls).toHaveLength(0)
  })

  test('bez přihlášení (AAL2) nic nenačte', async () => {
    vi.mocked(tryRequireUser).mockResolvedValueOnce(null)
    const fake = setup()
    expect(await findAccountOptions('acme', null)).toEqual({ ok: false, error: 'auth' })
    expect(tryRequireUser).toHaveBeenCalledWith({ aal2: true })
    expect(fake.calls).toHaveLength(0)
  })

  test('neplatný vstup (ne-řetězec, špatné excludeId) → chyba bez dotazu', async () => {
    const fake = setup()
    expect(await findAccountOptions({ evil: true }, null)).toEqual({ ok: false, error: 'Neplatný dotaz.' })
    expect(await findAccountOptions('acme', -1)).toEqual({ ok: false, error: 'Neplatný dotaz.' })
    expect(await findAccountOptions('x'.repeat(1000), null)).toEqual({ ok: false, error: 'Neplatný dotaz.' })
    expect(fake.calls).toHaveLength(0)
  })

  test('dlouhý dotaz se ořízne na 100 znaků', async () => {
    const fake = setup()
    await findAccountOptions('y'.repeat(150), null)
    expect(String(opArgs(fake.calls[0], 'or')?.[0])).toContain(`%${'y'.repeat(100)}%"`)
    expect(String(opArgs(fake.calls[0], 'or')?.[0])).not.toContain('y'.repeat(101))
  })

  test('chyba DB → obecná hláška, ne detail', async () => {
    setup(() => ({ data: null, error: { code: '42501', message: 'permission denied for table account' } }))
    const r = await findAccountOptions('acme', null)
    expect(r.ok).toBe(false)
    expect(JSON.stringify(r)).not.toContain('permission denied')
  })

  test('searchAccountOptions s vlastním limitem', async () => {
    const fake = setup()
    await searchAccountOptions('acme', { limit: 5 })
    expect(opArgs(fake.calls[0], 'limit')).toEqual([5])
  })
})

describe('findContactOptionsForAccount — kontakty jen zvolené firmy', () => {
  test('filtr account_id, úzký select, strop 200', async () => {
    const fake = setup(() => ({ data: [{ id: 5, full_name: 'Jan Novák' }], error: null }))
    const r = await findContactOptionsForAccount(7)
    expect(r).toEqual({ ok: true, options: [{ id: 5, full_name: 'Jan Novák' }] })
    expect(fake.calls[0].table).toBe('contact')
    expect(opArgs(fake.calls[0], 'select')).toEqual(['id, full_name'])
    expect(opArgs(fake.calls[0], 'eq')).toEqual(['account_id', 7])
    expect(opArgs(fake.calls[0], 'limit')).toEqual([200])
  })

  test('neplatné id → bez dotazu', async () => {
    const fake = setup()
    expect(await findContactOptionsForAccount('7; drop')).toEqual({ ok: false, error: 'Neplatné ID.' })
    expect(fake.calls).toHaveLength(0)
  })
})

describe('getAccountOption — předvyplnění z URL', () => {
  test('neplatné id (NaN, 0, záporné) → null bez dotazu', async () => {
    const fake = setup()
    expect(await getAccountOption(Number('abc'))).toBeNull()
    expect(await getAccountOption(0)).toBeNull()
    expect(await getAccountOption(-4)).toBeNull()
    expect(await getAccountOption(undefined)).toBeNull()
    expect(fake.calls).toHaveLength(0)
  })

  test('existující firma → id + name', async () => {
    const fake = setup(() => ({ data: { id: 3, name: 'Acme' }, error: null }))
    expect(await getAccountOption(3)).toEqual({ id: 3, name: 'Acme' })
    expect(opArgs(fake.calls[0], 'eq')).toEqual(['id', 3])
    expect(hasOp(fake.calls[0], 'maybeSingle')).toBe(true)
  })
})

describe('listAccountsMissingIco — /clients/doplnit-ico po stránkách', () => {
  const TOTAL = 610
  const resolve = (call: QueryCall): QueryResult => {
    const [, opts] = (opArgs(call, 'select') ?? []) as [string, { head?: boolean } | undefined]
    if (opts?.head) return { data: null, error: null, count: TOTAL }
    const [from, to] = opArgs(call, 'range') as [number, number]
    if (from >= TOTAL) return { data: null, error: { code: 'PGRST103', message: 'Requested range not satisfiable' } }
    return {
      data: Array.from({ length: Math.min(to, TOTAL - 1) - from + 1 }, (_, i) => ({ id: from + i + 1, name: `F${from + i}` })),
      error: null,
      count: TOTAL,
    }
  }

  test('jen jedna stránka (20) firem bez IČO — ne všech 610 do ARESu', async () => {
    const fake = setup(resolve)
    const r = await listAccountsMissingIco(2)
    expect(MISSING_ICO_PAGE_SIZE).toBe(20)
    expect(fake.calls).toHaveLength(1)
    expect(opArgs(fake.calls[0], 'or')).toEqual(['ico.is.null,ico.eq.""'])
    expect(opArgs(fake.calls[0], 'range')).toEqual([20, 39])
    expect(r.rows).toHaveLength(20)
    expect(r).toMatchObject({ total: 610, page: 2, pageCount: 31 })
  })

  test('stránka za koncem → poslední stránka', async () => {
    const fake = setup(resolve)
    const r = await listAccountsMissingIco(99)
    expect(fake.calls).toHaveLength(3)
    expect(opArgs(fake.calls[2], 'range')).toEqual([600, 619])
    expect(r).toMatchObject({ page: 31, pageCount: 31 })
    expect(r.rows).toHaveLength(10)
  })
})

describe('další místa bez celé tabulky', () => {
  test('fronta oslovování nenačítá firmy, kterým jsme nikdy nepsali', async () => {
    const fake = setup(() => ({ data: [], error: null }))
    await getOutreachQueue(new Date('2026-09-28T10:00:00Z'))
    const account = fake.calls.find((c) => c.table === 'account')!
    expect(opArgs(account, 'not')).toEqual(['last_outbound_at', 'is', null])
  })

  test('rollup pro /pipeline jen s nenulovou nasmlouvanou částkou', async () => {
    const fake = setup(() => ({ data: [], error: null }))
    await getAccountRollup()
    expect(fake.calls[0].table).toBe('v_account_rollup')
    expect(opArgs(fake.calls[0], 'neq')).toEqual(['contracted_one_time', 0])
  })
})
