// KPI agenta (P5): medián a p90 první reakce, rychlost nabídky, trychtýř pro
// fáze cateringu, podíl automaticky vyřízených a rozpad důvodů prohry
// včetně starého volného textu.
import { describe, expect, test } from 'vitest'
import {
  agentActivityRows, attentionRows, computeAgentKpi, formatDuration, parsePeriod, percentile, periodFor,
  type AgentDealRow, type AgentInquiryRow, type AgentOutboxRow,
} from '@/domain/crm/agentKpi'
import { formatLostReason, lostReasonText, normalizeLostReason, parseLostReason } from '@/domain/crm/lostReason'

const period = periodFor('2026-11-05', 30)

const inq = (id: number, over: Partial<AgentInquiryRow> = {}): AgentInquiryRow => ({
  source: 'email', id, received_at: '2026-11-02T08:00:00Z', status: 'decided', decision_kind: 'send_offer',
  reason_codes: [], segment: 'b2b', deal_id: null, account_id: null, quote_total: null, decided_at: null, ...over,
})
const out = (id: number, source_ref: string, over: Partial<AgentOutboxRow> = {}): AgentOutboxRow => ({
  id, kind: 'offer', source_ref, deal_id: null, status: 'sent', stop_reason: null, sent_at: null, prague_day: '2026-11-02', ...over,
})
const deal = (id: number, over: Partial<AgentDealRow> = {}): AgentDealRow => ({
  id, account_id: 1, pillar: 'b2b_akce', phase: 'poptavka', stage: 'kvalifikace', created_at: '2026-11-01T10:00:00Z',
  closed_at: null, won_at: null, lost_reason: null, ...over,
})
const base = { period, inquiries: [], outbox: [], deals: [], mailEvents: [] }

describe('percentil a formát', () => {
  test('lineární interpolace', () => {
    expect(percentile([], 50)).toBeNull()
    expect(percentile([10], 90)).toBe(10)
    expect(percentile([10, 20, 30, 40], 50)).toBe(25)
    expect(percentile([10, 20, 30, 40, 50, 60, 70, 80, 90, 100], 90)).toBeCloseTo(91)
  })
  test('doba čitelně', () => {
    expect(formatDuration(null)).toBe('—')
    expect(formatDuration(45)).toBe('45 min')
    expect(formatDuration(210)).toBe('3,5 h')
    expect(formatDuration(60 * 72)).toBe('3 dny')
  })
  test('období z URL', () => {
    expect(parsePeriod('7')).toBe(7)
    expect(parsePeriod('13')).toBe(30)
    expect(parsePeriod(undefined)).toBe(30)
    expect(periodFor('2026-11-05', 7)).toEqual({ days: 7, from: '2026-10-30', to: '2026-11-05' })
  })
})

describe('computeAgentKpi', () => {
  test('medián a p90 první reakce z fronty i z ručního e-mailu', () => {
    // Pět poptávek přijatých v 8:00 UTC; reakce za 10, 20, 30, 40 min a jedna ručně za 100 min.
    const inquiries = [1, 2, 3, 4].map((id) => inq(id))
    inquiries.push(inq(5, { account_id: 9, decision_kind: 'escalate', reason_codes: ['special_request'] }))
    inquiries.push(inq(6, { decision_kind: 'ask_info' })) // bez reakce
    const outbox = [1, 2, 3, 4].map((id) => out(id, `inquiry:${id}`, { sent_at: `2026-11-02T08:${String(id * 10).padStart(2, '0')}:00Z` }))
    const mailEvents = [
      { account_id: 9, direction: 'outbound', occurred_at: '2026-11-02T09:40:00Z' },
      { account_id: 9, direction: 'outbound', occurred_at: '2026-11-01T09:40:00Z' }, // před poptávkou se nepočítá
      { account_id: 9, direction: 'inbound', occurred_at: '2026-11-02T08:05:00Z' },
    ]
    const k = computeAgentKpi({ ...base, inquiries, outbox, mailEvents })
    expect(k.firstResponse.measured).toBe(5)
    expect(k.firstResponse.waiting).toBe(1)
    expect(k.firstResponse.medianMinutes).toBe(30)
    expect(k.firstResponse.p90Minutes).toBeCloseTo(76)
    // Nabídka: jen odeslané nabídky z fronty; eskalovaná bez nabídky čeká.
    expect(k.offerSpeed.medianMinutes).toBe(25)
    expect(k.offerSpeed.waiting).toBe(1)
    expect(k.escalations).toEqual({ total: 1, byReason: [{ key: 'special_request', label: 'Zvláštní přání', count: 1 }] })
  })

  test('podíl automaticky vyřízených: odeslané bez člověka ÷ skutečné poptávky', () => {
    const inquiries = [
      inq(1), // nabídka odeslaná
      inq(2, { decision_kind: 'ask_info' }), // doptání odeslané
      inq(3), // nabídka zablokovaná bránou
      inq(4, { decision_kind: 'escalate' }), // člověk
      inq(5, { decision_kind: 'not_inquiry' }), // nepočítá se
      inq(6, { source: 'web', status: 'spam', decision_kind: null }), // nepočítá se
      inq(7, { source: 'web' }), // web, odesláno
    ]
    const outbox = [
      out(1, 'inquiry:1', { sent_at: '2026-11-02T08:05:00Z' }),
      out(2, 'inquiry:2', { kind: 'info_request', sent_at: '2026-11-02T08:05:00Z' }),
      out(3, 'inquiry:3', { status: 'blocked' }),
      out(4, 'web:7', { sent_at: '2026-11-02T08:05:00Z' }),
      out(5, 'followup:1:1', { kind: 'follow_up', sent_at: '2026-11-04T08:05:00Z' }),
    ]
    const k = computeAgentKpi({ ...base, inquiries, outbox })
    expect(k.inquiries).toMatchObject({ received: 7, real: 5, email: 5, web: 2 })
    expect(k.autoShare).toEqual({ auto: 3, total: 5, pct: 60 })
    expect(k.outbox).toEqual({ sent: 4, queued: 0, failed: 0, needsAttention: 0, blocked: 1 })
    expect(k.inquiries.byDecision.map((r) => [r.key, r.count])).toEqual([
      ['send_offer', 3], ['ask_info', 1], ['escalate', 1], ['not_inquiry', 1], ['pending', 1],
    ])
  })

  test('mimo období se nepočítá (pražské dny)', () => {
    // 2026-10-06 23:30 UTC = 7. 10. v Praze → v období od 7. 10.
    const p = periodFor('2026-11-05', 30)
    expect(p.from).toBe('2026-10-07')
    const k = computeAgentKpi({ ...base, period: p, inquiries: [inq(1, { received_at: '2026-10-06T21:30:00Z' }), inq(2, { received_at: '2026-10-06T22:30:00Z' })] })
    expect(k.inquiries.received).toBe(1)
  })

  test('trychtýř podle deal.phase pro fáze cateringu', () => {
    const deals = [
      deal(1), deal(2, { phase: null }),
      deal(3, { phase: 'nabidka', stage: 'rozsah_nabidka' }),
      deal(4, { phase: 'nabidka', stage: 'prohráno', closed_at: '2026-11-03', lost_reason: 'cena: levnější konkurence' }),
      deal(5, { phase: 'potvrzeno', stage: 'vyhráno', won_at: '2026-11-04', closed_at: '2026-11-04' }),
      deal(6, { phase: 'realizovano', stage: 'vyhráno', won_at: '2026-11-04', closed_at: '2026-11-04' }),
      deal(7, { phase: 'realizovano', created_at: '2026-08-01T10:00:00Z', closed_at: '2026-08-02' }), // mimo období
    ]
    const k = computeAgentKpi({ ...base, deals })
    expect(k.funnel.map((s) => [s.key, s.count, s.pctOfFirst, s.pctOfPrevious])).toEqual([
      ['poptavka', 6, 100, null],
      ['nabidka', 4, 66.7, 66.7],
      ['potvrzeno', 2, 33.3, 50],
      ['realizovano', 1, 16.7, 50],
    ])
    expect(k.funnel.map((s) => s.label)).toEqual(['Poptávka', 'Nabídka odeslána', 'Potvrzeno', 'Realizováno'])
    expect(k.outcome).toEqual({ won: 2, lost: 1, open: 3, winRatePct: 66.7 })
  })

  test('rozpad důvodů prohry včetně starého volného textu', () => {
    const lost = (id: number, reason: string) => deal(id, { stage: 'prohráno', closed_at: '2026-11-03', lost_reason: reason })
    const deals = [
      lost(1, 'cena: levnější konkurence'), lost(2, 'cena'), lost(3, 'Cena'), // starý text = popisek
      lost(4, 'termin'), lost(5, 'Rozpočet přesunut na Q1'), lost(6, 'neznamy: x'),
    ]
    const k = computeAgentKpi({ ...base, deals })
    expect(k.lostReasons).toEqual([
      { key: 'cena', label: 'Cena', count: 3 },
      { key: '_volny_text', label: 'Volný text bez kódu', count: 2 },
      { key: 'termin', label: 'Termín', count: 1 },
    ])
  })

  test('prázdný vstup nespadne', () => {
    const k = computeAgentKpi(base)
    expect(k.autoShare.pct).toBeNull()
    expect(k.firstResponse.medianMinutes).toBeNull()
    expect(k.funnel.every((s) => s.count === 0 && s.pctOfFirst === null)).toBe(true)
    expect(k.outcome.winRatePct).toBeNull()
  })
})

describe('tabulka a fronta', () => {
  test('řádek rozhodnutí nese jen firmu, segment, rozhodnutí, důvody, stav a odkaz', () => {
    const rows = agentActivityRows(
      [inq(1, { account_id: 3, deal_id: 8, decision_kind: 'escalate', reason_codes: ['vip_contact', 'xyz'] }), inq(2, { received_at: '2026-11-03T08:00:00Z' })],
      [out(1, 'inquiry:1', { status: 'queued' }), out(2, 'inquiry:1:2', { status: 'needs_attention' })],
      new Map([[3, 'ACME s.r.o.']]),
    )
    expect(rows.map((r) => r.key)).toEqual(['inquiry:2', 'inquiry:1'])
    expect(rows[1]).toEqual({
      key: 'inquiry:1', source: 'email', receivedAt: '2026-11-02T08:00:00Z', client: 'ACME s.r.o.', segment: 'b2b',
      decision: 'escalate', decisionLabel: 'Eskalace', reasons: ['VIP kontakt', 'xyz'],
      sendStatus: 'needs_attention', sendLabel: 'Potřebuje pozornost', dealHref: '/cockpit/clients/3/deals/8',
    })
    expect(rows[0]).toMatchObject({ client: null, sendStatus: null, sendLabel: 'Neodesláno', dealHref: null })
  })

  test('fronta k pozornosti: nejstarší nahoře, jen needs_attention a blocked', () => {
    const rows = attentionRows([
      out(1, 'inquiry:1', { status: 'sent' }),
      out(2, 'inquiry:2', { status: 'blocked', prague_day: '2026-11-04', deal_id: 5, stop_reason: 'map_illustrative' }),
      out(3, 'web:3', { status: 'needs_attention', prague_day: '2026-11-01', kind: 'info_request' }),
    ], new Map([[5, 2]]))
    expect(rows.map((r) => [r.id, r.statusLabel, r.kindLabel, r.dealHref])).toEqual([
      [3, 'Potřebuje pozornost', 'Doptání', null],
      [2, 'Zablokováno', 'Nabídka', '/cockpit/clients/2/deals/5'],
    ])
  })
})

describe('důvod prohry jako „kod: poznámka"', () => {
  test('parse, format, normalize, text', () => {
    expect(parseLostReason('cena: drahé')).toEqual({ key: 'cena', note: 'drahé' })
    expect(parseLostReason('jiny_dodavatel')).toEqual({ key: 'jiny_dodavatel', note: '' })
    expect(parseLostReason('Bez odpovědi')).toEqual({ key: 'bez_odpovedi', note: '' })
    expect(parseLostReason('Termín: posunuto')).toEqual({ key: 'termin', note: 'posunuto' })
    expect(parseLostReason('něco jiného')).toEqual({ key: null, note: 'něco jiného' })
    expect(parseLostReason(null)).toEqual({ key: null, note: '' })
    expect(formatLostReason('cena', '  moc  drahé ')).toBe('cena: moc drahé')
    expect(formatLostReason('cena', '')).toBe('cena')
    expect(formatLostReason('neznamy', 'text')).toBe('text')
    expect(normalizeLostReason(' cena:drahé ')).toBe('cena: drahé')
    expect(normalizeLostReason('xyz: volně')).toBe('xyz: volně')
    expect(lostReasonText('cena: drahé')).toBe('Cena — drahé')
    expect(lostReasonText('kapacita')).toBe('Kapacita')
    expect(lostReasonText('Rozpočet')).toBe('Rozpočet')
  })
})
