import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import {
  ACCOUNT_LIST_COLUMNS, FACETS_FALLBACK_NOTICE, MIGRATION_0068_NOTICE, getAccountListSummary, listAccountsPage,
} from '@/domain/crm/queries/accountList'
import { DEFAULT_ACCOUNT_LIST_PARAMS, EMPTY_STATUS_SETS, type AccountListParams } from '@/domain/crm/accountList'
import { createSupabaseFake, hasOp, opArgs, type QueryCall, type QueryResult } from './helpers/supabaseFake'

// I/O seznamu klientů nad 700 falešnými firmami: kolik dotazů na jedno
// vykreslení (žádné N+1 — počet nezávisí na počtu řádků), co jde do
// PostgRESTu (range, order, count), meze stránek a fallbacky bez 0068.

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

beforeEach(() => vi.clearAllMocks())

const N = 700
const ROWS = Array.from({ length: N }, (_, i) => ({
  id: i + 1,
  name: `Firma ${String(i + 1).padStart(3, '0')}`,
  ico: i % 3 === 0 ? null : String(10_000_000 + i),
  industry: 'IT', region: null, client_since: null, owner_id: null,
  last_inbound_at: null, last_outbound_at: null, owner: null, referred_by: null,
}))

type Behaviour = {
  total?: number
  /** kód chyby pro první dotaz, který řadí podle last_contact_at */
  missingComputedColumn?: boolean
  missingView?: boolean
}

/** Chová se jako PostgREST: range + count=exact, 416 za koncem, head count. */
function setupFake(b: Behaviour = {}) {
  const total = b.total ?? N
  const fake = createSupabaseFake({
    resolve: (call: QueryCall): QueryResult => {
      if (call.table === 'v_account_list_facets') {
        if (b.missingView) return { data: null, error: { code: 'PGRST205', message: 'Could not find the table' } }
        return {
          data: [
            { kind: 'industry', value: 'IT', n: total },
            { kind: 'total', value: null, n: total },
            { kind: 'missing_ico', value: null, n: 234 },
          ],
          error: null,
        }
      }
      if (call.table !== 'account') return { data: [], error: null }
      const [, opts] = (opArgs(call, 'select') ?? []) as [string, { count?: string; head?: boolean } | undefined]
      if (b.missingComputedColumn && call.ops.some((o) => o.method === 'order' && o.args[0] === 'last_contact_at')) {
        return { data: null, error: { code: '42703', message: 'column account.last_contact_at does not exist' } }
      }
      if (opts?.head) return { data: null, error: null, count: total }
      const range = opArgs(call, 'range') as [number, number] | undefined
      if (range) {
        const [from, to] = range
        if (from > 0 && from >= total) {
          return { data: null, error: { code: 'PGRST103', message: 'Requested range not satisfiable' } }
        }
        return { data: ROWS.slice(0, total).slice(from, to + 1), error: null, count: opts?.count ? total : null }
      }
      if (hasOp(call, 'in')) {
        const ids = (opArgs(call, 'in') as [string, number[]])[1]
        return { data: ROWS.filter((r) => ids.includes(r.id)), error: null }
      }
      return { data: ROWS.slice(0, total).map(({ industry, region, ico }) => ({ industry, region, ico })), error: null }
    },
  })
  vi.mocked(createClient).mockResolvedValue(fake.client as never)
  return fake
}

const params = (p: Partial<AccountListParams> = {}): AccountListParams => ({ ...DEFAULT_ACCOUNT_LIST_PARAMS, ...p })

describe('listAccountsPage — stránka z DB', () => {
  test('1 dotaz na stránku: úzký select + count=exact, řazení name,id, range 50', async () => {
    const fake = setupFake()
    const r = await listAccountsPage(params({ page: 2 }), EMPTY_STATUS_SETS)

    expect(fake.calls).toHaveLength(1)
    const call = fake.calls[0]
    expect(call.table).toBe('account')
    expect(opArgs(call, 'select')).toEqual([ACCOUNT_LIST_COLUMNS, { count: 'exact' }])
    expect(ACCOUNT_LIST_COLUMNS).not.toContain('*')
    expect(call.ops.filter((o) => o.method === 'order').map((o) => o.args[0])).toEqual(['name', 'id'])
    expect(opArgs(call, 'range')).toEqual([50, 99])
    expect(r.rows).toHaveLength(50)
    expect(r.rows[0].id).toBe(51)
    expect(r).toMatchObject({ total: 700, page: 2, pageCount: 14, notices: [] })
  })

  test('filtry jdou do téhož dotazu (hledání escapované, bez IČO)', async () => {
    const fake = setupFake()
    await listAccountsPage(params({ q: '100%', bezIco: true }), EMPTY_STATUS_SETS)
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0].ops.filter((o) => o.method === 'or').map((o) => o.args[0])).toEqual([
      'name.ilike."%100\\\\%%",ico.ilike."%100\\\\%%"',
      'ico.is.null,ico.eq.""',
    ])
  })

  test('stránka za koncem (starý odkaz) → head count a poslední stránka', async () => {
    const fake = setupFake()
    const r = await listAccountsPage(params({ page: 20 }), EMPTY_STATUS_SETS)
    expect(fake.calls).toHaveLength(3) // stránka 20 (416) + count + stránka 14
    expect(opArgs(fake.calls[2], 'range')).toEqual([650, 699])
    expect(r).toMatchObject({ page: 14, pageCount: 14, total: 700 })
    expect(r.rows).toHaveLength(50)
  })

  test('prázdný výsledek: stránka 1, žádná chyba', async () => {
    setupFake({ total: 0 })
    const r = await listAccountsPage(params({ page: 3 }), EMPTY_STATUS_SETS)
    expect(r).toMatchObject({ rows: [], total: 0, page: 1, pageCount: 1 })
  })

  test('stav „aktivní" bez otevřených obchodů → žádný dotaz', async () => {
    const fake = setupFake()
    const r = await listAccountsPage(params({ status: 'aktivni' }), EMPTY_STATUS_SETS)
    expect(fake.calls).toHaveLength(0)
    expect(r).toMatchObject({ rows: [], total: 0, page: 1 })
  })

  test('řazení podle poslední aktivity: last_contact_at (0068), NULL na konec', async () => {
    const fake = setupFake()
    await listAccountsPage(params({ sort: 'aktivita' }), EMPTY_STATUS_SETS)
    const orders = fake.calls[0].ops.filter((o) => o.method === 'order')
    expect(orders[0].args).toEqual(['last_contact_at', { ascending: false, nullsFirst: false }])
    expect(orders.slice(1).map((o) => o.args[0])).toEqual(['name', 'id'])
  })

  test('bez 0068 (42703) → řazení podle last_outbound/inbound a klidná poznámka', async () => {
    const fake = setupFake({ missingComputedColumn: true })
    const r = await listAccountsPage(params({ sort: 'aktivita' }), EMPTY_STATUS_SETS)
    expect(fake.calls).toHaveLength(2)
    expect(fake.calls[1].ops.filter((o) => o.method === 'order').map((o) => o.args[0]))
      .toEqual(['last_outbound_at', 'last_inbound_at', 'name', 'id'])
    expect(r.notices).toEqual([MIGRATION_0068_NOTICE])
    expect(r.rows).toHaveLength(50)
  })

  test('jiná chyba DB se nepolyká', async () => {
    const fake = createSupabaseFake({ resolve: () => ({ data: null, error: { code: '42501', message: 'denied' } }) })
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    await expect(listAccountsPage(params(), EMPTY_STATUS_SETS)).rejects.toMatchObject({ code: '42501' })
  })
})

describe('listAccountsPage — řazení podle otevřené pipeline', () => {
  const ranking = [
    { account_id: 30, amount: 500_000 },
    { account_id: 5, amount: 200_000 },
    { account_id: 12, amount: 100_000 },
  ]
  const sets = { openIds: [5, 12, 30], wonIds: [] }

  test('2 dotazy: firmy s pipeline (v pořadí částky) + zbytek podle názvu s posunutým offsetem', async () => {
    const fake = setupFake()
    const r = await listAccountsPage(params({ sort: 'pipeline' }), sets, ranking)
    expect(fake.calls).toHaveLength(2)
    expect(opArgs(fake.calls[0], 'in')).toEqual(['id', [30, 5, 12]])
    expect(opArgs(fake.calls[1], 'not')).toEqual(['id', 'in', '(30,5,12)'])
    expect(opArgs(fake.calls[1], 'range')).toEqual([0, 46])
    expect(r.rows.slice(0, 3).map((x) => x.id)).toEqual([30, 5, 12])
    expect(r.rows).toHaveLength(50)
    // Fake ignoruje not() → zbytek má 700 řádků; celkem = 3 + 700.
    expect(r.total).toBe(703)
  })

  test('druhá stránka: offset zbytku = 50 − 3', async () => {
    const fake = setupFake()
    const r = await listAccountsPage(params({ sort: 'pipeline', page: 2 }), sets, ranking)
    expect(opArgs(fake.calls[1], 'range')).toEqual([47, 96])
    expect(r.rows[0].id).toBe(48)
    expect(r.page).toBe(2)
  })

  test('bez ranking (neobchodní role) = řazení podle názvu, 1 dotaz', async () => {
    const fake = setupFake()
    await listAccountsPage(params({ sort: 'pipeline' }), EMPTY_STATUS_SETS, [])
    expect(fake.calls).toHaveLength(1)
  })
})

describe('getAccountListSummary — fasety a počty do hlavičky', () => {
  test('2 dotazy: pohled z 0068 + head count klientů', async () => {
    const fake = setupFake()
    const r = await getAccountListSummary({ openIds: [1], wonIds: [2] })
    expect(fake.calls.map((c) => c.table).sort()).toEqual(['account', 'v_account_list_facets'])
    const head = fake.calls.find((c) => c.table === 'account')!
    expect(opArgs(head, 'select')).toEqual(['id', { count: 'exact', head: true }])
    expect(opArgs(head, 'or')).toEqual(['client_since.not.is.null,id.in.(2)'])
    expect(opArgs(head, 'not')).toEqual(['id', 'in', '(1)'])
    expect(r.facets).toMatchObject({ total: 700, missingIco: 234, industries: [{ value: 'IT', count: 700 }] })
    expect(r.clientCount).toBe(700)
    expect(r.notices).toEqual([])
  })

  test('bez 0068 (pohled chybí) → úzký výběr 3 sloupců + poznámka', async () => {
    const fake = setupFake({ missingView: true })
    const r = await getAccountListSummary(EMPTY_STATUS_SETS)
    expect(fake.calls).toHaveLength(3)
    expect(opArgs(fake.calls[2], 'select')).toEqual(['industry, region, ico'])
    expect(r.facets.total).toBe(700)
    expect(r.facets.missingIco).toBe(234)
    expect(r.notices).toEqual([FACETS_FALLBACK_NOTICE])
  })
})
