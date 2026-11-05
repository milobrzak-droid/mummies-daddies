import { beforeEach, describe, expect, test, vi, type Mock } from 'vitest'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { createClient } from '@/lib/supabase/server'
import { canCurrentUserSeeSales } from '@/lib/queries/access'
import { getSalesDeals } from '@/domain/crm/queries/sales'
import { listAssignableMembers } from '@/domain/crm/queries/tasks'
import ClientsPage from '@/app/cockpit/clients/page'
import { createSupabaseFake, opArgs, type QueryCall, type QueryResult } from './helpers/supabaseFake'

// Celé vykreslení /clients nad 700 falešnými firmami: počet dotazů do DB je
// pevný (žádné N+1 — nezávisí na počtu řádků ani na obchodech), stránka
// ukáže 50 řádků, pager, počty v hlavičce a obchodní sloupce jen
// obchodním rolím.

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/queries/access', () => ({ canCurrentUserSeeSales: vi.fn() }))
vi.mock('@/domain/crm/queries/sales', () => ({ getSalesDeals: vi.fn() }))
vi.mock('@/domain/crm/queries/tasks', () => ({ listAssignableMembers: vi.fn() }))
vi.mock('next/navigation', () => ({ usePathname: () => '/cockpit/clients' }))
vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => <a href={href} {...rest}>{children}</a>,
}))

beforeEach(() => vi.clearAllMocks())

function rows(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: i + 1,
    name: `Firma ${String(i + 1).padStart(3, '0')}`,
    ico: i % 2 ? String(10_000_000 + i) : null,
    industry: 'Výroba – strojírenství', region: 'Praha', client_since: null, owner_id: null,
    last_inbound_at: '2026-09-01T10:00:00Z', last_outbound_at: null,
    owner: null, referred_by: null,
  }))
}

// 30 obchodů — žádný z nich nesmí přidat dotaz „na řádek".
const DEALS = Array.from({ length: 30 }, (_, i) => ({
  id: i + 1, account_id: (i % 10) + 1, stage: i % 3 === 0 ? 'vyhráno' : 'rozsah_nabidka',
  amount_one_time: 10_000 * (i + 1), next_step: 'Zavolat', next_step_due: '2026-10-01',
  account: { id: (i % 10) + 1, name: `Firma ${String((i % 10) + 1).padStart(3, '0')}` },
}))

function setup({ total, sales }: { total: number; sales: boolean }) {
  const data = rows(total)
  const fake = createSupabaseFake({
    resolve: (call: QueryCall): QueryResult => {
      if (call.table === 'v_account_list_facets') {
        return {
          data: [
            { kind: 'industry', value: 'Výroba', n: total },
            { kind: 'region', value: 'Praha', n: total },
            { kind: 'total', value: null, n: total },
            { kind: 'missing_ico', value: null, n: Math.ceil(total / 2) },
          ],
          error: null,
        }
      }
      const [, opts] = (opArgs(call, 'select') ?? []) as [string, { count?: string; head?: boolean } | undefined]
      if (opts?.head) return { data: null, error: null, count: 2 }
      const range = opArgs(call, 'range') as [number, number] | undefined
      if (range) return { data: data.slice(range[0], range[1] + 1), error: null, count: total }
      return { data: data.filter((r) => ((opArgs(call, 'in')?.[1] as number[]) ?? []).includes(r.id)), error: null }
    },
  })
  vi.mocked(createClient).mockResolvedValue(fake.client as never)
  vi.mocked(canCurrentUserSeeSales).mockResolvedValue(sales)
  ;(getSalesDeals as Mock).mockResolvedValue(DEALS)
  ;(listAssignableMembers as Mock).mockResolvedValue([{ id: '3f0c2a4e-8b1d-4c7a-9e5f-1a2b3c4d5e6f', full_name: 'Viktor' }])
  return fake
}

async function render(searchParams: Record<string, string> = {}) {
  const el = await ClientsPage({ searchParams: Promise.resolve(searchParams) })
  return renderToStaticMarkup(el)
}

describe('/clients — pevný počet dotazů (žádné N+1)', () => {
  test('obchodní role, 700 firem: 3 dotazy do DB + obchody + tým, 50 řádků, pager', async () => {
    const fake = setup({ total: 700, sales: true })
    const html = await render()

    expect(fake.calls.map((c) => c.table).sort()).toEqual(['account', 'account', 'v_account_list_facets'])
    expect(getSalesDeals).toHaveBeenCalledTimes(1)
    expect(listAssignableMembers).toHaveBeenCalledTimes(1)

    expect(html.match(/<tr /g)).toHaveLength(51) // hlavička + 50 řádků
    expect(html).toContain('Firma 001')
    expect(html).not.toContain('Firma 051')
    expect(html).toContain('700 firem')
    expect(html).toContain('>Hodnota<') // sloupce Firma · Stav · Další krok · Vlastník · Hodnota
    expect(html).toContain('>Další krok<')
    expect(html).toContain('stav=aktivni') // segment „Aktivní"
    expect(html).toContain('aria-label="Klienti a partneři"') // záložky Firmy / Partneři / Hledat
    // Modul Partneři je u firmy vypnutý (CompanyConfig.modules.partners).
    expect(html).not.toContain('href="/cockpit/partners"')
    expect(html).toContain('aria-label="Stránkování seznamu klientů"')
    expect(html).toContain('aria-current="page"')
    expect(html).toContain('href="/cockpit/clients?page=2"')
    expect(html).toContain('href="/cockpit/clients?page=14"')
    expect(html).toContain('href="/cockpit/clients/doplnit-ico"')
    expect(html).toContain('350 klientů nemá vyplněné IČO')
  })

  test('počet dotazů nezávisí na počtu firem (70 vs. 700) ani na řazení podle pipeline', async () => {
    const small = setup({ total: 70, sales: true })
    await render()
    const smallCalls = small.calls.length

    const big = setup({ total: 700, sales: true })
    await render()
    expect(big.calls.length).toBe(smallCalls)

    const pipeline = setup({ total: 700, sales: true })
    await render({ sort: 'pipeline' })
    expect(pipeline.calls.length).toBe(smallCalls + 1) // + firmy s pipeline
  })

  test('neobchodní role: obchody se nenačítají, sloupce pipeline ani stav „aktivní" nejsou', async () => {
    const fake = setup({ total: 700, sales: false })
    const html = await render({ sort: 'pipeline', stav: 'aktivni' })

    expect(getSalesDeals).not.toHaveBeenCalled()
    expect(fake.calls).toHaveLength(3)
    expect(html).not.toContain('>Hodnota<')
    expect(html).not.toContain('Další krok')
    expect(html).not.toContain('stav=aktivni')
    expect(html).not.toContain('value="aktivni"')
    expect(html).not.toContain('value="pipeline"')
    // pipeline/aktivni z URL se zahodí → řazení podle názvu, bez filtru stavu
    const page = fake.calls.find((c) => opArgs(c, 'range'))!
    expect(page.ops.filter((o) => o.method === 'order').map((o) => o.args[0])).toEqual(['name', 'id'])
    expect(page.ops.some((o) => o.method === 'in')).toBe(false)
  })

  test('filtr v URL se promítne do formuláře a pageru; prázdný výsledek ukáže prázdný stav', async () => {
    setup({ total: 0, sales: true })
    const html = await render({ q: 'zzz', obor: 'Výroba', page: '3' })
    expect(html).toContain('Filtru neodpovídá žádná firma.')
    expect(html).toContain('value="zzz"')
    expect(html).toContain('Zrušit filtry')
    expect(html).not.toContain('aria-label="Stránkování seznamu klientů"')
  })

  test('řádek je celý klikací (jeden odkaz na řádek), stav jako segmenty, jedna hlavní akce', async () => {
    setup({ total: 70, sales: true })
    const html = await render({ stav: 'klient' })
    // odkaz na detail roztáhne klikací plochu přes celý řádek (tr je relative)
    expect(html).toMatch(/<tr class="relative[^"]*"/)
    expect(html).toMatch(/<a href="\/cockpit\/clients\/1" class="[^"]*after:absolute after:inset-0/)
    // segmenty stavu: aktivní segment má aria-current, stav se drží i ve formuláři
    expect(html).toContain('aria-label="Filtr podle stavu firmy"')
    expect(html).toMatch(/<a href="\/cockpit\/clients\?stav=klient" class="seg-item[^"]*" aria-current="page">Klienti/)
    expect(html).toContain('name="stav" value="klient"')
    expect(html.match(/btn-primary/g)).toHaveLength(1)
    expect(html).toContain('href="/cockpit/clients/new"')
  })

  test('prázdná evidence: prázdný stav s akcí Založit klienta', async () => {
    setup({ total: 0, sales: false })
    const html = await render()
    expect(html).toContain('Zatím tu nejsou žádní klienti.')
    expect(html).toMatch(/<a href="\/cockpit\/clients\/new" class="btn btn-outline[^"]*">Založit klienta<\/a>/)
  })

  test('druhá stránka zachová filtry v odkazech pageru', async () => {
    setup({ total: 700, sales: true })
    const html = await render({ q: 'firma', page: '2' })
    expect(html).toContain('href="/cockpit/clients?q=firma"') // předchozí = stránka 1
    expect(html).toContain('href="/cockpit/clients?q=firma&amp;page=3"')
    expect(html).toContain('zobrazeno 51–100')
  })
})
