import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { tryRequireUser } from '@/lib/auth/requireUser'
import { revalidatePath } from 'next/cache'
import {
  createAllocation,
  createEngagementAllocation,
  endAllocation,
  setMemberCapacity,
  updateAllocation,
} from '@/domain/delivery/actions/capacity'
import { createSupabaseFake, hasOp, opArgs, type QueryCall, type QueryResult } from './helpers/supabaseFake'

// domain/delivery/actions/capacity.ts — alokace a kapacita (0062). Hlídáme
// AAL2 bránu, validaci před DB, pevný cíl u dodávky (a její firmu),
// „ukončit" podle pražského dne, RPC pro kapacitu a klidné hlášky před
// migrací.

vi.mock('@/lib/auth/requireUser', () => ({
  requireUser: vi.fn(),
  tryRequireUser: vi.fn(),
  AUTH_ERROR_MESSAGE: 'auth',
}))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/pragueDate', async (orig) => ({
  ...(await orig<typeof import('@/lib/pragueDate')>()),
  pragueToday: vi.fn(() => '2026-09-28'),
}))

const USER = { id: '00000000-0000-4000-8000-000000000001' }
const OTHER = '00000000-0000-4000-8000-000000000002'
const MISSING_MIGRATION = 'Kapacity ještě nejsou dostupné — čekají na migraci 0062.'

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(tryRequireUser).mockResolvedValue(USER as never)
})

function fd(entries: Record<string, string>): FormData {
  const f = new FormData()
  for (const [k, v] of Object.entries(entries)) f.append(k, v)
  return f
}

type Route = (call: QueryCall) => QueryResult | undefined
function fakeWith(routes: Route[] = [], rpc?: (name: string, args: unknown) => QueryResult) {
  const fake = createSupabaseFake({
    resolve: (call) => {
      for (const r of routes) {
        const out = r(call)
        if (out) return out
      }
      return { data: null, error: null }
    },
    rpc,
  })
  vi.mocked(createClient).mockResolvedValue(fake.client as never)
  return fake
}

const isWrite = (c: QueryCall) => hasOp(c, 'insert') || hasOp(c, 'update') || hasOp(c, 'delete')
const allocationRow = (row: Record<string, unknown>): Route => (c) =>
  c.table === 'allocation' && !isWrite(c) ? { data: { id: 5, member_id: USER.id, ...row }, error: null } : undefined
const writeOk: Route = (c) => (isWrite(c) ? { data: [{ id: 5 }], error: null } : undefined)
const writeFails = (code: string): Route => (c) => (isWrite(c) ? { data: null, error: { code, message: 'x' } } : undefined)
const engagementOf = (accountId: number): Route => (c) =>
  c.table === 'engagement' ? { data: { id: 2, account_id: accountId }, error: null } : undefined

const validForm = {
  member_id: USER.id,
  target: 'engagement:2',
  hours_per_week: '12',
  starts_on: '2026-10-01',
  ends_on: '',
  substitute_id: OTHER,
  note: 'Workshopy',
}

describe('AAL2 brána — bez uživatele se nic nečte ani nezapíše', () => {
  const calls: [string, () => Promise<unknown>][] = [
    ['createAllocation', () => createAllocation(undefined, fd(validForm))],
    ['createEngagementAllocation', () => createEngagementAllocation(1, 2, undefined, fd(validForm))],
    ['updateAllocation', () => updateAllocation(5, undefined, fd(validForm))],
    ['endAllocation', () => endAllocation(5)],
    ['setMemberCapacity', () => setMemberCapacity(USER.id, undefined, fd({ weekly_capacity_hours: '30' }))],
  ]
  for (const [name, run] of calls) {
    test(name, async () => {
      vi.mocked(tryRequireUser).mockResolvedValue(null)
      const fake = fakeWith()
      expect(await run()).toEqual({ success: false, error: 'auth' })
      expect(fake.calls).toHaveLength(0)
      expect(fake.rpc).not.toHaveBeenCalled()
      expect(tryRequireUser).toHaveBeenCalledWith({ aal2: true })
    })
  }
})

describe('createAllocation', () => {
  test('neplatný formulář se DB nedotkne', async () => {
    const fake = fakeWith()
    const r = await createAllocation(undefined, fd({ ...validForm, target: '', hours_per_week: '0' }))
    expect(r.success).toBe(false)
    expect(r.fieldErrors?.target).toBeTruthy()
    expect(r.fieldErrors?.hours_per_week).toBeTruthy()
    expect(fake.calls).toHaveLength(0)
  })

  test('platná alokace se vloží bez created_by a revaliduje stránky', async () => {
    const fake = fakeWith([writeOk])
    expect(await createAllocation(undefined, fd({ ...validForm, target: 'case:9' }))).toEqual({ success: true })
    const insert = fake.calls.find((c) => hasOp(c, 'insert'))!
    expect(insert.table).toBe('allocation')
    expect(opArgs(insert, 'insert')?.[0]).toEqual({
      member_id: USER.id,
      engagement_id: null,
      work_case_id: 9,
      hours_per_week: 12,
      starts_on: '2026-10-01',
      ends_on: null,
      substitute_id: OTHER,
      note: 'Workshopy',
    })
    expect(revalidatePath).toHaveBeenCalledWith('/cockpit/kapacity')
    expect(revalidatePath).toHaveBeenCalledWith('/cockpit/clients/[id]/engagements/[engagementId]/edit', 'page')
  })

  test('chybějící tabulka (před 0062) → klidná hláška', async () => {
    fakeWith([writeFails('42P01')])
    expect(await createAllocation(undefined, fd(validForm))).toEqual({ success: false, error: MISSING_MIGRATION })
  })

  test('CHECK a FK z databáze → srozumitelná česká věta, ne surová chyba', async () => {
    fakeWith([writeFails('23514')])
    const check = await createAllocation(undefined, fd(validForm))
    expect(check.error).toMatch(/neprošly kontrolou/)
    fakeWith([writeFails('23503')])
    const fk = await createAllocation(undefined, fd(validForm))
    expect(fk.error).toMatch(/už neexistuje/)
    expect(revalidatePath).not.toHaveBeenCalled()
  })
})

describe('createEngagementAllocation', () => {
  test('neplatná ID', async () => {
    const fake = fakeWith()
    expect(await createEngagementAllocation(0, 2, undefined, fd(validForm))).toEqual({ success: false, error: 'Neplatné ID.' })
    expect(fake.calls).toHaveLength(0)
  })

  test('dodávka jiné firmy → nenalezeno, žádný insert', async () => {
    const fake = fakeWith([engagementOf(99)])
    expect(await createEngagementAllocation(1, 2, undefined, fd(validForm))).toEqual({
      success: false,
      error: 'Dodávka nebyla nalezena.',
    })
    expect(fake.calls.some((c) => hasOp(c, 'insert'))).toBe(false)
  })

  test('cíl je vždy tahle dodávka, i když formulář pošle jiný', async () => {
    const fake = fakeWith([engagementOf(1), writeOk])
    const form = { ...validForm, target: 'case:77' }
    expect(await createEngagementAllocation(1, 2, undefined, fd(form))).toEqual({ success: true })
    const insert = fake.calls.find((c) => hasOp(c, 'insert'))!
    expect(opArgs(insert, 'insert')?.[0]).toMatchObject({ engagement_id: 2, work_case_id: null })
  })

  test('formulář bez pole target stačí', async () => {
    fakeWith([engagementOf(1), writeOk])
    const { target: _t, ...form } = validForm
    void _t
    expect(await createEngagementAllocation(1, 2, undefined, fd(form))).toEqual({ success: true })
  })
})

describe('updateAllocation', () => {
  const edit = { hours_per_week: '8', starts_on: '2026-09-01', ends_on: '2026-10-31', substitute_id: '', note: '' }

  test('neexistující alokace', async () => {
    const fake = fakeWith()
    expect(await updateAllocation(5, undefined, fd(edit))).toEqual({ success: false, error: 'Alokace nebyla nalezena.' })
    expect(fake.calls.some(isWrite)).toBe(false)
  })

  test('zástup nesmí být člověk z řádku alokace', async () => {
    const fake = fakeWith([allocationRow({ member_id: OTHER, starts_on: '2026-09-01', ends_on: null })])
    const r = await updateAllocation(5, undefined, fd({ ...edit, substitute_id: OTHER }))
    expect(r.fieldErrors?.substitute_id).toBeTruthy()
    expect(fake.calls.some(isWrite)).toBe(false)
  })

  test('mění jen hodiny, období, zástup a poznámku', async () => {
    const fake = fakeWith([allocationRow({ starts_on: '2026-09-01', ends_on: null }), writeOk])
    expect(await updateAllocation(5, undefined, fd({ ...edit, member_id: OTHER, target: 'case:3' }))).toEqual({ success: true })
    const update = fake.calls.find((c) => hasOp(c, 'update'))!
    expect(opArgs(update, 'update')?.[0]).toEqual({
      hours_per_week: 8,
      starts_on: '2026-09-01',
      ends_on: '2026-10-31',
      substitute_id: null,
      note: null,
    })
    expect(opArgs(update, 'eq')).toEqual(['id', 5])
  })

  test('před 0062 → klidná hláška', async () => {
    fakeWith([(c) => (c.table === 'allocation' ? { data: null, error: { code: 'PGRST205', message: 'x' } } : undefined)])
    expect(await updateAllocation(5, undefined, fd(edit))).toEqual({ success: false, error: MISSING_MIGRATION })
  })
})

describe('endAllocation (dnes = 2026-09-28 v Praze)', () => {
  test('běžící alokace končí dneškem', async () => {
    const fake = fakeWith([allocationRow({ starts_on: '2026-09-01', ends_on: null }), writeOk])
    expect(await endAllocation(5)).toEqual({ success: true })
    const update = fake.calls.find((c) => hasOp(c, 'update'))!
    expect(opArgs(update, 'update')?.[0]).toEqual({ ends_on: '2026-09-28' })
    expect(revalidatePath).toHaveBeenCalledWith('/cockpit/kapacity')
  })

  test('nezačatá alokace se smaže', async () => {
    const fake = fakeWith([allocationRow({ starts_on: '2026-10-05', ends_on: null }), writeOk])
    expect(await endAllocation(5)).toEqual({ success: true })
    expect(fake.calls.some((c) => hasOp(c, 'delete'))).toBe(true)
    expect(fake.calls.some((c) => hasOp(c, 'update'))).toBe(false)
  })

  test('skončená alokace se nemění', async () => {
    const fake = fakeWith([allocationRow({ starts_on: '2026-09-01', ends_on: '2026-09-20' })])
    expect(await endAllocation(5)).toEqual({ success: false, error: 'Alokace už skončila.' })
    expect(fake.calls.some(isWrite)).toBe(false)
  })

  test('neplatné ID se DB nedotkne', async () => {
    const fake = fakeWith()
    expect(await endAllocation(-1)).toEqual({ success: false, error: 'Neplatné ID.' })
    expect(fake.calls).toHaveLength(0)
  })
})

describe('setMemberCapacity', () => {
  test('neplatný člověk nebo hodiny → bez volání RPC', async () => {
    const fake = fakeWith()
    expect(await setMemberCapacity('nope', undefined, fd({ weekly_capacity_hours: '30' }))).toEqual({
      success: false,
      error: 'Neplatný člen týmu.',
    })
    const r = await setMemberCapacity(OTHER, undefined, fd({ weekly_capacity_hours: '81' }))
    expect(r.fieldErrors?.weekly_capacity_hours).toBeTruthy()
    expect(fake.rpc).not.toHaveBeenCalled()
  })

  test('volá set_weekly_capacity s čísly z formuláře', async () => {
    const fake = fakeWith([], () => ({ data: 32.5, error: null }))
    expect(await setMemberCapacity(OTHER, undefined, fd({ weekly_capacity_hours: '32,5' }))).toEqual({ success: true })
    expect(fake.rpc).toHaveBeenCalledWith('set_weekly_capacity', { p_member_id: OTHER, p_hours: 32.5 })
    expect(fake.calls).toHaveLength(0)
    expect(revalidatePath).toHaveBeenCalledWith('/cockpit/kapacity')
  })

  test('chybějící funkce (před 0062) a zákaz z DB', async () => {
    fakeWith([], () => ({ data: null, error: { code: 'PGRST202', message: 'x' } }))
    expect(await setMemberCapacity(OTHER, undefined, fd({ weekly_capacity_hours: '30' }))).toEqual({
      success: false,
      error: MISSING_MIGRATION,
    })
    fakeWith([], () => ({ data: null, error: { code: '42501', message: 'x' } }))
    expect(await setMemberCapacity(OTHER, undefined, fd({ weekly_capacity_hours: '30' }))).toEqual({
      success: false,
      error: 'Kapacitu kolegy smí měnit jen vedení nebo admin.',
    })
  })
})
