// Integrace P5 + P3 + P7 + P9: export KPI agenta, zdroj obchodu z deal.source,
// přehled odchozí fronty a tlačítko „Uvolnit" na /cockpit/agent. Bez sítě a DB.
import { describe, expect, test, vi } from 'vitest'
import type { ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('next/link', () => ({
  default: ({ href, children, ...rest }: { href: string; children: ReactNode }) => <a href={href} {...rest}>{children}</a>,
}))

import {
  EXPORT_ACCESS, EXPORT_PREHLEDY, agentKpiLines, agentKpiTables, dealSourceColumnLabel, dealSourceLabel, shopOrderFilterList,
} from '@/domain/crm/exports'
import {
  attentionRows, computeAgentKpi, isReleasable, outboxKindLabel, outboxQueueOverview, outboxStopReasonLabel, periodFor,
  type AgentOutboxListRow,
} from '@/domain/crm/agentKpi'
import { AgentAttentionTable, AgentOutboxQueueTable } from '@/components/AgentActivityTable'

const period = periodFor('2026-11-05', 30)
const ob = (id: number, over: Partial<AgentOutboxListRow> = {}): AgentOutboxListRow => ({
  id, kind: 'info_request', source_ref: `inquiry:${id}`, deal_id: 4, status: 'sent', stop_reason: null, sent_at: null,
  prague_day: '2026-11-04', created_at: '2026-11-04T08:00:00Z', ...over,
})

describe('export KPI agenta (P5 → P9)', () => {
  test('přehled agent je jen pro obchodní role', () => {
    expect(EXPORT_PREHLEDY).toContain('agent')
    expect(EXPORT_ACCESS.agent).toBe('sales')
  })

  test('tabulky: KPI, rozhodnutí, eskalace, trychtýř, prohry, fronta a rozhodnutí — bez textu a adres', () => {
    const kpi = computeAgentKpi({ period, inquiries: [], outbox: [ob(1), ob(2, { status: 'blocked', stop_reason: 'approval_required' })], deals: [], mailEvents: [] })
    const tables = agentKpiTables({ kpi, activity: [], attention: [{ id: 2, kind: 'info_request', status: 'blocked', stopReason: 'approval_required', day: '2026-11-04' }] })
    expect(tables.map((t) => t.title)).toEqual(['KPI', 'Rozhodnutí agenta', 'Důvody eskalace', 'Trychtýř', 'Důvody prohry', 'Čeká na člověka', 'Poslední rozhodnutí'])
    for (const t of tables) expect(t.title.length).toBeLessThanOrEqual(31)
    const lines = agentKpiLines(kpi)
    expect(lines.find((l) => l.label === 'Odesláno')?.value).toBe(1)
    expect(lines.find((l) => l.label === 'Zablokováno')?.value).toBe(1)
    expect(tables[5].rows[0]).toEqual(['Doptání č. 2', 'Zablokováno', 'approval_required', '2026-11-04'])
  })
})

describe('zdroj obchodu v exportu z deal.source (P2 0103, P7 0107)', () => {
  test('agent poptávek, web, outbound; bez sloupce odvození jako dřív', () => {
    expect(dealSourceColumnLabel('email')).toBe('E-mail (agent poptávek)')
    expect(dealSourceColumnLabel('web')).toBe('Web (formulář poptávky)')
    expect(dealSourceColumnLabel('agent:outbound:vvz')).toBe('Outbound agent (Veřejné zakázky)')
    expect(dealSourceColumnLabel('agent:outbound:neco')).toBe('Outbound agent (neco)')
    expect(dealSourceColumnLabel(null)).toBeNull()
    const base = { sourced_by_partner: null, source_pdf_path: null }
    expect(dealSourceLabel({ ...base, source: 'agent:outbound:crm', import_batch_id: 3 })).toBe('Outbound agent (Stávající klienti v CRM)')
    expect(dealSourceLabel({ ...base, import_batch_id: 3 })).toBe('Hromadný import')
    expect(dealSourceLabel({ ...base, source: '' })).toBe('Ručně v Cockpitu')
  })

  test('filtr objednávek „K vyřízení" v exportu', () => {
    expect(shopOrderFilterList(['new', 'confirmed', 'ready'])).toEqual([{ label: 'Stav', value: expect.stringContaining(',') }])
    expect(shopOrderFilterList(null)).toEqual([])
  })
})

describe('odchozí fronta na /cockpit/agent (P3)', () => {
  test('uvolnit jde doptání / připomínku / oslovení v blocked, failed, needs_attention; nabídku ne', () => {
    expect(isReleasable(ob(1, { status: 'blocked' }))).toBe(true)
    expect(isReleasable(ob(1, { status: 'failed', kind: 'outreach' }))).toBe(true)
    expect(isReleasable(ob(1, { status: 'needs_attention', kind: 'follow_up' }))).toBe(true)
    expect(isReleasable(ob(1, { status: 'blocked', kind: 'offer' }))).toBe(false)
    expect(isReleasable(ob(1, { status: 'sent' }))).toBe(false)
    expect(isReleasable(ob(1, { status: 'blocked', stop_reason: 'gdpr_erased' }))).toBe(false)
    expect(isReleasable(ob(1, { status: 'blocked', kind: 'outreach', stop_reason: 'unsubscribed' }))).toBe(false)
    expect(outboxStopReasonLabel('unsubscribed')).toBe('adresát se odhlásil z obchodních sdělení')
    expect(outboxStopReasonLabel('quote_mismatch')).toMatch(/přegenerovat/)
    expect(outboxKindLabel('outreach')).toBe('Oslovení')
    expect(outboxStopReasonLabel('approval_required')).toBe('čeká na schválení člověkem')
    expect(outboxStopReasonLabel('do_not_contact')).toBe('kontakt nesouhlasí s oslovením')
  })

  test('přehled: počty neukončených stavů a poslední zprávy; tabulky mají Uvolnit a odkaz Ke schválení', () => {
    const recent = [ob(3, { status: 'failed', kind: 'outreach', source_ref: 'outreach:9' }), ob(2, { status: 'blocked', kind: 'offer' }), ob(1)]
    const q = outboxQueueOverview([{ status: 'failed' }, { status: 'blocked' }, { status: 'queued' }, { status: 'queued' }], recent, new Map([[4, 7]]))
    expect(q.open.map((c) => [c.key, c.count])).toEqual([['queued', 2], ['claimed', 0], ['blocked', 1], ['failed', 1], ['needs_attention', 0]])
    expect(q.recent.map((r) => [r.id, r.releasable, r.dealHref])).toEqual([[3, true, '/cockpit/clients/7/deals/4'], [2, false, '/cockpit/clients/7/deals/4'], [1, false, '/cockpit/clients/7/deals/4']])

    const release = vi.fn(async () => ({ success: true }))
    const html = renderToStaticMarkup(<AgentOutboxQueueTable queue={q} release={release} />)
    expect(html).toContain('Oslovení č. 3')
    expect(html).toContain('Uvolnit')
    expect(html).toContain('href="/cockpit/rozhodnuti"')
    expect(html).toContain('name="outboxId" value="3"')

    const att = attentionRows([ob(5, { status: 'needs_attention', stop_reason: 'stale_claim' })], new Map())
    const html2 = renderToStaticMarkup(<AgentAttentionTable rows={att} release={release} />)
    expect(html2).toContain('V Odeslané poště není')
    expect(html2).toContain('ověřit v Odeslané poště')
  })
})
