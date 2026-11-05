// Auditované tabulky balíku P3 (odchozí fronta, migrace 0104). Vlastník souboru: tento balík;
// core/auditCoverage.ts ho jen spojí. Tvrdý trigger audit_row_change (0064):
// jen id, stavy, kódy, příznaky, počty a časy — předmět, text zprávy, adresy
// příjemce, Message-ID ani id zpráv v Gmailu do auditu nikdy.
import type { AuditCoveragePart } from './auditCoveragePart'

export const OUTBOX_AUDIT: AuditCoveragePart = {
  tables: {
    agent_outbox: {
      ops: ['INSERT', 'UPDATE', 'DELETE'],
      safe: ['approval_request_id', 'approved_at', 'attempts', 'autonomous', 'body_purged_at', 'claimed_at', 'deal_id',
        'error_code', 'kind', 'mailbox_member_id', 'mode', 'prague_day', 'price_map_version', 'scope_version_id', 'sent_at',
        'status', 'stop_reason', 'task_id'],
      ignore: ['updated_at'],
    },
  },
  triggerMigrations: { agent_outbox: '0104_agent_outbox.sql' },
  triggerRedefinitions: {},
  softTriggerMigrations: {},
  softTriggerRedefinitions: {},
}
