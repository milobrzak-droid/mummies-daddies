// Kontrakt balíku P3 (odchozí fronta agent_outbox): JEDINÁ cesta, kudy
// Cockpit posílá e-mail zákazníkovi. Do fronty zapisují P2 (nabídka,
// doptání), P4 (follow-up) a P7 (obchodní oslovení, druh 'outreach' —
// doplněno při integraci) voláním RPC agent_outbox_enqueue(p jsonb);
// odesílá jen úloha agent-outbox (P3) po kontrole bran a stop pravidel.
// Zmrazeno základovým balíkem; vlastník po rozvětvení: P3.
//
// RPC: agent_outbox_enqueue(p jsonb) RETURNS jsonb {outbox_id bigint, duplicate boolean}
//   - p = OutboxEnqueue ve snake_case (outboxEnqueuePayload níž),
//   - idempotentní podle source_ref (druhé volání vrátí duplicate = true),
//   - EXECUTE jen service_role. Dokud P3 není nasazený, funkce chybí
//     (PostgREST PGRST202 / Postgres 42883) a volající nechá svůj stav
//     beze změny a zkusí to v dalším běhu.

export type OutboxKind = 'offer' | 'info_request' | 'follow_up' | 'outreach'

/** Hlavičky odhlášení (RFC 2369 / RFC 8058) — povinné u oslovení (P7), jinde žádné. */
export type OutboxHeaders = { 'List-Unsubscribe': string; 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' }

/** Odpověď ve vlákně příchozí zprávy (Graph id), nebo nová zpráva na adresu. */
export type OutboxMode = { reply: string } | { to: string }

export interface OutboxEnqueue {
  kind: OutboxKind
  /**
   * Klíč idempotence (UNIQUE): 'inquiry:<inquiry_agent_run.id>',
   * 'web:<web_inquiry.id>', 'followup:<deal_id>:<pořadí>', 'outreach:<outbound_outreach.id>'.
   */
  sourceRef: string
  dealId: number
  /** deal_scope_version.id u nabídky (kind 'offer'). */
  scopeVersionId?: number | null
  /** Schránka (team_member.id), ze které se odešle. */
  mailboxMemberId: string
  mode: OutboxMode
  subject: string
  /** Text zprávy (vygenerovaný z mapy / šablony). Nikdy text příchozí zprávy. */
  text: string
  /** Verze cenové mapy, ze které nabídka vznikla (audit). */
  priceMapVersion?: string | null
  /** Jen druh 'outreach': hlavičky odhlášení, které fronta přenese do zprávy. */
  headers?: OutboxHeaders | null
}

export type OutboxEnqueueResult = { outbox_id: number; duplicate: boolean }

export const OUTBOX_ENQUEUE_RPC = 'agent_outbox_enqueue'

export const OUTBOX_SOURCE_REF_RE = /^(?:(inquiry|web|followup):[0-9]+(:[0-9]+)?|outreach:[0-9]+)$/

/** Payload pro RPC (snake_case, jak ho čte SQL). */
export function outboxEnqueuePayload(x: OutboxEnqueue): Record<string, unknown> {
  return {
    kind: x.kind,
    source_ref: x.sourceRef,
    deal_id: x.dealId,
    scope_version_id: x.scopeVersionId ?? null,
    mailbox_member_id: x.mailboxMemberId,
    mode: 'reply' in x.mode ? { reply: x.mode.reply } : { to: x.mode.to },
    subject: x.subject,
    text: x.text,
    price_map_version: x.priceMapVersion ?? null,
    ...(x.headers ? { headers: { ...x.headers } } : {}),
  }
}
