import { describe, expect, test } from 'vitest'
import {
  ACCOUNT_MAX_PAGE, ACCOUNT_PAGE_SIZE, BLANK_ICO_FILTER, DEFAULT_ACCOUNT_LIST_PARAMS, EMPTY_STATUS_SETS,
  INDUSTRY_SEPARATOR, NONE_VALUE,
  accountListHref, accountSearchOrFilter, accountStatus, applyAccountFilters, clampPage, czCount,
  deriveStatusSets, facetsFromRows, facetsFromView, filtersMatchNothing, hasActiveFilters, industryOrFilter,
  industryPrefix, lastContactAt, pageCount, pageRange, pagerItems, parseAccountListParams, parsePage,
  rankByOpenPipeline, type AccountListParams, type StatusSets,
} from '@/domain/crm/accountList'
import { createSupabaseFake, type Op } from './helpers/supabaseFake'

// Čistá logika seznamu klientů (/cockpit/clients): parametry z URL, meze
// stránkování, escapování hledání a překlad filtrů na volání PostgRESTu.
// I/O (počet dotazů, fallbacky) je v test/account-list-io.test.ts.

const SALES = { canSeeSales: true }
const NON_SALES = { canSeeSales: false }
const OWNER = '3f0c2a4e-8b1d-4c7a-9e5f-1a2b3c4d5e6f'

describe('parseAccountListParams', () => {
  test('prázdné URL → výchozí hodnoty', () => {
    expect(parseAccountListParams({}, SALES)).toEqual(DEFAULT_ACCOUNT_LIST_PARAMS)
  })

  test('hledání se ořízne, řídicí znaky pryč, max 100 znaků', () => {
    expect(parseAccountListParams({ q: '  acme \u0000 ' }, SALES).q).toBe('acme')
    expect(parseAccountListParams({ q: '   ' }, SALES).q).toBeNull()
    expect(parseAccountListParams({ q: 'x'.repeat(250) }, SALES).q).toHaveLength(100)
    expect(parseAccountListParams({ q: ['první', 'druhý'] }, SALES).q).toBe('první')
  })

  test('stav: povolené hodnoty; „aktivni" jen pro obchodní role', () => {
    expect(parseAccountListParams({ stav: 'klient' }, NON_SALES).status).toBe('klient')
    expect(parseAccountListParams({ stav: 'prospekt' }, NON_SALES).status).toBe('prospekt')
    expect(parseAccountListParams({ stav: 'aktivni' }, SALES).status).toBe('aktivni')
    expect(parseAccountListParams({ stav: 'aktivni' }, NON_SALES).status).toBeNull()
    expect(parseAccountListParams({ stav: 'smazany' }, SALES).status).toBeNull()
  })

  test('řazení podle pipeline jen pro obchodní role, neznámé → název', () => {
    expect(parseAccountListParams({ sort: 'pipeline' }, SALES).sort).toBe('pipeline')
    expect(parseAccountListParams({ sort: 'pipeline' }, NON_SALES).sort).toBe('nazev')
    expect(parseAccountListParams({ sort: 'aktivita' }, NON_SALES).sort).toBe('aktivita')
    expect(parseAccountListParams({ sort: 'name; drop' }, SALES).sort).toBe('nazev')
  })

  test('vlastník: jen UUID nebo „bez vlastníka"', () => {
    expect(parseAccountListParams({ vlastnik: OWNER }, SALES).owner).toBe(OWNER)
    expect(parseAccountListParams({ vlastnik: NONE_VALUE }, SALES).owner).toBe(NONE_VALUE)
    expect(parseAccountListParams({ vlastnik: 'eq.1,or(' }, SALES).owner).toBeNull()
  })

  test('bez IČO: 1 / on / true', () => {
    for (const v of ['1', 'on', 'true']) expect(parseAccountListParams({ bez_ico: v }, SALES).bezIco).toBe(true)
    expect(parseAccountListParams({ bez_ico: '0' }, SALES).bezIco).toBe(false)
  })
})

describe('stránkování — meze', () => {
  test('parsePage: nečíselné, nula, záporné → 1; obří → strop', () => {
    expect(parsePage(undefined)).toBe(1)
    expect(parsePage('abc')).toBe(1)
    expect(parsePage('0')).toBe(1)
    expect(parsePage('-3')).toBe(1)
    expect(parsePage('2.5')).toBe(1)
    expect(parsePage('1e9')).toBe(1)
    expect(parsePage(' 3 ')).toBe(3)
    expect(parsePage('99999999999999999999')).toBe(1) // není bezpečné celé číslo
    expect(parsePage(String(ACCOUNT_MAX_PAGE + 5))).toBe(ACCOUNT_MAX_PAGE)
    expect(parsePage(['4', '9'])).toBe(4)
  })

  test('pageRange: 50 na stránku, včetně horní meze', () => {
    expect(ACCOUNT_PAGE_SIZE).toBe(50)
    expect(pageRange(1)).toEqual({ from: 0, to: 49 })
    expect(pageRange(2)).toEqual({ from: 50, to: 99 })
    expect(pageRange(0)).toEqual({ from: 0, to: 49 })
    expect(pageRange(-7)).toEqual({ from: 0, to: 49 })
    expect(pageRange(ACCOUNT_MAX_PAGE * 10).from).toBe((ACCOUNT_MAX_PAGE - 1) * 50)
    expect(pageRange(3, 20)).toEqual({ from: 40, to: 59 })
  })

  test('pageCount a clampPage: prázdný výsledek = 1 stránka, 663 firem = 14 stránek', () => {
    expect(pageCount(0)).toBe(1)
    expect(pageCount(50)).toBe(1)
    expect(pageCount(51)).toBe(2)
    expect(pageCount(663)).toBe(14)
    expect(clampPage(20, 663)).toBe(14)
    expect(clampPage(0, 663)).toBe(1)
    expect(clampPage(5, 0)).toBe(1)
    expect(clampPage(7, 663)).toBe(7)
  })

  test('pagerItems: první, poslední, okolí a mezery', () => {
    expect(pagerItems(1, 1)).toEqual([1])
    expect(pagerItems(3, 7)).toEqual([1, 2, 3, 4, 5, 6, 7])
    expect(pagerItems(1, 14)).toEqual([1, 2, null, 14])
    expect(pagerItems(7, 14)).toEqual([1, null, 6, 7, 8, null, 14])
    expect(pagerItems(14, 14)).toEqual([1, null, 13, 14])
    expect(pagerItems(2, 14)).toEqual([1, 2, 3, null, 14])
  })
})

describe('accountListHref — stav filtru v URL', () => {
  test('výchozí hodnoty se nepíšou', () => {
    expect(accountListHref(DEFAULT_ACCOUNT_LIST_PARAMS)).toBe('/cockpit/clients')
    expect(accountListHref(DEFAULT_ACCOUNT_LIST_PARAMS, { page: 1 })).toBe('/cockpit/clients')
  })

  test('filtry, řazení a stránka; parse(href) vrátí totéž', () => {
    const p: AccountListParams = {
      q: 'Novák & syn', status: 'klient', obor: 'Výroba', region: 'Praha', owner: OWNER,
      bezIco: true, sort: 'aktivita', page: 3,
    }
    const href = accountListHref(p)
    expect(href.startsWith('/cockpit/clients?')).toBe(true)
    const back = parseAccountListParams(Object.fromEntries(new URL(href, 'https://x').searchParams), SALES)
    expect(back).toEqual(p)
    expect(hasActiveFilters(p)).toBe(true)
    expect(hasActiveFilters({ ...DEFAULT_ACCOUNT_LIST_PARAMS, sort: 'aktivita', page: 4 })).toBe(false)
  })
})

describe('escapování hledání (ILIKE bez zástupných znaků)', () => {
  test('% _ a \\ v dotazu jsou literály, hodnota je v uvozovkách', () => {
    expect(accountSearchOrFilter('50%_off\\')).toBe(
      'name.ilike."%50\\\\%\\\\_off\\\\\\\\%",ico.ilike."%50\\\\%\\\\_off\\\\\\\\%"',
    )
  })

  test('čárka a závorky nerozbijí or() podmínku', () => {
    const f = accountSearchOrFilter('Novák, Jan (CZ)')
    expect(f).toBe('name.ilike."%Novák, Jan (CZ)%",ico.ilike."%Novák, Jan (CZ)%"')
  })

  test('uvozovky v dotazu jsou escapované', () => {
    expect(accountSearchOrFilter('a"b')).toBe('name.ilike."%a\\"b%",ico.ilike."%a\\"b%"')
  })

  test('IČO s mezerami hledá i bez mezer', () => {
    expect(accountSearchOrFilter('123 45 678')).toBe(
      'name.ilike."%123 45 678%",ico.ilike."%123 45 678%",ico.ilike."%12345678%"',
    )
    expect(accountSearchOrFilter('12345678').split(',')).toHaveLength(2)
  })

  test('obor: přesný prefix nebo „prefix – …", LIKE znaky escapované', () => {
    expect(industryOrFilter('IT')).toBe(`industry.eq."IT",industry.like."IT${INDUSTRY_SEPARATOR}%"`)
    expect(industryOrFilter('A_B%')).toBe(`industry.eq."A_B%",industry.like."A\\\\_B\\\\%${INDUSTRY_SEPARATOR}%"`)
  })
})

describe('applyAccountFilters → volání PostgRESTu', () => {
  const run = (p: Partial<AccountListParams>, sets: StatusSets = EMPTY_STATUS_SETS): { ops: Op[]; empty: boolean } => {
    const fake = createSupabaseFake()
    const from = fake.client.from('account') as Record<string, (...args: unknown[]) => unknown>
    const builder = from.select('id') as never
    const { empty } = applyAccountFilters(builder, { ...DEFAULT_ACCOUNT_LIST_PARAMS, ...p }, sets)
    return { ops: fake.calls[0].ops.slice(1), empty }
  }
  const SETS: StatusSets = { openIds: [3, 1], wonIds: [7, 3] }

  test('bez filtrů žádné podmínky', () => {
    expect(run({})).toEqual({ ops: [], empty: false })
  })

  test('hledání → jedno or() přes název a IČO', () => {
    expect(run({ q: 'acme' }).ops).toEqual([
      { method: 'or', args: ['name.ilike."%acme%",ico.ilike."%acme%"'] },
    ])
  })

  test('stav aktivní → id in otevřené; bez otevřených obchodů prázdný výsledek bez dotazu', () => {
    expect(run({ status: 'aktivni' }, SETS).ops).toEqual([{ method: 'in', args: ['id', [3, 1]] }])
    expect(run({ status: 'aktivni' }, EMPTY_STATUS_SETS)).toEqual({ ops: [], empty: true })
    expect(filtersMatchNothing({ ...DEFAULT_ACCOUNT_LIST_PARAMS, status: 'aktivni' }, EMPTY_STATUS_SETS)).toBe(true)
  })

  test('stav klient → (client_since nebo vyhraný) a ne otevřený', () => {
    expect(run({ status: 'klient' }, SETS).ops).toEqual([
      { method: 'or', args: ['client_since.not.is.null,id.in.(7,3)'] },
      { method: 'not', args: ['id', 'in', '(3,1)'] },
    ])
    // Neobchodní role: obchody nevidí → jen „Klient od".
    expect(run({ status: 'klient' }).ops).toEqual([
      { method: 'not', args: ['client_since', 'is', null] },
    ])
  })

  test('stav prospekt → bez client_since a mimo firmy s obchodem', () => {
    expect(run({ status: 'prospekt' }, SETS).ops).toEqual([
      { method: 'is', args: ['client_since', null] },
      { method: 'not', args: ['id', 'in', '(1,3,7)'] },
    ])
    expect(run({ status: 'prospekt' }).ops).toEqual([{ method: 'is', args: ['client_since', null] }])
  })

  test('obor, region, vlastník, bez IČO (i „nevyplněno")', () => {
    expect(run({ obor: 'Výroba', region: 'Praha', owner: OWNER, bezIco: true }).ops).toEqual([
      { method: 'or', args: [`industry.eq."Výroba",industry.like."Výroba${INDUSTRY_SEPARATOR}%"`] },
      { method: 'eq', args: ['region', 'Praha'] },
      { method: 'eq', args: ['owner_id', OWNER] },
      { method: 'or', args: [BLANK_ICO_FILTER] },
    ])
    expect(run({ obor: NONE_VALUE, region: NONE_VALUE, owner: NONE_VALUE }).ops).toEqual([
      { method: 'or', args: ['industry.is.null,industry.eq.""'] },
      { method: 'or', args: ['region.is.null,region.eq.""'] },
      { method: 'is', args: ['owner_id', null] },
    ])
  })
})

describe('stav firmy a pipeline', () => {
  const deals = [
    { account_id: 1, stage: 'rozsah_nabidka', amount_one_time: 100_000, account: { name: 'Beta' } },
    { account_id: 1, stage: 'rozhodovani', amount_one_time: '50000', account: { name: 'Beta' } },
    { account_id: 2, stage: 'vyhráno', amount_one_time: 900_000, account: { name: 'Alfa' } },
    { account_id: 4, stage: 'kvalifikace', amount_one_time: 150_000, account: { name: 'Alfa' } },
    { account_id: 5, stage: 'kvalifikace', amount_one_time: null, account: { name: 'Nula' } },
    { account_id: 6, stage: 'prohráno', amount_one_time: 10, account: { name: 'Pryč' } },
  ]

  test('deriveStatusSets: otevřené a vyhrané (seřazené, bez duplicit)', () => {
    expect(deriveStatusSets(deals)).toEqual({ openIds: [1, 4, 5], wonIds: [2] })
  })

  test('accountStatus: aktivní > klient > prospekt', () => {
    const sets = deriveStatusSets(deals)
    expect(accountStatus({ id: 1, client_since: '2024-01-01' }, sets)).toBe('aktivni')
    expect(accountStatus({ id: 2, client_since: null }, sets)).toBe('klient')
    expect(accountStatus({ id: 9, client_since: '2024-01-01' }, sets)).toBe('klient')
    expect(accountStatus({ id: 9, client_since: null }, sets)).toBe('prospekt')
    expect(accountStatus({ id: 1, client_since: null }, EMPTY_STATUS_SETS)).toBe('prospekt')
  })

  test('rankByOpenPipeline: součet otevřených, od největší, shoda → název; nulové vynechá', () => {
    // 1 (Beta) i 4 (Alfa) mají 150 000 → rozhodne název.
    expect(rankByOpenPipeline(deals)).toEqual([
      { account_id: 4, amount: 150_000 },
      { account_id: 1, amount: 150_000 },
    ])
    expect(rankByOpenPipeline([
      ...deals, { account_id: 8, stage: 'diagnostika', amount_one_time: 200_000, account: { name: 'Zeta' } },
    ])[0]).toEqual({ account_id: 8, amount: 200_000 })
  })
})

describe('fasety (obor, region, bez IČO)', () => {
  test('industryPrefix = text před „ – "', () => {
    expect(industryPrefix(`Výroba${INDUSTRY_SEPARATOR}strojírenství`)).toBe('Výroba')
    expect(industryPrefix('IT')).toBe('IT')
    expect(industryPrefix(`${INDUSTRY_SEPARATOR}x`)).toBeNull()
    expect(industryPrefix(null)).toBeNull()
    expect(industryPrefix('')).toBeNull()
  })

  test('facetsFromRows (záloha bez 0068) = facetsFromView (pohled z 0068)', () => {
    const rows = Array.from({ length: 700 }, (_, i) => ({
      industry: i % 3 === 0 ? null : i % 3 === 1 ? `Výroba${INDUSTRY_SEPARATOR}obor ${i % 7}` : 'IT',
      region: i % 5 === 0 ? 'Praha' : i % 5 === 1 ? 'Brno' : null,
      ico: i % 4 === 0 ? null : i % 4 === 1 ? '' : String(10_000_000 + i),
    }))
    const fromRows = facetsFromRows(rows)
    expect(fromRows.total).toBe(700)
    expect(fromRows.missingIco).toBe(350)
    expect(fromRows.industries).toEqual([{ value: 'IT', count: 233 }, { value: 'Výroba', count: 233 }])
    expect(fromRows.regions).toEqual([{ value: 'Brno', count: 140 }, { value: 'Praha', count: 140 }])

    const fromView = facetsFromView([
      { kind: 'industry', value: 'Výroba', n: '233' },
      { kind: 'region', value: 'Praha', n: 140 },
      { kind: 'industry', value: 'IT', n: 233 },
      { kind: 'region', value: 'Brno', n: 140 },
      { kind: 'total', value: null, n: 700 },
      { kind: 'missing_ico', value: null, n: 350 },
    ])
    expect(fromView).toEqual(fromRows)
  })
})

describe('texty', () => {
  test('czCount: 1 / 2–4 / 0 a 5+', () => {
    const FIRMY = ['firma', 'firmy', 'firem'] as const
    expect(czCount(0, FIRMY)).toBe('0 firem')
    expect(czCount(1, FIRMY)).toBe('1 firma')
    expect(czCount(3, FIRMY)).toBe('3 firmy')
    expect(czCount(663, FIRMY)).toBe('663 firem')
  })

  test('lastContactAt: novější z příchozí/odchozí', () => {
    expect(lastContactAt({ last_inbound_at: null, last_outbound_at: null })).toBeNull()
    expect(lastContactAt({ last_inbound_at: '2026-09-01T10:00:00Z', last_outbound_at: null })).toBe('2026-09-01T10:00:00Z')
    expect(lastContactAt({ last_inbound_at: '2026-09-01T10:00:00Z', last_outbound_at: '2026-09-02T10:00:00Z' }))
      .toBe('2026-09-02T10:00:00Z')
  })
})
