import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { tryRequireUser } from '@/lib/auth/requireUser'
import { canCurrentUserSeeSales } from '@/lib/queries/access'
import { revalidatePath } from 'next/cache'
import { suggestTargetListItems } from '@/domain/crm/actions/targetLists'
import { SUGGEST_CAP } from '@/domain/crm/targetSegments'
import { createSupabaseFake, hasOp, opArgs, type QueryCall, type QueryResult } from './helpers/supabaseFake'

// suggestTargetListItems — „Navrhnout firmy podle segmentu" na detailu
// cílového seznamu. Hlídáme: bránu (AAL2 + obchodní role), idempotenci
// (firmy už v seznamu se přeskočí a vkládá se ON CONFLICT DO NOTHING,
// žádný update/delete položek), limit na kliknutí a vynechání klientů.

vi.mock('@/lib/auth/requireUser', () => ({
  requireUser: vi.fn(),
  tryRequireUser: vi.fn(),
  AUTH_ERROR_MESSAGE: 'auth',
}))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/queries/access', () => ({ canCurrentUserSeeSales: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
// Firma segmenty zatím nemá (outbound = fáze 2); akce se testuje s ukázkovými pravidly.
vi.mock('@/config', async (orig) => {
  const { COMPANY } = await orig<typeof import('@/config')>()
  const { TARGET_SEGMENTS_FIXTURE } = await import('./helpers/targetSegmentsFixture')
  return { COMPANY: { ...COMPANY, targetSegments: TARGET_SEGMENTS_FIXTURE } }
})

type Account = { id: number; name: string; industry: string | null; region: string | null; client_since?: string | null; is_reference?: boolean }

type World = {
  list?: { id: number; segment: string } | null
  listError?: unknown
  items?: { account_id: number; status?: string }[]
  accounts?: Account[]
  deals?: { account_id: number; stage: string }[]
  engagements?: { account_id: number }[]
  subscriptions?: { account_id: number }[]
  contacts?: { account_id: number; notes: string | null; do_not_contact?: boolean }[]
  upsert?: (rows: unknown[]) => QueryResult
}

// Stránkování: vrátí jen řádky z požadovaného .range(from, to).
function page(call: QueryCall, rows: unknown[]): QueryResult {
  const [from, to] = (opArgs(call, 'range') ?? [0, rows.length]) as [number, number]
  return { data: rows.slice(from, to + 1), error: null }
}

function setup(w: World) {
  const fake = createSupabaseFake({
    resolve: (call) => {
      switch (call.table) {
        case 'target_list':
          return { data: w.list === undefined ? { id: 10, segment: 'logistika-doprava' } : w.list, error: w.listError ?? null }
        case 'target_list_item': {
          if (hasOp(call, 'upsert')) {
            const [rows] = opArgs(call, 'upsert') as [unknown[]]
            return w.upsert ? w.upsert(rows) : { data: rows.map((_, i) => ({ id: 1000 + i })), error: null }
          }
          return page(call, w.items ?? [])
        }
        case 'account':
          return page(call, (w.accounts ?? []).map((a) => ({ client_since: null, is_reference: false, ...a })))
        case 'deal':
          return page(call, w.deals ?? [])
        case 'engagement':
          return page(call, w.engagements ?? [])
        case 'subscription':
          return page(call, w.subscriptions ?? [])
        case 'contact':
          return page(call, w.contacts ?? [])
        default:
          return { data: null, error: null }
      }
    },
  })
  vi.mocked(createClient).mockResolvedValue(fake.client as never)
  return fake
}

const upsertCall = (fake: ReturnType<typeof setup>) =>
  fake.calls.find((c) => c.table === 'target_list_item' && hasOp(c, 'upsert'))
const upsertedRows = (fake: ReturnType<typeof setup>) =>
  (opArgs(upsertCall(fake)!, 'upsert') as [Record<string, unknown>[]])[0]

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(tryRequireUser).mockResolvedValue({ id: 'user-1' } as never)
  vi.mocked(canCurrentUserSeeSales).mockResolvedValue(true)
})

describe('oprávnění', () => {
  test('bez AAL2 uživatele nic nečte ani nezapisuje', async () => {
    vi.mocked(tryRequireUser).mockResolvedValue(null)
    const fake = setup({})
    expect(await suggestTargetListItems(10)).toEqual({ success: false, error: 'auth' })
    expect(fake.calls).toHaveLength(0)
    expect(canCurrentUserSeeSales).not.toHaveBeenCalled()
  })

  test('vyžaduje AAL2', async () => {
    setup({})
    await suggestTargetListItems(10)
    expect(tryRequireUser).toHaveBeenCalledWith({ aal2: true })
  })

  test('neobchodní role (projekťák, lektor, partner) — odmítnuto, žádný dotaz', async () => {
    vi.mocked(canCurrentUserSeeSales).mockResolvedValue(false)
    const fake = setup({ accounts: [{ id: 1, name: 'A', industry: 'Logistika', region: null }] })
    const r = await suggestTargetListItems(10)
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/jen vedení nebo obchodník/)
    expect(fake.calls).toHaveLength(0)
  })

  test('neplatné id seznamu se DB vůbec nedotkne', async () => {
    const fake = setup({})
    for (const id of [0, -1, 1.5, Number.NaN]) {
      expect(await suggestTargetListItems(id)).toEqual({ success: false, error: 'Neplatný požadavek.' })
    }
    expect(fake.calls).toHaveLength(0)
  })
})

describe('seznam a pravidlo', () => {
  test('seznam neexistuje', async () => {
    const fake = setup({ list: null })
    expect(await suggestTargetListItems(10)).toEqual({ success: false, error: 'Seznam neexistuje.' })
    expect(upsertCall(fake)).toBeUndefined()
  })

  test('neaplikovaná 0048 → klidná hláška, žádný zápis', async () => {
    const fake = setup({ list: null, listError: { code: '42P01', message: 'relation "target_list" does not exist' } })
    const r = await suggestTargetListItems(10)
    expect(r).toEqual({ success: false, error: expect.stringContaining('čekají na migraci 0048') })
    expect(upsertCall(fake)).toBeUndefined()
  })

  test('segment bez pravidla → nápověda, kde pravidlo doplnit; nic se nečte ani nevkládá', async () => {
    const fake = setup({ list: { id: 10, segment: 'stavebnictvi' } })
    const r = await suggestTargetListItems(10)
    expect(r.success).toBe(false)
    expect(r.error).toContain('COMPANY.targetSegments')
    expect(fake.calls.map((c) => c.table)).toEqual(['target_list'])
  })
})

describe('vložení návrhů', () => {
  test('vloží odpovídající prospekty jako „navrzeno" s důvodem z pravidla', async () => {
    const fake = setup({
      accounts: [
        { id: 1, name: 'Spedice Alfa', industry: 'Logistika – spedice a přeprava', region: null },
        { id: 2, name: 'IT Beta', industry: 'IT – vývoj software', region: null },
      ],
    })
    const r = await suggestTargetListItems(10)
    expect(r).toEqual({ success: true, message: expect.stringContaining('Přidáno do návrhů: 1 firma') })
    expect(upsertedRows(fake)).toEqual([{
      list_id: 10, account_id: 1, reason: 'Obor: Logistika – spedice a přeprava', status: 'navrzeno', created_by: 'user-1',
    }])
    expect(revalidatePath).toHaveBeenCalledWith('/cockpit/cilove-seznamy/10')
    expect(revalidatePath).toHaveBeenCalledWith('/cockpit/cilove-seznamy')
  })

  test('výroba: region neověřen v důvodu, mimo region se nevloží', async () => {
    const fake = setup({
      list: { id: 11, segment: 'vyroba-praha' },
      accounts: [
        { id: 1, name: 'A', industry: 'Výroba – telekomunikační technika', region: null },
        { id: 2, name: 'B', industry: 'Automotive – spojovací a upevňovací prvky', region: 'Středočeský kraj' },
        { id: 3, name: 'C', industry: 'Výroba – nábytek', region: 'Zlínský kraj' },
      ],
    })
    const r = await suggestTargetListItems(11)
    expect(r.success).toBe(true)
    expect(upsertedRows(fake).map((x) => [x.account_id, x.reason])).toEqual([
      [2, 'Obor: Automotive – spojovací a upevňovací prvky; region: Středočeský kraj'],
      [1, 'Obor: Výroba – telekomunikační technika; region neověřen'],
    ])
    expect(r.message).toContain('Vynecháno: mimo region 1.')
  })

  // Formulář firmy (ARES lookup), nabídky a importy píšou do region obec
  // (sidlo.nazevObce), ne kraj — firma z Kladna nesmí vypadnout jako „mimo region".
  test('výroba: obec místo kraje — Kladno ověřené, neznámá obec neověřená, Brno mimo region', async () => {
    const fake = setup({
      list: { id: 11, segment: 'vyroba-praha' },
      accounts: [
        { id: 1, name: 'Kovo Kladno', industry: 'Výroba – kovovýroba', region: 'Kladno' },
        { id: 2, name: 'Lisovna Říčany', industry: 'Výroba – lisování plechů', region: 'Říčany' },
        { id: 3, name: 'Strojírna Brno', industry: 'Strojírenství – obráběcí stroje', region: 'Brno' },
      ],
    })
    const r = await suggestTargetListItems(11)
    expect(upsertedRows(fake).map((x) => [x.account_id, x.reason])).toEqual([
      [1, 'Obor: Výroba – kovovýroba; region: Kladno (Středočeský kraj)'],
      [2, 'Obor: Výroba – lisování plechů; region neověřen (Říčany)'],
    ])
    expect(r).toEqual({
      success: true,
      message: 'Přidáno do návrhů: 2 firmy (z toho bez ověřeného regionu 1). Vynecháno: mimo region 1.',
    })
  })

  test('klienti a rozjednané obchody se nenavrhují', async () => {
    const fake = setup({
      accounts: [
        { id: 1, name: 'Prospekt', industry: 'Logistika', region: null },
        { id: 2, name: 'Vyhraný obchod', industry: 'Logistika', region: null },
        { id: 3, name: 'Otevřený obchod', industry: 'Logistika', region: null },
        { id: 4, name: 'Dodávka', industry: 'Logistika', region: null },
        { id: 5, name: 'Předplatné', industry: 'Logistika', region: null },
        { id: 6, name: 'Klient od', industry: 'Logistika', region: null, client_since: '2024-05-01' },
        { id: 7, name: 'Prohraný obchod', industry: 'Logistika', region: null },
      ],
      deals: [{ account_id: 2, stage: 'vyhráno' }, { account_id: 3, stage: 'diagnostika' }, { account_id: 7, stage: 'prohráno' }],
      engagements: [{ account_id: 4 }],
      subscriptions: [{ account_id: 5 }],
    })
    const r = await suggestTargetListItems(10)
    // pořadí podle názvu (česky): „Prohraný obchod" < „Prospekt"
    expect(upsertedRows(fake).map((x) => x.account_id)).toEqual([7, 1])
    expect(r.message).toContain('klienti a rozjednané obchody 5')
    // předplatné: jen běžící (ended_on IS NULL)
    const sub = fake.calls.find((c) => c.table === 'subscription')!
    expect(sub.ops).toContainEqual({ method: 'is', args: ['ended_on', null] })
  })
})

describe('idempotence', () => {
  const accounts: Account[] = [
    { id: 1, name: 'A', industry: 'Logistika', region: null },
    { id: 2, name: 'B', industry: 'Logistika', region: null },
    { id: 3, name: 'C', industry: 'Logistika', region: null },
  ]

  test('firmy už v seznamu (v jakémkoli stavu) se přeskočí a nic se nepřepisuje', async () => {
    const fake = setup({ accounts, items: [{ account_id: 1, status: 'osloveno' }, { account_id: 2, status: 'vyrazeno' }] })
    const r = await suggestTargetListItems(10)
    expect(upsertedRows(fake).map((x) => x.account_id)).toEqual([3])
    expect(r.message).toContain('Už v seznamu: 2.')
    // vkládá se ON CONFLICT (list_id, account_id) DO NOTHING — souběžné kliknutí nic nepřepíše
    const [, options] = opArgs(upsertCall(fake)!, 'upsert') as [unknown, Record<string, unknown>]
    expect(options).toEqual({ onConflict: 'list_id,account_id', ignoreDuplicates: true })
    // položky se jen čtou (seznamu 10) a vkládají — nikdy update ani delete
    const itemCalls = fake.calls.filter((c) => c.table === 'target_list_item')
    expect(itemCalls.some((c) => hasOp(c, 'update') || hasOp(c, 'delete') || hasOp(c, 'insert'))).toBe(false)
    const read = itemCalls.find((c) => hasOp(c, 'select') && !hasOp(c, 'upsert'))!
    expect(read.ops).toContainEqual({ method: 'eq', args: ['list_id', 10] })
  })

  test('druhé kliknutí, když už je vše v seznamu → žádný zápis, srozumitelná zpráva', async () => {
    const fake = setup({ accounts, items: accounts.map((a) => ({ account_id: a.id })) })
    const r = await suggestTargetListItems(10)
    expect(r).toEqual({ success: true, message: 'Nic nového — všechny odpovídající firmy (3) už v seznamu jsou.' })
    expect(upsertCall(fake)).toBeUndefined()
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  test('souběh: DB vloží méně řádků, než se posílalo → zpráva to řekne', async () => {
    setup({ accounts, upsert: () => ({ data: [{ id: 1 }], error: null }) })
    const r = await suggestTargetListItems(10)
    expect(r.message).toContain('Přidáno do návrhů: 1 firma.')
    expect(r.message).toContain('Mezitím je do seznamu přidal někdo jiný: 2.')
  })

  test('chyba DB při vložení → obecná hláška bez detailu', async () => {
    setup({ accounts, upsert: () => ({ data: null, error: { code: 'XX000', message: 'constraint target_list_item_x' } }) })
    const r = await suggestTargetListItems(10)
    expect(r.success).toBe(false)
    expect(r.error).not.toContain('target_list_item')
    expect(revalidatePath).not.toHaveBeenCalled()
  })
})

describe('limit na kliknutí', () => {
  test(`nejvýš ${SUGGEST_CAP} firem, zbytek hlásí jako „zbývá"`, async () => {
    const accounts: Account[] = Array.from({ length: 350 }, (_, i) =>
      ({ id: i + 1, name: `Firma ${String(i + 1).padStart(3, '0')}`, industry: 'Logistika – sklady', region: null }))
    const fake = setup({ accounts })
    const r = await suggestTargetListItems(10)
    expect(upsertedRows(fake)).toHaveLength(SUGGEST_CAP)
    expect(r.message).toContain(`Přidáno do návrhů: ${SUGGEST_CAP} firem.`)
    expect(r.message).toContain('zbývá 50, klikni znovu')
  })

  test('firmy se čtou po stránkách (víc než 1000 řádků)', async () => {
    const accounts: Account[] = Array.from({ length: 1500 }, (_, i) =>
      ({ id: i + 1, name: `F${i + 1}`, industry: i === 1400 ? 'Spedice' : 'IT', region: null }))
    const fake = setup({ accounts })
    await suggestTargetListItems(10)
    // Jen stránkované čtení kandidátů (nesouhlas s oslovením čte firmy zvlášť, bez range).
    const accountCalls = fake.calls.filter((c) => c.table === 'account' && hasOp(c, 'range'))
    expect(accountCalls.map((c) => opArgs(c, 'range'))).toEqual([[0, 999], [1000, 1999]])
    expect(upsertedRows(fake).map((x) => x.account_id)).toEqual([1401])
  })
})

describe('nesouhlas s oslovením (0087)', () => {
  test('firma, kde nesouhlasí všichni lidé (políčko i poznámka), se nenavrhne; částečný nesouhlas nevadí', async () => {
    const fake = setup({
      accounts: [
        { id: 1, name: 'Spedice A', industry: 'Spedice', region: null },
        { id: 2, name: 'Spedice B', industry: 'Spedice', region: null },
        { id: 3, name: 'Spedice C', industry: 'Spedice', region: null },
      ],
      contacts: [
        { account_id: 1, notes: null, do_not_contact: true },
        { account_id: 1, notes: 'Nekontaktovat.' },
        { account_id: 2, notes: null, do_not_contact: true },
        { account_id: 2, notes: null, do_not_contact: false },
      ],
    })
    const r = await suggestTargetListItems(10)
    expect(r.success).toBe(true)
    expect(upsertedRows(fake).map((x) => x.account_id)).toEqual([2, 3])
    expect(r.message).toContain('Nesouhlasí s oslovením (nenavrženo): 1.')
  })

  test('když nesouhlasí všechny nové firmy, nic se nevloží', async () => {
    const fake = setup({
      accounts: [{ id: 1, name: 'Spedice A', industry: 'Spedice', region: null }],
      contacts: [{ account_id: 1, notes: null, do_not_contact: true }],
    })
    const r = await suggestTargetListItems(10)
    expect(r).toEqual({ success: true, message: 'Nic nového — nové odpovídající firmy (1) nesouhlasí s oslovením.' })
    expect(upsertCall(fake)).toBeUndefined()
  })
})
