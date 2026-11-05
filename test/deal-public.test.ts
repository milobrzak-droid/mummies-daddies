import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { findDealPublic, getDealPublic, isMissingFunction, listDealPublic, WON_DEAL_STAGE } from '@/lib/queries/dealPublic'
import { createSupabaseFake, hasOp, opArgs, type QueryCall, type QueryResult } from './helpers/supabaseFake'

// lib/queries/dealPublic.ts — úzké okno na obchody pro dodávkové role (0058).
// Fallback na přímé čtení deal smí nastat JEN když rpc ještě neexistuje;
// jiná chyba (např. 42501) se nesmí obejít čtením tabulky.

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

const ok = (data: unknown): QueryResult => ({ data, error: null })

function fake(rpc: () => QueryResult, table: (c: QueryCall) => QueryResult = () => ok([])) {
  const f = createSupabaseFake({ rpc, resolve: table })
  vi.mocked(createClient).mockResolvedValue(f.client as never)
  return f
}
type Db = Parameters<typeof listDealPublic>[0]

beforeEach(() => vi.clearAllMocks())

test('isMissingFunction: kódy PostgREST/Postgres i text hlášky', () => {
  expect(isMissingFunction({ code: 'PGRST202' })).toBe(true)
  expect(isMissingFunction({ code: '42883' })).toBe(true)
  expect(isMissingFunction({ message: 'Could not find the function public.deal_public(p_account_id) in the schema cache' })).toBe(true)
  expect(isMissingFunction({ message: 'function deal_public(bigint) does not exist' })).toBe(true)
  for (const e of [null, undefined, {}, { code: '42501', message: 'permission denied for function deal_public' }, { code: 'PGRST116' }]) {
    expect(isMissingFunction(e)).toBe(false)
  }
})

describe('listDealPublic', () => {
  test('rpc vrátí řádky → jen id, firma, název, vyhráno; tabulka deal se nečte', async () => {
    const f = fake(() => ok([{ id: '3', account_id: 2, title: 'Pilot', is_won: true, amount_one_time: 999 }]))
    const r = await listDealPublic(f.client as unknown as Db, 2)
    expect(r).toEqual({ ok: true, rows: [{ id: 3, account_id: 2, title: 'Pilot', is_won: true }] })
    expect(f.rpc).toHaveBeenCalledWith('deal_public', { p_account_id: 2 })
    expect(f.from).not.toHaveBeenCalled()
  })

  test('rpc vrátí null data → prázdný seznam', async () => {
    const f = fake(() => ok(null))
    expect(await listDealPublic(f.client as unknown as Db, null)).toEqual({ ok: true, rows: [] })
  })

  test('jiná chyba rpc (oprávnění) → chyba, žádný fallback na tabulku', async () => {
    const err = { code: '42501', message: 'permission denied' }
    const f = fake(() => ({ data: null, error: err }))
    expect(await listDealPublic(f.client as unknown as Db, 1)).toEqual({ ok: false, error: err })
    expect(f.from).not.toHaveBeenCalled()
  })

  test('rpc chybí (před 0058) → čte deal s filtrem firmy a „vyhráno" odvodí z fáze', async () => {
    const f = fake(
      () => ({ data: null, error: { code: 'PGRST202' } }),
      () => ok([
        { id: 1, account_id: 5, title: 'A', stage: WON_DEAL_STAGE },
        { id: 2, account_id: 5, title: null, stage: 'nabídka' },
      ]),
    )
    const r = await listDealPublic(f.client as unknown as Db, 5)
    expect(r).toEqual({ ok: true, rows: [
      { id: 1, account_id: 5, title: 'A', is_won: true },
      { id: 2, account_id: 5, title: '', is_won: false },
    ] })
    const call = f.calls[0]
    expect(call.table).toBe('deal')
    expect(opArgs(call, 'select')).toEqual(['id, account_id, title, stage'])
    expect(opArgs(call, 'eq')).toEqual(['account_id', 5])
  })

  test('fallback pro všechny firmy nefiltruje a chybu čtení vrátí', async () => {
    const err = { code: 'XX000' }
    const f = fake(() => ({ data: null, error: { code: '42883' } }), () => ({ data: null, error: err }))
    expect(await listDealPublic(f.client as unknown as Db, null)).toEqual({ ok: false, error: err })
    expect(hasOp(f.calls[0], 'eq')).toBe(false)
  })
})

describe('findDealPublic a getDealPublic', () => {
  test('najde obchod jen mezi obchody dané firmy', async () => {
    const f = fake(() => ok([{ id: 9, account_id: 2, title: 'X', is_won: false }]))
    const db = f.client as unknown as Db
    expect(await findDealPublic(db, 2, 9)).toEqual({ ok: true, row: { id: 9, account_id: 2, title: 'X', is_won: false } })
    expect(await findDealPublic(db, 2, 10)).toEqual({ ok: true, row: null })
  })

  test('findDealPublic propaguje chybu', async () => {
    const f = fake(() => ({ data: null, error: { code: '42501' } }))
    expect(await findDealPublic(f.client as unknown as Db, 2, 9)).toEqual({ ok: false, error: { code: '42501' } })
  })

  test('getDealPublic: řádky, nebo vyhodí chybu', async () => {
    fake(() => ok([{ id: 1, account_id: 1, title: 'T', is_won: false }]))
    expect(await getDealPublic(1)).toHaveLength(1)
    fake(() => ({ data: null, error: { code: '42501', message: 'denied' } }))
    await expect(getDealPublic(1)).rejects.toEqual({ code: '42501', message: 'denied' })
  })
})
