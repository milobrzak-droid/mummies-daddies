import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  buildPortfolio,
  portfolioForApi,
  type PortfolioEngagement,
  type PortfolioMilestone,
} from '@/domain/delivery/portfolio'

// Konektor Cowork: get_deliveries (kolik dodávek máme venku a jak jsou na
// tom). Portfolio se tu skládá skutečnou čistou funkcí buildPortfolio,
// mockuje se jen čtení z databáze. Hlídá se: dostupné všem interním rolím
// (scope read i full), přijatou nabídku čte jen obchodní role, žádné částky,
// souhrn podle fáze a stavu, filtry a stránkování.

const ADMIN = { klient: 'servisní' }
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ADMIN }))
const getDeliveryPortfolio = vi.fn()
vi.mock('@/domain/delivery/queries/portfolio', () => ({ getDeliveryPortfolio: (...a: unknown[]) => getDeliveryPortfolio(...a) }))

import { serveMcp } from '@/lib/mcpServer'

const TODAY = '2026-09-29'
const ME = 'user-1'
const OTHER = 'user-2'

const eng = (over: Partial<PortfolioEngagement>): PortfolioEngagement => ({
  id: 1, account_id: 10, account_name: 'ALFATECH', deal_id: 9, kind: 'it', phase: 'pilot', started_on: '2026-09-01',
  due_on: '2026-11-06', owner_id: ME, deputy_id: null, updated_at: '2026-09-28T09:00:00Z', reference_worthy: false,
  handoff_completed_at: '2026-09-05T08:00:00Z', ...over,
})
const ms = (over: Partial<PortfolioMilestone>): PortfolioMilestone => ({
  id: 1, engagement_id: 1, title: 'Procesní mapa', owner_id: ME, deputy_id: null, status: 'v_praci',
  due_on: '2026-10-10', accepted_at: null, updated_at: '2026-09-28T09:00:00Z', ...over,
})

// 1 = v pořádku (moje), 2 = po termínu, 3 = čeká na klienta (můj milník), 4 = blokovaná.
const ITEMS = buildPortfolio({
  today: TODAY,
  engagements: [
    eng({ id: 1 }),
    eng({ id: 2, account_id: 20, account_name: 'Beta', phase: 'implementace', owner_id: OTHER, due_on: '2026-09-01', deal_id: null }),
    eng({ id: 3, phase: 'workshopy', owner_id: OTHER, deal_id: null }),
    eng({ id: 4, account_id: 30, account_name: 'Gama', owner_id: OTHER, deal_id: null }),
  ],
  milestones: [
    ms({ id: 10, engagement_id: 1 }),
    ms({ id: 20, engagement_id: 2, owner_id: OTHER }),
    ms({ id: 30, engagement_id: 3, status: 'ceka_na_vstup' }),
    ms({ id: 40, engagement_id: 4, owner_id: OTHER }),
  ],
  tasks: [{ engagement_id: 4, status: 'blocked', updated_at: '2026-09-28T09:00:00Z' }],
  offers: null,
  dealTitles: new Map([[9, 'Pilot: objednávky']]),
  measures: [],
  cards: [],
  loads: null,
  names: new Map([[ME, 'Viktor Kovář'], [OTHER, 'Lenka Horáková']]),
})

beforeEach(() => {
  getDeliveryPortfolio.mockReset()
  getDeliveryPortfolio.mockResolvedValue({ state: 'ok', items: ITEMS, unavailable: [] })
})

const H = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', 'mcp-protocol-version': '2025-06-18' }
const call = (args: unknown = {}) =>
  new Request('http://localhost/api/mcp', { method: 'POST', headers: H, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'get_deliveries', arguments: args } }) })
const run = async (args: unknown = {}, scope: 'read' | 'full' = 'read', sales = false) =>
  (await (await serveMcp(call(args), ME, scope, sales)).json()).result as { isError?: boolean; content: { text: string }[] }
const data = async (args: unknown = {}, scope: 'read' | 'full' = 'read', sales = false) => {
  const r = await run(args, scope, sales)
  expect(r.isError, r.content[0].text).toBeUndefined()
  return JSON.parse(r.content[0].text)
}
const ids = (out: { items: { id: number }[] }) => out.items.map((i) => i.id)

describe('get_deliveries: kdo smí a co se čte', () => {
  it('každá interní role se scope read i full; servisní klient, nabídka jen s obchodní rolí', async () => {
    for (const scope of ['read', 'full'] as const) {
      for (const sales of [false, true]) {
        await data({}, scope, sales)
        expect(getDeliveryPortfolio).toHaveBeenLastCalledWith({ today: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/), canSeeSales: sales, db: ADMIN, asService: true })
      }
    }
  })

  it('ve výstupu nejsou částky, odkazy do aplikace, kapacity ani slíbený rozsah', async () => {
    const text = JSON.stringify(await data({}, 'read', true))
    for (const key of ['amount', 'czk', 'margin', 'promised', 'href', 'capacity', 'leadership', 'riskScore']) {
      expect(text).not.toContain(key)
    }
  })

  it('chyba hlavního dotazu je chyba nástroje; chybějící vedlejší zdroje se ohlásí', async () => {
    getDeliveryPortfolio.mockResolvedValueOnce({ state: 'error', message: 'boom' })
    const r = await run()
    expect(r.isError).toBe(true)
    expect(r.content[0].text).toContain('Dodávky se nepodařilo načíst: boom')
    getDeliveryPortfolio.mockResolvedValueOnce({ state: 'ok', items: ITEMS, unavailable: ['milníky'] })
    expect((await data()).unavailable).toEqual(['milníky'])
    expect((await data()).unavailable).toBeUndefined()
  })
})

describe('get_deliveries: souhrn a seznam', () => {
  it('souhrn: aktivní, podle fáze (v pořadí fází), po termínu, čeká na klienta, blokované; seznam od nejrizikovějších', async () => {
    const out = await data()
    expect(out.summary).toEqual({
      active: 4,
      by_phase: [
        { phase: 'workshopy', label: 'Degustace', count: 1 },
        { phase: 'pilot', label: 'Zkouška menu', count: 2 },
        { phase: 'implementace', label: 'Realizace', count: 1 },
      ],
      late: 1, waiting_for_client: 1, blocked: 1, stale: 0,
      by_state: { late: 1, blocked: 1, waiting: 1, stale: 0, ok: 1 },
    })
    expect(ids(out)).toEqual([2, 4, 3, 1])
    expect(out).toMatchObject({ total: 4, next_offset: null })
  })

  it('položka: klient, název, vlastník, další milník s termínem, termín a stav', async () => {
    const one = (await data()).items.find((i: { id: number }) => i.id === 1)
    expect(one).toEqual({
      id: 1, account: { id: 10, name: 'ALFATECH' }, title: 'Pilot: objednávky', kind: 'Akce', deal_id: 9,
      phase: 'pilot', phase_label: 'Zkouška menu', owner: 'Viktor Kovář', deputy: null,
      next_milestone: { title: 'Procesní mapa', due_on: '2026-10-10', days_to_due: 11, status: 'V práci' },
      due_on: '2026-11-06', state: 'ok', state_label: 'V pořádku',
      flags: { late: false, blocked: false, waiting_for_client: false, stale: false },
      reasons: [], milestones: { total: 1, accepted: 0 }, days_since_last_move: 1,
    })
    const late = (await data()).items[0]
    expect(late).toMatchObject({ id: 2, state: 'late', state_label: 'Po termínu', reasons: ['Po termínu o 28 dní'] })
  })

  it('jen moje = vlastník klíče je vlastník, zástupce nebo vlastník otevřeného milníku', async () => {
    const out = await data({ only_mine: true })
    expect(ids(out)).toEqual([3, 1])
    expect(out.summary.active).toBe(2)
  })

  it('filtr stavu zúží jen seznam, souhrn zůstává za celý výběr', async () => {
    const out = await data({ state: 'po-terminu' })
    expect(ids(out)).toEqual([2])
    expect(out.total).toBe(1)
    expect(out.summary.active).toBe(4)
    expect(ids(await data({ state: 'blokovane' }))).toEqual([4])
    expect(ids(await data({ state: 'ceka-na-klienta' }))).toEqual([3])
    expect((await run({ state: 'jine' })).isError).toBe(true)
  })

  it('filtr klienta platí pro souhrn i seznam', async () => {
    const out = await data({ account_id: 10 })
    expect(ids(out)).toEqual([3, 1])
    expect(out.summary).toMatchObject({ active: 2, by_phase: [{ phase: 'workshopy', count: 1 }, { phase: 'pilot', count: 1 }] })
  })

  it('stránkování', async () => {
    const first = await data({ limit: 2 })
    expect(ids(first)).toEqual([2, 4])
    expect(first).toMatchObject({ total: 4, next_offset: 2 })
    const second = await data({ limit: 2, offset: 2 })
    expect(ids(second)).toEqual([3, 1])
    expect(second.next_offset).toBeNull()
    expect((await run({ limit: 201 })).isError).toBe(true)
  })
})

describe('portfolioForApi', () => {
  it('neznámá fáze se v souhrnu ukáže až za známými, pod svým klíčem', () => {
    const odd = buildPortfolio({
      today: TODAY, engagements: [eng({ id: 7, phase: 'jina_faze' }), eng({ id: 8, phase: 'sm_diagnostika' })], milestones: [], tasks: [],
      offers: null, dealTitles: new Map(), measures: [], cards: [], loads: null, names: new Map(),
    })
    expect(portfolioForApi(odd, { meId: null }).summary.by_phase).toEqual([
      { phase: 'sm_diagnostika', label: 'Příprava', count: 1 },
      { phase: 'jina_faze', label: 'jina_faze', count: 1 },
    ])
  })

  it('bez přihlášeného (meId null) je „jen moje" prázdné', () => {
    expect(portfolioForApi(ITEMS, { meId: null, onlyMine: true })).toMatchObject({ items: [], total: 0, summary: { active: 0 } })
  })
})
