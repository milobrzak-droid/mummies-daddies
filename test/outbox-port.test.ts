// Kontrakt odchozí fronty (core/agents/outboxPort.ts): payload RPC
// agent_outbox_enqueue a tvar klíče idempotence.
import { describe, expect, test } from 'vitest'
import { OUTBOX_ENQUEUE_RPC, OUTBOX_SOURCE_REF_RE, outboxEnqueuePayload } from '@/core/agents/outboxPort'

describe('outboxEnqueuePayload', () => {
  test('odpověď ve vlákně: snake_case a výchozí null', () => {
    expect(outboxEnqueuePayload({
      kind: 'offer', sourceRef: 'inquiry:12', dealId: 5, scopeVersionId: 9, mailboxMemberId: 'm-1',
      mode: { reply: 'AAMk-graph-id' }, subject: 'Re: Poptávka', text: 'Dobrý den…', priceMapVersion: 'ilustracni-2026-11',
    })).toEqual({
      kind: 'offer', source_ref: 'inquiry:12', deal_id: 5, scope_version_id: 9, mailbox_member_id: 'm-1',
      mode: { reply: 'AAMk-graph-id' }, subject: 'Re: Poptávka', text: 'Dobrý den…', price_map_version: 'ilustracni-2026-11',
    })
  })

  test('nová zpráva (web, follow-up)', () => {
    const p = outboxEnqueuePayload({ kind: 'follow_up', sourceRef: 'followup:5:1', dealId: 5, mailboxMemberId: 'm-1', mode: { to: 'a@b.example' }, subject: 'S', text: 'T' })
    expect(p).toMatchObject({ mode: { to: 'a@b.example' }, scope_version_id: null, price_map_version: null })
    expect(OUTBOX_ENQUEUE_RPC).toBe('agent_outbox_enqueue')
  })

  test('klíč idempotence', () => {
    for (const ok of ['inquiry:1', 'web:42', 'followup:5:2']) expect(OUTBOX_SOURCE_REF_RE.test(ok)).toBe(true)
    for (const bad of ['inquiry:', 'mail:1', 'followup:x:1', 'web:1:2:3']) expect(OUTBOX_SOURCE_REF_RE.test(bad)).toBe(false)
  })
})
