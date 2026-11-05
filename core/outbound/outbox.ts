// Napojení outbound agenta na odchozí frontu agent_outbox (kontrakt P3,
// core/agents/outboxPort.ts). Fronta zná druh 'outreach' a source_ref
// 'outreach:<outbound_outreach.id>' (0104) a přenese hlavičky odhlášení
// List-Unsubscribe / List-Unsubscribe-Post do odeslané zprávy; okno
// odesílání a denní limit oslovení hlídá i sama fronta. Stav oslovení
// 'sent' a schválení člověkem přenáší trigger z 0107.
import { OUTBOX_ENQUEUE_RPC, outboxEnqueuePayload, type OutboxEnqueue } from '@/core/agents/outboxPort'
export const OUTREACH_OUTBOX_KIND = 'outreach' as const
export const OUTREACH_SOURCE_REF_RE = /^outreach:[0-9]+$/
export { OUTBOX_ENQUEUE_RPC }

export const outreachSourceRef = (outreachId: number) => `outreach:${outreachId}`

export interface OutreachEnqueue extends Omit<OutboxEnqueue, 'kind' | 'sourceRef' | 'scopeVersionId' | 'priceMapVersion' | 'mode' | 'headers'> {
  outreachId: number
  /** Oslovení je vždy nová zpráva na pracovní adresu (nikdy odpověď ve vlákně). */
  to: string
  /** Hlavičky odhlášení (RFC 2369 / RFC 8058) — P3 je přenese do zprávy. */
  listUnsubscribeUrl: string
}

/** Payload pro RPC agent_outbox_enqueue (snake_case kontraktu + kind 'outreach'). */
export function outreachEnqueuePayload(x: OutreachEnqueue): Record<string, unknown> {
  return outboxEnqueuePayload({
    kind: OUTREACH_OUTBOX_KIND,
    sourceRef: outreachSourceRef(x.outreachId),
    dealId: x.dealId,
    mailboxMemberId: x.mailboxMemberId,
    mode: { to: x.to },
    subject: x.subject,
    text: x.text,
    headers: {
      'List-Unsubscribe': `<${x.listUnsubscribeUrl}>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    },
  })
}

/** Chybí RPC fronty (P3 ještě není nasazený)? Pak se stav nemění a zkusí se to příště. */
export function isMissingOutboxRpc(err: { code?: string | null } | null | undefined): boolean {
  return !!err && (err.code === 'PGRST202' || err.code === '42883')
}
