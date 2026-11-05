// Auditované tabulky balíku P4 (follow-up cadence, migrace 0105). Vlastník souboru: tento balík;
// core/auditCoverage.ts ho jen spojí. Měkký audit (0082): jen id, stavy, data
// a pořadí pokusu. Šablona (klíč) a outbox_source_ref jen názvem v `_columns`.
// MUSÍ sedět s CREATE TRIGGER v supabase/migrations/0105_follow_up_cadence.sql.
import type { AuditCoveragePart } from './auditCoveragePart'

const ALL = ['INSERT', 'UPDATE', 'DELETE'] as const

export const FOLLOWUP_AUDIT: AuditCoveragePart = {
  tables: {
    follow_up_attempt: {
      ops: ALL,
      safe: ['attempt', 'deal_id', 'enqueued_at', 'outbox_id', 'planned_on', 'status', 'stop_reason'],
      ignore: [],
      soft: true,
    },
  },
  triggerMigrations: {},
  triggerRedefinitions: {},
  softTriggerMigrations: {
    follow_up_attempt: '0105_follow_up_cadence.sql',
  },
  softTriggerRedefinitions: {},
}
