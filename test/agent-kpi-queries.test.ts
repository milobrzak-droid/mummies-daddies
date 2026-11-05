// Dotazy stránky agenta (P5) nad fake Supabase: chybějící tabulky agenta
// (42P01) dají prázdný výsledek a „agent není zapnutý", filtr období jde do
// dotazů v pražských dnech a vybírají se jen sloupce bez textu a kontaktů.
import { describe, expect, test, vi } from 'vitest'
import { createSupabaseFake, opArgs, type QueryCall, type QueryResult } from './helpers/supabaseFake'

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(async () => ({})) }))
vi.mock('@/lib/log', () => ({ logError: vi.fn() }))

import { loadAgentOpsSummary, loadAgentOverview } from '@/domain/crm/agentKpiQueries'
import { logError } from '@/lib/log'

const missing = { data: null, error: { code: '42P01', message: 'relation "inquiry_agent_run" does not exist' } }

function fakeWith(tables: Record<string, (call: QueryCall) => QueryResult>) {
  return createSupabaseFake({ resolve: (call) => (tables[call.table] ? tables[call.table](call) : { data: [], error: null }) })
}

describe('loadAgentOverview', () => {
  test('bez tabulek agenta: prázdný výsledek a agentMissing', async () => {
    const fake = fakeWith({ inquiry_agent_run: () => missing, agent_outbox: () => missing })
    const o = await loadAgentOverview({ today: '2026-11-05', days: 30, db: fake.client as never })
    expect(o.agentMissing).toBe(true)
    expect(o.unavailable).toEqual([])
    expect(o.activity).toEqual([])
    expect(o.attention).toEqual([])
    expect(o.kpi.inquiries.received).toBe(0)
    expect(o.shop).toBeNull()
    expect(logError).not.toHaveBeenCalled()
  })

  test('filtr období v pražském čase a jen bezpečné sloupce', async () => {
    const fake = fakeWith({})
    const o = await loadAgentOverview({ today: '2026-11-05', days: 7, db: fake.client as never, withShop: true })
    expect(o.period).toEqual({ days: 7, from: '2026-10-30', to: '2026-11-05' })
    const runs = fake.calls.find((c) => c.table === 'inquiry_agent_run')!
    // 30. 10. 00:00 v Praze (CET) = 29. 10. 23:00 UTC; konec = 6. 11. 00:00 Praha.
    expect(opArgs(runs, 'gte')).toEqual(['received_at', '2026-10-29T23:00:00.000Z'])
    expect(opArgs(runs, 'lt')).toEqual(['received_at', '2026-11-05T23:00:00.000Z'])
    const outbox = fake.calls.filter((c) => c.table === 'agent_outbox')
    expect(outbox.some((c) => JSON.stringify(opArgs(c, 'gte')) === JSON.stringify(['prague_day', '2026-10-30']))).toBe(true)
    expect(outbox.some((c) => JSON.stringify(opArgs(c, 'in')) === JSON.stringify(['status', ['needs_attention', 'blocked']]))).toBe(true)
    const deal = fake.calls.find((c) => c.table === 'deal')!
    expect(opArgs(deal, 'or')).toEqual(['created_at.gte.2026-10-29T23:00:00.000Z,closed_at.gte.2026-10-30'])
    // Žádný text zpráv ani kontakt v select.
    for (const c of fake.calls) {
      const cols = String(opArgs(c, 'select')?.[0] ?? '')
      expect(cols).not.toMatch(/email|phone|body|text|subject|customer_name|note|dedication|address|\*/)
    }
    expect(fake.calls.filter((c) => c.table === 'shop_order')).toHaveLength(2)
    expect(o.shop).toMatchObject({ received: 0, upcoming: [] })
  })

  test('data projdou výpočtem, jména firem se dotáhnou', async () => {
    const fake = fakeWith({
      inquiry_agent_run: () => ({ data: [{ id: 1, received_at: '2026-11-02T08:00:00Z', status: 'enqueued', decision_kind: 'send_offer', reason_codes: [], segment: 'b2b', deal_id: 4, account_id: 7, quote_total: 12000, decided_at: null }], error: null }),
      web_inquiry: () => ({ data: [{ id: 2, received_at: '2026-11-03T08:00:00Z', status: 'decided', decision_kind: 'escalate', reason_codes: ['special_request'], segment: 'b2c', deal_id: null, account_id: null, quote_total: null, decided_at: null }], error: null }),
      agent_outbox: (c) => opArgs(c, 'in')
        ? { data: [{ id: 9, kind: 'offer', source_ref: 'web:2', deal_id: null, status: 'needs_attention', stop_reason: 'x', sent_at: null, prague_day: '2026-10-01' }], error: null }
        : { data: [{ id: 5, kind: 'offer', source_ref: 'inquiry:1', deal_id: 4, status: 'sent', stop_reason: null, sent_at: '2026-11-02T08:30:00Z', prague_day: '2026-11-02' }], error: null },
      account: () => ({ data: [{ id: 7, name: 'ACME s.r.o.' }], error: null }),
    })
    const o = await loadAgentOverview({ today: '2026-11-05', days: 30, db: fake.client as never })
    expect(o.agentMissing).toBe(false)
    expect(o.kpi.firstResponse.medianMinutes).toBe(30)
    expect(o.kpi.autoShare).toEqual({ auto: 1, total: 2, pct: 50 })
    expect(o.activity.map((r) => [r.key, r.client, r.sendStatus])).toEqual([['web:2', null, 'needs_attention'], ['inquiry:1', 'ACME s.r.o.', 'sent']])
    expect(o.attention.map((r) => r.id)).toEqual([9])
    expect(opArgs(fake.calls.find((c) => c.table === 'account')!, 'in')).toEqual(['id', [7]])
  })

  test('jiná chyba se zaloguje a přizná v unavailable', async () => {
    const fake = fakeWith({ deal: () => ({ data: null, error: { code: '57014', message: 'timeout' } }) })
    const o = await loadAgentOverview({ today: '2026-11-05', days: 30, db: fake.client as never })
    expect(o.unavailable).toEqual(['obchody'])
    expect(logError).toHaveBeenCalled()
  })
})

describe('loadAgentOpsSummary', () => {
  test('bez tabulek agenta null', async () => {
    const fake = fakeWith({ inquiry_agent_run: () => missing, agent_outbox: () => missing, web_inquiry: () => ({ data: [], error: null }) })
    expect(await loadAgentOpsSummary({ db: fake.client as never, from: '2026-11-02', to: '2026-11-08' })).toBeNull()
  })
  test('počty za týden', async () => {
    const fake = fakeWith({
      inquiry_agent_run: () => ({ data: [{ decision_kind: 'send_offer', status: 'enqueued' }, { decision_kind: 'escalate', status: 'decided' }, { decision_kind: 'not_inquiry', status: 'decided' }], error: null }),
      web_inquiry: () => ({ data: [{ decision_kind: 'ask_info', status: 'decided' }], error: null }),
      agent_outbox: (c) => opArgs(c, 'in')
        ? { data: [{ status: 'needs_attention' }, { status: 'blocked' }, { status: 'blocked' }], error: null }
        : { data: [{ status: 'sent' }, { status: 'sent' }], error: null },
    })
    expect(await loadAgentOpsSummary({ db: fake.client as never, from: '2026-11-02', to: '2026-11-08' }))
      .toEqual({ inquiries: 3, escalations: 1, sent: 2, needsAttention: 1, blocked: 2 })
  })
})
