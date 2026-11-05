// Napojení outbound agenta na odchozí frontu agent_outbox (kontrakt P3,
// core/agents/outboxPort.ts). Kontrakt zná kind offer|info_request|follow_up;
// P7 přidává kind 'outreach' a source_ref 'outreach:<outbound_outreach.id>'
// (migrace 0107 rozšíří CHECK fronty, pokud už existuje). P3 musí 'outreach'
// přijmout v agent_outbox_enqueue — viz docs/OUTBOUND.md, oddíl Integrace.
import { OUTBOX_ENQUEUE_RPC, outboxEnqueuePayload, type OutboxEnqueue } from '@/core/agents/outboxPort'

export const OUTREACH_OUTBOX_KIND = 'outreach' as const
export const OUTREACH_SOURCE_REF_RE = /^outreach:[0-9]+$/
export { OUTBOX_ENQUEUE_RPC }

export const outreachSourceRef = (outreachId: number) => `outreach:${outreachId}`

export interface OutreachEnqueue extends Omit<OutboxEnqueue, 'kind' | 'sourceRef' | 'scopeVersionId' | 'priceMapVersion' | 'mode'> {
  outreachId: number
  /** Oslovení je vždy nová zpráva na pracovní adresu (nikdy odpověď ve vlákně). */
  to: string
  /** Hlavičky odhlášení (RFC 2369 / RFC 8058) — P3 je přenese do zprávy. */
  listUnsubscribeUrl: string
}

/** Payload pro RPC agent_outbox_enqueue (snake_case kontraktu + kind 'outreach'). */
export function outreachEnqueuePayload(x: OutreachEnqueue): Record<string, unknown> {
  const base = outboxEnqueuePayload({
    // Kontraktní typ druh 'outreach' nezná; přepíše se níž.
    kind: 'follow_up',
    sourceRef: outreachSourceRef(x.outreachId),
    dealId: x.dealId,
    mailboxMemberId: x.mailboxMemberId,
    mode: { to: x.to },
    subject: x.subject,
    text: x.text,
  })
  return {
    ...base,
    kind: OUTREACH_OUTBOX_KIND,
    headers: {
      'List-Unsubscribe': `<${x.listUnsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  }
}

/** Chybí RPC fronty (P3 ještě není nasazený)? Pak se stav nemění a zkusí se to příště. */
export function isMissingOutboxRpc(err: { code?: string | null } | null | undefined): boolean {
  return !!err && (err.code === 'PGRST202' || err.code === '42883')
}
