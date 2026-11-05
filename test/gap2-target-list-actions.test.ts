import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { tryRequireUser } from '@/lib/auth/requireUser'
import { revalidatePath } from 'next/cache'
import { addTargetListItem, createTargetList, setTargetItemStatus } from '@/domain/crm/actions/targetLists'
import { createSupabaseFake, hasOp, opArgs, type QueryCall, type QueryResult } from './helpers/supabaseFake'
import { ACCOUNT_OPTED_OUT_MESSAGE, CONTACT_OPTED_OUT_MESSAGE } from '@/domain/crm/outreachContacts'

// domain/crm/actions/targetLists.ts — server akce pro cílové seznamy.
// Testujeme brány/validaci a hlavně dvě věci s dopadem na data:
// 1) optimistický zámek na setTargetItemStatus (.eq('status', item.status))
//    musí zabránit dvojímu zápisu aktivity při souběžné změně
// 2) addTargetListItem musí odmítnout kontakt, který nepatří vybrané firmě

vi.mock('@/lib/auth/requireUser', () => ({
  requireUser: vi.fn(),
  tryRequireUser: vi.fn(),
  AUTH_ERROR_MESSAGE: 'auth',
}))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

beforeEach(() => vi.clearAllMocks())

function fd(entries: Record<string, string>): FormData {
  const f = new FormData()
  for (const [k, v] of Object.entries(entries)) f.append(k, v)
  return f
}

describe('brána (AAL2) — bez uživatele nic nezapíše', () => {
  test('createTargetList', async () => {
    vi.mocked(tryRequireUser).mockResolvedValue(null)
    const fake = createSupabaseFake()
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    const r = await createTargetList(undefined, fd({ name: 'A', segment: 'B', rationale: 'C' }))
    expect(r).toEqual({ success: false, error: 'auth' })
    expect(fake.calls).toHaveLength(0)
  })

  test('addTargetListItem', async () => {
    vi.mocked(tryRequireUser).mockResolvedValue(null)
    const fake = createSupabaseFake()
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    const r = await addTargetListItem(undefined, fd({ list_id: '1', account_id: '2', reason: 'x' }))
    expect(r).toEqual({ success: false, error: 'auth' })
    expect(fake.calls).toHaveLength(0)
  })

  test('setTargetItemStatus', async () => {
    vi.mocked(tryRequireUser).mockResolvedValue(null)
    const fake = createSupabaseFake()
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    const r = await setTargetItemStatus(1, 'osloveno')
    expect(r).toEqual({ success: false, error: 'auth' })
    expect(fake.calls).toHaveLength(0)
  })
})

describe('setTargetItemStatus — validace id/status', () => {
  beforeEach(() => {
    vi.mocked(tryRequireUser).mockResolvedValue({ id: 'user-1' } as never)
  })

  test('neplatné itemId (0, záporné, desetinné) se vůbec nedotkne DB', async () => {
    const fake = createSupabaseFake()
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    expect(await setTargetItemStatus(0, 'osloveno')).toEqual({ success: false, error: 'Neplatný požadavek.' })
    expect(await setTargetItemStatus(-1, 'osloveno')).toEqual({ success: false, error: 'Neplatný požadavek.' })
    expect(await setTargetItemStatus(1.5, 'osloveno')).toEqual({ success: false, error: 'Neplatný požadavek.' })
    expect(fake.calls).toHaveLength(0)
  })

  test('neplatný stav (mimo enum) se vůbec nedotkne DB', async () => {
    const fake = createSupabaseFake()
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    expect(await setTargetItemStatus(1, 'neexistuje' as never)).toEqual({ success: false, error: 'Neplatný požadavek.' })
    expect(fake.calls).toHaveLength(0)
  })

  test('položka neexistuje → chyba, žádný update', async () => {
    const fake = createSupabaseFake({ resolve: () => ({ data: null, error: null }) })
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    expect(await setTargetItemStatus(1, 'osloveno')).toEqual({ success: false, error: 'Položka neexistuje.' })
    expect(fake.calls.some((c) => hasOp(c, 'update'))).toBe(false)
  })
})

describe('setTargetItemStatus — optimistický zámek proti dvojí aktivitě', () => {
  const ITEM = {
    id: 1, list_id: 10, account_id: 7, contact_id: 3, reason: 'Roste',
    status: 'navrzeno', target_list: { name: 'Výroba Q4' },
  }

  function setupFake(updateResult: QueryResult) {
    const fake = createSupabaseFake({
      resolve: (call: QueryCall) => {
        if (call.table === 'target_list_item') {
          return hasOp(call, 'update') ? updateResult : { data: ITEM, error: null }
        }
        if (call.table === 'sales_activity') return { data: [{ id: 99 }], error: null }
        return { data: null, error: null }
      },
    })
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    return fake
  }

  beforeEach(() => {
    vi.mocked(tryRequireUser).mockResolvedValue({ id: 'user-1' } as never)
  })

  test('souběžná změna (update nic nevrátí) zabrání zápisu aktivity', async () => {
    const fake = setupFake({ data: [], error: null })
    const r = await setTargetItemStatus(1, 'osloveno')
    expect(r).toEqual({ success: false, error: 'Stav se mezitím změnil — obnov stránku.' })
    // update proběhl podmíněně na starý stav...
    const updateCall = fake.calls.find((c) => hasOp(c, 'update'))!
    expect(updateCall.ops).toContainEqual({ method: 'eq', args: ['status', 'navrzeno'] })
    // ...ale aktivita se NIKDY nezapsala
    expect(fake.calls.some((c) => c.table === 'sales_activity')).toBe(false)
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  test('normální přechod zapíše update i jednu aktivitu, revaliduje cesty', async () => {
    const fake = setupFake({ data: [{ id: 1 }], error: null })
    const r = await setTargetItemStatus(1, 'osloveno')
    expect(r).toEqual({ success: true })
    const activityCall = fake.calls.find((c) => c.table === 'sales_activity')
    expect(activityCall).toBeDefined()
    expect(hasOp(activityCall!, 'insert')).toBe(true)
    expect(fake.calls.filter((c) => c.table === 'sales_activity')).toHaveLength(1)
    expect(revalidatePath).toHaveBeenCalledWith('/cockpit/aktivity')
    expect(revalidatePath).toHaveBeenCalledWith('/cockpit/clients/7')
    expect(revalidatePath).toHaveBeenCalledWith('/cockpit/cilove-seznamy/10')
    expect(revalidatePath).toHaveBeenCalledWith('/cockpit/cilove-seznamy')
  })

  test('přechod bez aktivity (např. vyřazeno) update zapíše, ale sales_activity ne', async () => {
    const fake = setupFake({ data: [{ id: 1 }], error: null })
    const r = await setTargetItemStatus(1, 'vyrazeno')
    expect(r).toEqual({ success: true })
    expect(fake.calls.some((c) => c.table === 'sales_activity')).toBe(false)
  })
})

describe('addTargetListItem — kontakt musí patřit vybrané firmě', () => {
  beforeEach(() => {
    vi.mocked(tryRequireUser).mockResolvedValue({ id: 'user-1' } as never)
  })

  test('kontakt patří jiné firmě → fieldErrors, žádný insert', async () => {
    const fake = createSupabaseFake({
      resolve: (call: QueryCall) => {
        if (call.table === 'contact') return { data: { account_id: 999 }, error: null }
        return { data: null, error: null }
      },
    })
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    const r = await addTargetListItem(undefined, fd({ list_id: '1', account_id: '7', reason: 'x', contact_id: '3' }))
    expect(r).toEqual({ success: false, fieldErrors: { contact_id: 'Kontakt nepatří vybrané firmě.' } })
    expect(fake.calls.some((c) => c.table === 'target_list_item')).toBe(false)
  })

  test('kontakt neexistuje (maybeSingle → null) → stejná chyba, žádný insert', async () => {
    const fake = createSupabaseFake({
      resolve: (call: QueryCall) => {
        if (call.table === 'contact') return { data: null, error: null }
        return { data: null, error: null }
      },
    })
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    const r = await addTargetListItem(undefined, fd({ list_id: '1', account_id: '7', reason: 'x', contact_id: '3' }))
    expect(r).toEqual({ success: false, fieldErrors: { contact_id: 'Kontakt nepatří vybrané firmě.' } })
    expect(fake.calls.some((c) => c.table === 'target_list_item')).toBe(false)
  })

  test('kontakt patří správné firmě → insert proběhne, cesty se revalidují', async () => {
    const fake = createSupabaseFake({
      resolve: (call: QueryCall) => {
        if (call.table === 'contact') return { data: { account_id: 7 }, error: null }
        if (call.table === 'target_list_item') return { data: null, error: null }
        return { data: null, error: null }
      },
    })
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    const r = await addTargetListItem(undefined, fd({ list_id: '1', account_id: '7', reason: 'x', contact_id: '3' }))
    expect(r).toEqual({ success: true })
    const insertCall = fake.calls.find((c) => c.table === 'target_list_item' && hasOp(c, 'insert'))
    expect(insertCall).toBeDefined()
    expect(revalidatePath).toHaveBeenCalledWith('/cockpit/cilove-seznamy/1')
  })

  test('bez contact_id se kontrola kontaktu vůbec neprovádí', async () => {
    const fake = createSupabaseFake({
      resolve: (call: QueryCall) => {
        if (call.table === 'target_list_item') return { data: null, error: null }
        return { data: null, error: null }
      },
    })
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    const r = await addTargetListItem(undefined, fd({ list_id: '1', account_id: '7', reason: 'x' }))
    expect(r).toEqual({ success: true })
    // Kontakt podle id se nečte; kontakty firmy ano (nesouhlas s oslovením, 0087).
    const byId = (c: QueryCall) => c.table === 'contact' && c.ops.some((o) => o.method === 'eq' && o.args[0] === 'id')
    expect(fake.calls.some(byId)).toBe(false)
  })

  test('duplicitní firma v seznamu (23505) → srozumitelná chyba', async () => {
    const fake = createSupabaseFake({
      resolve: (call: QueryCall) => {
        if (call.table === 'target_list_item') return { data: null, error: { code: '23505' } }
        return { data: null, error: null }
      },
    })
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    const r = await addTargetListItem(undefined, fd({ list_id: '1', account_id: '7', reason: 'x' }))
    expect(r).toEqual({ success: false, fieldErrors: { account_id: 'Firma už v seznamu je.' } })
  })
})

describe('nesouhlas s oslovením (0087): do seznamu ani k oslovení', () => {
  beforeEach(() => {
    vi.mocked(tryRequireUser).mockResolvedValue({ id: 'user-1' } as never)
  })

  // Kontakt podle id (maybeSingle) vs. kontakty firmy (seznam pro souhrn).
  const isById = (c: QueryCall) => c.ops.some((o) => o.method === 'eq' && o.args[0] === 'id')
  function world(w: { main?: Record<string, unknown> | null; people?: Record<string, unknown>[]; missingColumn?: boolean; item?: Record<string, unknown> }) {
    const fake = createSupabaseFake({
      resolve: (call: QueryCall) => {
        if (call.table === 'contact') {
          const cols = String(opArgs(call, 'select')?.[0] ?? '')
          if (w.missingColumn && cols.includes('do_not_contact')) return { data: null, error: { code: '42703', message: 'column contact.do_not_contact does not exist' } }
          return isById(call) ? { data: w.main ?? null, error: null } : { data: w.people ?? [], error: null }
        }
        if (call.table === 'account') return { data: [{ id: 7, notes: null }], error: null }
        if (call.table === 'target_list_item') {
          if (hasOp(call, 'update')) return { data: [{ id: 1 }], error: null }
          return { data: w.item ?? null, error: null }
        }
        return { data: [{ id: 99 }], error: null }
      },
    })
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    return fake
  }
  const inserted = (fake: ReturnType<typeof world>) => fake.calls.some((c) => c.table === 'target_list_item' && hasOp(c, 'insert'))

  test('hlavní kontakt se zaškrtnutým nesouhlasem → chyba pole, žádný insert', async () => {
    const fake = world({ main: { account_id: 7, notes: null, do_not_contact: true } })
    const r = await addTargetListItem(undefined, fd({ list_id: '1', account_id: '7', reason: 'x', contact_id: '3' }))
    expect(r).toEqual({ success: false, fieldErrors: { contact_id: CONTACT_OPTED_OUT_MESSAGE } })
    expect(inserted(fake)).toBe(false)
  })

  test('poznámka „nekontaktovat" je druhá pojistka i bez migrace 0087', async () => {
    const fake = world({ main: { account_id: 7, notes: 'Nekontaktovat, řekl jasně.' }, missingColumn: true })
    const r = await addTargetListItem(undefined, fd({ list_id: '1', account_id: '7', reason: 'x', contact_id: '3' }))
    expect(r).toEqual({ success: false, fieldErrors: { contact_id: CONTACT_OPTED_OUT_MESSAGE } })
    expect(inserted(fake)).toBe(false)
  })

  test('firma, kde nesouhlasí všichni → chyba u firmy', async () => {
    const fake = world({ people: [{ account_id: 7, notes: null, do_not_contact: true }] })
    const r = await addTargetListItem(undefined, fd({ list_id: '1', account_id: '7', reason: 'x' }))
    expect(r).toEqual({ success: false, fieldErrors: { account_id: ACCOUNT_OPTED_OUT_MESSAGE } })
    expect(inserted(fake)).toBe(false)
  })

  test('někdo u firmy nesouhlasí, ale hlavní kontakt ano → přidá se', async () => {
    const fake = world({
      main: { account_id: 7, notes: null, do_not_contact: false },
      people: [{ account_id: 7, notes: null, do_not_contact: true }, { account_id: 7, notes: null, do_not_contact: false }],
    })
    expect(await addTargetListItem(undefined, fd({ list_id: '1', account_id: '7', reason: 'x', contact_id: '3' }))).toEqual({ success: true })
    expect(inserted(fake)).toBe(true)
  })

  const ITEM = { id: 1, list_id: 10, account_id: 7, contact_id: 3, reason: 'Roste', status: 'navrzeno', target_list: { name: 'Q4' } }

  test('„Osloveno" u hlavního kontaktu s nesouhlasem neprojde: žádný update ani aktivita', async () => {
    const fake = world({ item: ITEM, main: { account_id: 7, notes: null, do_not_contact: true } })
    expect(await setTargetItemStatus(1, 'osloveno')).toEqual({ success: false, error: CONTACT_OPTED_OUT_MESSAGE })
    expect(fake.calls.some((c) => hasOp(c, 'update'))).toBe(false)
    expect(fake.calls.some((c) => c.table === 'sales_activity')).toBe(false)
  })

  test('vyřadit firmu s nesouhlasem jde vždy', async () => {
    world({ item: ITEM, main: { account_id: 7, notes: null, do_not_contact: true } })
    expect(await setTargetItemStatus(1, 'vyrazeno')).toEqual({ success: true })
  })
})

describe('createTargetList — validace formuláře', () => {
  test('neplatná data → fieldErrors, žádný insert', async () => {
    vi.mocked(tryRequireUser).mockResolvedValue({ id: 'user-1' } as never)
    const fake = createSupabaseFake()
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    const r = await createTargetList(undefined, fd({ name: '', segment: 'B', rationale: 'C' }))
    expect(r.success).toBe(false)
    expect(r).toHaveProperty('fieldErrors')
    expect(fake.calls).toHaveLength(0)
  })

  test('platná data → insert s owner_id i created_by, revaliduje /cilove-seznamy', async () => {
    vi.mocked(tryRequireUser).mockResolvedValue({ id: 'user-1' } as never)
    const fake = createSupabaseFake({ resolve: () => ({ data: null, error: null }) })
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    const r = await createTargetList(undefined, fd({ name: 'A', segment: 'B', rationale: 'C' }))
    expect(r).toEqual({ success: true })
    const insertCall = fake.calls.find((c) => hasOp(c, 'insert'))!
    const [payload] = insertCall.ops.find((o) => o.method === 'insert')!.args as [Record<string, unknown>]
    expect(payload).toMatchObject({ owner_id: 'user-1', created_by: 'user-1', name: 'A' })
    expect(revalidatePath).toHaveBeenCalledWith('/cockpit/cilove-seznamy')
  })
})
