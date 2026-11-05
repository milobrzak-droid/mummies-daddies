// Stránka agenta (P5): render s fixture, vypnutý modul = notFound, bez
// obchodní role přesměrování, a v tabulce není e-mail ani text zprávy.
import { beforeEach, describe, expect, test, vi } from 'vitest'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { computeAgentKpi, periodFor, type AgentInquiryRow } from '@/domain/crm/agentKpi'

const state = vi.hoisted(() => ({ agentOn: true, shopOn: true, sales: true, missing: false, lastCtx: null as unknown }))

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => <a href={href} {...rest}>{children}</a>,
}))
vi.mock('next/navigation', async (orig) => ({
  ...(await orig<typeof import('next/navigation')>()),
  usePathname: () => '/cockpit/agent',
  redirect: (to: string) => { throw new Error(`redirect:${to}`) },
}))
vi.mock('@/config', async (orig) => {
  const real = await orig<typeof import('@/config')>()
  const COMPANY = Object.create(real.COMPANY, {
    modules: { get: () => ({ ...real.COMPANY.modules, agent: state.agentOn, shopOrders: state.shopOn }), enumerable: true },
  })
  return { ...real, COMPANY }
})
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(async () => ({})) }))
vi.mock('@/lib/queries/access', () => ({ canCurrentUserSeeSales: vi.fn(async () => state.sales) }))
vi.mock('@/lib/pragueDate', async (orig) => ({ ...(await orig<typeof import('@/lib/pragueDate')>()), pragueToday: () => '2026-11-05' }))

// Fixture záměrně nese e-mail a text, které na stránku nesmí projít
// (dotazy je nečtou; kdyby je někdo přidal do řádků, test to chytí).
const LEAK_EMAIL = 'jana.novakova@example.cz'
const LEAK_TEXT = 'Dobrý den, chtěli bychom raut pro 40 lidí'

vi.mock('@/domain/crm/agentKpiQueries', async () => {
  const k = await import('@/domain/crm/agentKpi')
  const { buildShopOrderOverview } = await import('@/domain/crm/shopOrderOverview')
  return {
    loadAgentOverview: vi.fn(async (ctx: { today: string; days: 7 | 30 | 90; withShop?: boolean }) => {
      state.lastCtx = ctx
      const period = k.periodFor(ctx.today, ctx.days)
      const inquiries = [
        { source: 'email', id: 1, received_at: '2026-11-02T08:00:00Z', status: 'enqueued', decision_kind: 'send_offer', reason_codes: [], segment: 'b2b', deal_id: 4, account_id: 7, quote_total: 12000, decided_at: null, email: LEAK_EMAIL, body: LEAK_TEXT },
        { source: 'web', id: 2, received_at: '2026-11-03T08:00:00Z', status: 'decided', decision_kind: 'escalate', reason_codes: ['special_request'], segment: 'b2c', deal_id: null, account_id: null, quote_total: null, decided_at: null, email: LEAK_EMAIL },
      ] as unknown as AgentInquiryRow[]
      const outbox = [
        { id: 5, kind: 'offer', source_ref: 'inquiry:1', deal_id: 4, status: 'sent', stop_reason: null, sent_at: '2026-11-02T08:30:00Z', prague_day: '2026-11-02' },
        { id: 9, kind: 'offer', source_ref: 'web:2', deal_id: null, status: 'blocked', stop_reason: 'cenova_mapa_ilustracni', sent_at: null, prague_day: '2026-11-03' },
      ]
      const deals = [
        { id: 4, account_id: 7, pillar: 'b2b_akce', phase: 'nabidka', stage: 'rozsah_nabidka', created_at: '2026-11-02T08:00:00Z', lost_reason: null },
        { id: 5, account_id: 7, pillar: 'b2c_oslavy', phase: 'nabidka', stage: 'prohráno', created_at: '2026-11-01T08:00:00Z', closed_at: '2026-11-04', lost_reason: 'cena: drahé' },
      ]
      return {
        period,
        agentMissing: state.missing,
        unavailable: [],
        kpi: k.computeAgentKpi({ period, inquiries, outbox, deals, mailEvents: [] }),
        activity: k.agentActivityRows(inquiries, outbox, new Map([[7, 'ACME s.r.o.']])),
        attention: k.attentionRows(outbox, new Map([[4, 7]])),
        shop: ctx.withShop ? buildShopOrderOverview({
          from: period.from, to: period.to, today: ctx.today, upcoming: [],
          received: [{ id: 31, received_at: '2026-11-04T09:00:00Z', status: 'new', fulfilment_date: '2026-11-08', fulfilment: 'pickup', items: [{ product_key: 'daddy_vanilka', label: 'Daddy vanilkový', quantity: 2 }], total_czk: 1580 }],
        }) : null,
      }
    }),
  }
})

import AgentPage from '@/app/cockpit/agent/page'
import AgentLayout from '@/app/cockpit/agent/layout'

const render = async (obdobi?: string) => renderToStaticMarkup(await AgentPage({ searchParams: Promise.resolve({ obdobi }) }))

beforeEach(() => {
  state.agentOn = true; state.shopOn = true; state.sales = true; state.missing = false
})

describe('/cockpit/agent', () => {
  test('render s fixture: fronta, KPI, trychtýř, důvody, tabulka a objednávky', async () => {
    const html = await render('7')
    expect(state.lastCtx).toMatchObject({ today: '2026-11-05', days: 7, withShop: true })
    expect(html).toContain('Agent na poptávky')
    expect(html).toContain('Čeká na člověka')
    expect(html).toContain('Zablokováno')
    expect(html).toContain('cenova_mapa_ilustracni')
    expect(html).toContain('Vyřízeno automaticky')
    expect(html).toContain('50 %') // 1 ze 2 poptávek
    expect(html).toContain('30 min') // první reakce
    expect(html).toContain('Trychtýř')
    expect(html).toContain('Nabídka odeslána')
    expect(html).toContain('Zvláštní přání')
    expect(html).toContain('ACME s.r.o.')
    expect(html).toContain('/cockpit/clients/7/deals/4')
    expect(html).toContain('Objednávky cheesecaků z webu')
    expect(html).toContain('2× Daddy vanilkový')
    expect(html).toContain('aria-current="page">7 dní')
    // Fronta je nad dlaždicemi KPI.
    expect(html.indexOf('Čeká na člověka')).toBeLessThan(html.indexOf('Vyřízeno automaticky'))
  })

  test('v tabulce není e-mail ani text zprávy', async () => {
    const html = await render()
    expect(html).not.toContain(LEAK_EMAIL)
    expect(html).not.toContain(LEAK_TEXT)
    expect(html).not.toMatch(/[\w.+-]+@[\w-]+\.[\w.]+/)
  })

  test('chybějící tabulky agenta: „agent není zapnutý"', async () => {
    state.missing = true
    expect(await render()).toContain('Agent není zapnutý.')
  })

  test('bez modulu objednávek se karta neukáže', async () => {
    state.shopOn = false
    const html = await render()
    expect(html).not.toContain('Objednávky cheesecaků z webu')
  })

  test('vypnutý modul agent = notFound (stránka i layout)', async () => {
    state.agentOn = false
    await expect(render()).rejects.toThrow(/NEXT_HTTP_ERROR_FALLBACK;404/)
    expect(() => AgentLayout({ children: null })).toThrow(/NEXT_HTTP_ERROR_FALLBACK;404/)
  })

  test('bez obchodní role přesměrování na Cockpit', async () => {
    state.sales = false
    await expect(render()).rejects.toThrow('redirect:/cockpit')
  })
})

test('fixture sedí s čistým výpočtem (sanity)', () => {
  const k = computeAgentKpi({ period: periodFor('2026-11-05', 7), inquiries: [], outbox: [], deals: [], mailEvents: [] })
  expect(k.funnel).toHaveLength(4)
})
