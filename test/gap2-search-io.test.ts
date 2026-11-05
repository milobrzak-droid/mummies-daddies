import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { search, SEARCH_GROUP_LIMIT } from '@/domain/crm/queries/search'
import { createSupabaseFake, opArgs, type QueryCall } from './helpers/supabaseFake'

// search() je jediná I/O funkce v domain/crm/queries/search.ts (zbytek jsou
// čisté funkce testované v test/search.test.ts). Ověřujeme:
// - všech pět skupin běží (paralelně, přes Promise.allSettled) a výsledky se
//   správně tvarují/slučují (accounts + company_alias)
// - selhání/chybějící company_alias hledání nezruší zbytek výsledků
// - každá skupina je omezená na SEARCH_GROUP_LIMIT (10)
// - použije se RLS klient (createClient), ne admin (service role)

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))

beforeEach(() => vi.clearAllMocks())

const SALES = { includeDeals: true }

const ACCOUNT_ROW = { id: 1, name: 'Acme s.r.o.', ico: '12345678', web: null }
const ALIAS_ROW = { account_id: 2, alias_domain: 'acmegroup.cz', alias_name: 'Acme Group', account: { id: 2, name: 'Acme Holding' } }
const CONTACT_ROW = { id: 3, full_name: 'Jan Novák', email: 'jan@acme.cz', account_id: 1, partner_id: null }
const DEAL_ROW = { id: 4, title: 'Acme rozšíření', account_id: 1, account: { name: 'Acme s.r.o.' } }
const PARTNER_ROW = { id: 5, name: 'Acme Partner', kind: 'reseller' }

function setupFake(overrides: Partial<Record<string, { data: unknown; error: unknown }>> = {}) {
  const fake = createSupabaseFake({
    resolve: (call: QueryCall) => {
      if (overrides[call.table]) return overrides[call.table]!
      switch (call.table) {
        case 'account': return { data: [ACCOUNT_ROW], error: null }
        case 'company_alias': return { data: [ALIAS_ROW], error: null }
        case 'contact': return { data: [CONTACT_ROW], error: null }
        case 'deal': return { data: [DEAL_ROW], error: null }
        case 'partner': return { data: [PARTNER_ROW], error: null }
        default: return { data: [], error: null }
      }
    },
  })
  vi.mocked(createClient).mockResolvedValue(fake.client as never)
  return fake
}

describe('search — paralelní skupiny a tvarování', () => {
  test('dotazuje všech pět tabulek a výsledky správně tvaruje/slučuje', async () => {
    const fake = setupFake()
    const result = await search('acme', SALES)

    expect(fake.calls.map((c) => c.table).sort()).toEqual(
      ['account', 'company_alias', 'contact', 'deal', 'partner'].sort(),
    )

    expect(result.accounts).toEqual([
      { kind: 'account', id: 1, title: 'Acme s.r.o.', subtitle: 'IČO 12345678', href: '/cockpit/clients/1' },
      { kind: 'account', id: 2, title: 'Acme Holding', subtitle: 'alias: acmegroup.cz · Acme Group', href: '/cockpit/clients/2' },
    ])
    expect(result.contacts).toEqual([
      { kind: 'contact', id: 3, title: 'Jan Novák', subtitle: 'jan@acme.cz', href: '/cockpit/kontakty/3/edit' },
    ])
    expect(result.deals).toEqual([
      { kind: 'deal', id: 4, title: 'Acme rozšíření', subtitle: 'Acme s.r.o.', href: '/cockpit/clients/1/deals/4' },
    ])
    expect(result.partners).toEqual([
      { kind: 'partner', id: 5, title: 'Acme Partner', subtitle: 'reseller', href: '/cockpit/partners/5/edit' },
    ])
  })

  test('hledaný vzorec je %escapovaný dotaz% na správných sloupcích, hodnota v .or() uvozovkovaná', async () => {
    const fake = setupFake()
    await search('50%_off', SALES)
    const accountCall = fake.calls.find((c) => c.table === 'account')!
    expect(opArgs(accountCall, 'or')).toEqual(['name.ilike."%50\\\\%\\\\_off%",ico.ilike."%50\\\\%\\\\_off%"'])
    const contactCall = fake.calls.find((c) => c.table === 'contact')!
    expect(opArgs(contactCall, 'or')).toEqual(['full_name.ilike."%50\\\\%\\\\_off%",email.ilike."%50\\\\%\\\\_off%"'])
  })

  test('čárka/závorka ve vstupu ("Novák, Jan") nerozšíří filtr o další podmínku', async () => {
    const fake = setupFake()
    await search('Novák, Jan (obchod)', SALES)
    const accountCall = fake.calls.find((c) => c.table === 'account')!
    const [orValue] = opArgs(accountCall, 'or') as [string]
    // celá hodnota je uvnitř jedněch dvojitých uvozovek za `name.ilike.` —
    // čárka a závorky ve vstupu se do syntaxe .or() nepromítnou jako oddělovače
    expect(orValue.startsWith('name.ilike."%Novák, Jan (obchod)%"')).toBe(true)
    expect(orValue).toBe('name.ilike."%Novák, Jan (obchod)%",ico.ilike."%Novák, Jan (obchod)%"')
  })

  test('uvozovka a zpětné lomítko ve vstupu jsou uvnitř .or() hodnoty escapované', async () => {
    const fake = setupFake()
    await search('a"b\\c', SALES)
    const accountCall = fake.calls.find((c) => c.table === 'account')!
    const [orValue] = opArgs(accountCall, 'or') as [string]
    expect(orValue).toBe('name.ilike."%a\\"b\\\\\\\\c%",ico.ilike."%a\\"b\\\\\\\\c%"')
  })

  test('company_alias selže (chybí tabulka / RLS) → hledání pokračuje bez aliasů', async () => {
    setupFake({ company_alias: { data: null, error: { code: 'PGRST205', message: 'missing' } } })
    const result = await search('acme', SALES)
    expect(result.accounts).toEqual([
      { kind: 'account', id: 1, title: 'Acme s.r.o.', subtitle: 'IČO 12345678', href: '/cockpit/clients/1' },
    ])
    // ostatní skupiny zůstávají nedotčené
    expect(result.contacts).toHaveLength(1)
    expect(result.deals).toHaveLength(1)
    expect(result.partners).toHaveLength(1)
  })

  test('chyba jedné z ostatních skupin (např. deal) degraduje jen tu skupinu', async () => {
    setupFake({ deal: { data: null, error: { message: 'boom' } } })
    const result = await search('acme', SALES)
    expect(result.deals).toEqual([])
    expect(result.accounts).toHaveLength(2) // přímá shoda + alias, oboje pořád funguje
    expect(result.contacts).toHaveLength(1)
    expect(result.partners).toHaveLength(1)
  })

  test('každá skupina je omezená na SEARCH_GROUP_LIMIT (10)', async () => {
    const fake = setupFake()
    await search('acme', SALES)
    for (const table of ['account', 'company_alias', 'contact', 'deal', 'partner']) {
      const call = fake.calls.find((c) => c.table === table)!
      expect(opArgs(call, 'limit'), table).toEqual([SEARCH_GROUP_LIMIT])
    }
    expect(SEARCH_GROUP_LIMIT).toBe(10)
  })

  test('používá RLS klienta (createClient), ne admin klienta se service rolí', async () => {
    setupFake()
    await search('acme', SALES)
    expect(createClient).toHaveBeenCalledTimes(1)
    expect(createAdminClient).not.toHaveBeenCalled()
  })

  test('company_alias hledá v alias_domain i alias_name (sloupec `alias` v 0033 neexistuje)', async () => {
    const fake = setupFake()
    await search('Acme, a.s.', SALES)
    const aliasCall = fake.calls.find((c) => c.table === 'company_alias')!
    expect(opArgs(aliasCall, 'or')).toEqual(['alias_domain.ilike."%Acme, a.s.%",alias_name.ilike."%Acme, a.s.%"'])
    expect(opArgs(aliasCall, 'ilike')).toBeUndefined()
    const [columns] = opArgs(aliasCall, 'select') as [string]
    expect(columns).toContain('alias_domain')
    expect(columns).toContain('alias_name')
    expect(columns).not.toMatch(/(^|[\s,])alias([\s,]|$)/)
  })
})

describe('search — obchody jen pro obchodní role (0058)', () => {
  test('includeDeals: false → na deal se vůbec nedotazuje, skupina obchodů je prázdná', async () => {
    const fake = setupFake()
    const result = await search('acme', { includeDeals: false })
    expect(fake.calls.map((c) => c.table)).not.toContain('deal')
    expect(result.deals).toEqual([])
    expect(result.accounts).toHaveLength(2)
    expect(result.contacts).toHaveLength(1)
    expect(result.partners).toHaveLength(1)
  })

  test('includeDeals: true → obchody se hledají', async () => {
    const fake = setupFake()
    const result = await search('acme', SALES)
    expect(fake.calls.map((c) => c.table)).toContain('deal')
    expect(result.deals).toHaveLength(1)
  })
})
