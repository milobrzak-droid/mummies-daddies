// Kontrakt konektorů Loop Core (core/connectors/contract.ts, kapitola 11):
// popis konektoru, normalizovaná událost, idempotence, zápis výsledku běhu
// do connector_state a zdraví konektoru (shodné s isStale).
import { afterEach, describe, expect, test, vi } from 'vitest'
import {
  CONNECTOR_HEALTH,
  SYNC_OUTCOMES,
  connectorHealth,
  dedupeEvents,
  descriptorIssues,
  eventKey,
  normalizedEventIssues,
  stateWriteFor,
  type ConnectorDescriptor,
  type NormalizedEvent,
} from '@/core/connectors/contract'
import { isStale, type ConnectorState } from '@/core/connectorState'

vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn() }))

const D: ConnectorDescriptor = {
  key: 'test:inbox',
  system: 'test_system',
  kind: 'mail',
  scopes: ['Mail.Read'],
  freshnessHours: 24,
  content: 'metadata_only',
  eventTypes: ['message.inbound'],
}

function ev(over: Partial<NormalizedEvent> = {}): NormalizedEvent {
  return {
    source: 'test:inbox',
    type: 'message.inbound',
    external_id: '<a@x>',
    occurred_at: '2026-09-27T10:00:00.000Z',
    subject: { kind: 'account', id: 1 },
    participants: [{ role: 'from', accountId: 1, contactId: 7, domain: null }],
    evidence: { kind: 'email_message', sourceId: '<a@x>', webLink: 'https://outlook.office.com/mail/x' },
    title: null,
    payload: null,
    ...over,
  }
}

describe('popis konektoru', () => {
  test('platný popis nemá chyby', () => expect(descriptorIssues(D)).toEqual([]))
  test('chyby: klíč, systém, práh, typy', () => {
    const bad = descriptorIssues({ ...D, key: 'Outlook Inbox', system: 'MS Graph', freshnessHours: 0, eventTypes: ['inbound'] })
    expect(bad).toHaveLength(4)
    expect(descriptorIssues({ ...D, eventTypes: [] })).toContain('konektor nevydává žádný typ události')
  })
})

describe('normalizovaná událost', () => {
  test('platná událost sedí k popisu', () => expect(normalizedEventIssues(ev(), D)).toEqual([]))

  test('metadata_only konektor nesmí předat titulek', () => {
    expect(normalizedEventIssues(ev({ title: 'Poptávka' }), D)).toEqual([
      'konektor test:inbox smí předat jen metadata, ne titulek',
    ])
    expect(normalizedEventIssues(ev({ title: 'Poptávka' }), { ...D, content: 'title' })).toEqual([])
  })

  test('účastník nesmí nést adresu, jen doménu', () => {
    const e = ev({ participants: [{ role: 'from', accountId: null, contactId: null, domain: 'jana@acme.cz' }] })
    expect(normalizedEventIssues(e)).toContain('účastník nese adresu místo domény')
  })

  test('external_id: neprázdné, bez okrajových mezer, nejvýš 512 znaků', () => {
    expect(normalizedEventIssues(ev({ external_id: ' <a@x>' }))).toContain('external_id je prázdné nebo má okrajové mezery')
    expect(normalizedEventIssues(ev({ external_id: '' }))).toContain('external_id je prázdné nebo má okrajové mezery')
    expect(normalizedEventIssues(ev({ external_id: 'x'.repeat(513) }))).toContain('external_id je delší než 512 znaků')
  })

  test('occurred_at jen jako ISO v UTC', () => {
    expect(normalizedEventIssues(ev({ occurred_at: '2026-09-27T12:00:00+02:00' }))).toContain('occurred_at není ISO 8601 v UTC')
    expect(normalizedEventIssues(ev({ occurred_at: 'včera' }))).toContain('occurred_at není ISO 8601 v UTC')
  })

  test('evidence se validuje stejně jako v 0038 (jen https)', () => {
    const e = ev({ evidence: { kind: 'email_message', sourceId: '<a@x>', webLink: 'javascript:alert(1)' } })
    expect(normalizedEventIssues(e)).toContain('webLink musí začínat https://')
  })

  test('cizí zdroj nebo typ se k popisu nehodí', () => {
    expect(normalizedEventIssues(ev({ source: 'jiny:zdroj' }), D)).toContain('událost je z jiny:zdroj, konektor test:inbox')
    expect(normalizedEventIssues(ev({ type: 'message.outbound' }), D)).toContain('konektor test:inbox nevydává message.outbound')
  })
})

describe('idempotence', () => {
  test('klíč = zdroj | typ | external_id', () => {
    expect(eventKey(ev())).toBe('test:inbox|message.inbound|<a@x>')
  })
  test('stejná zpráva v Doručené a Odeslané jsou dvě události', () => {
    const a = ev()
    const b = ev({ source: 'test:sent', type: 'message.outbound' })
    expect(eventKey(a)).not.toBe(eventKey(b))
  })
  test('deduplikace drží první výskyt a pořadí', () => {
    const a1 = ev({ occurred_at: '2026-09-27T10:00:00.000Z' })
    const b = ev({ external_id: '<b@x>' })
    const a2 = ev({ occurred_at: '2026-09-28T10:00:00.000Z' })
    expect(dedupeEvents([a1, b, a2])).toEqual([a1, b])
  })
})

describe('výsledek běhu → connector_state', () => {
  test('každý výsledek má zápis', () => {
    const map = Object.fromEntries(SYNC_OUTCOMES.map((o) => [o, stateWriteFor(o, 'chyba').kind]))
    expect(map).toEqual({
      caught_up: 'success',
      more_pending: 'none',
      throttled: 'none',
      expired: 'error',
      error: 'error',
      missing_scope: 'error',
      not_started: 'none',
    })
  })
  test('chyba nese zprávu, bez ní aspoň výsledek', () => {
    expect(stateWriteFor('error', 'Graph 500')).toEqual({ kind: 'error', message: 'Graph 500' })
    expect(stateWriteFor('expired')).toEqual({ kind: 'error', message: 'expired' })
  })
})

describe('zdraví konektoru', () => {
  afterEach(() => vi.useRealTimers())
  const NOW = Date.parse('2026-09-28T08:00:00.000Z')
  const state = (last: string | null, errors: number): ConnectorState => ({
    connector: 'test:inbox',
    cursor: null,
    last_success_at: last,
    last_error: errors ? 'x' : null,
    last_error_at: errors ? '2026-09-28T07:00:00.000Z' : null,
    consecutive_errors: errors,
    updated_at: '2026-09-28T07:00:00.000Z',
  })

  test('rozlišení důvodu', () => {
    expect(connectorHealth(D, null, NOW)).toBe('never_ran')
    expect(connectorHealth(D, state(null, 0), NOW)).toBe('never_ran')
    expect(connectorHealth(D, state(null, 1), NOW)).toBe('failing')
    expect(connectorHealth(D, state('2026-09-28T07:00:00.000Z', 3), NOW)).toBe('failing')
    expect(connectorHealth(D, state('2026-09-26T07:00:00.000Z', 0), NOW)).toBe('stale')
    expect(connectorHealth(D, state('2026-09-28T07:00:00.000Z', 2), NOW)).toBe('ok')
  })

  test('ok právě tehdy, když isStale(state, freshnessHours) = false', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const lasts = [null, '2026-09-28T07:59:59.000Z', '2026-09-27T08:00:00.000Z', '2026-09-27T07:59:59.000Z', '2026-09-01T00:00:00.000Z']
    const cases: (ConnectorState | null)[] = [null]
    for (const last of lasts) for (const errors of [0, 1, 2, 3, 7]) cases.push(state(last, errors))
    for (const s of cases) {
      const health = connectorHealth(D, s, NOW)
      expect(CONNECTOR_HEALTH).toContain(health)
      expect(health === 'ok', JSON.stringify(s)).toBe(!isStale(s, D.freshnessHours))
    }
  })
})
