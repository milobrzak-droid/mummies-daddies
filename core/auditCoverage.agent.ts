// Auditované tabulky balíku P2 (inbound agent, migrace 0103). Vlastník souboru: tento balík;
// core/auditCoverage.ts ho jen spojí. MUSÍ sedět s CREATE TRIGGER v 0103_inquiry_agent.sql.
import type { AuditCoveragePart } from './auditCoveragePart'

export const AGENT_AUDIT: AuditCoveragePart = {
  tables: {
    // Fronta agenta poptávek (tvrdý audit jako auto_intake): jen id, stavy, data a počty.
    // Message-ID, id zprávy, schránka, segment, důvody, chybový kód a koncept odpovědi jen názvem.
    inquiry_agent_run: {
      ops: ['INSERT', 'UPDATE', 'DELETE'],
      safe: ['account_id', 'attempts', 'contact_id', 'deal_id', 'decided_at', 'decision_kind', 'mailbox_member_id', 'model_calls',
        'outbox_id', 'received_at', 'scope_version_id', 'status'],
      ignore: ['claimed_at', 'model_called_at', 'next_attempt_at'],
    },
  },
  triggerMigrations: { inquiry_agent_run: '0103_inquiry_agent.sql' },
  triggerRedefinitions: {},
  softTriggerMigrations: {},
  softTriggerRedefinitions: {},
}
