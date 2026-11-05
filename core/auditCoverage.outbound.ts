// Auditované tabulky outbound agenta (balík P7, migrace 0107). Měkký audit
// (0082): jen id, stavy, číselníky, data, počty a booleany — názvy,
// fakta, texty oslovení, IČO, URL ani otisk e-mailu nikdy.
import type { AuditCoveragePart } from './auditCoveragePart'

const ALL = ['INSERT', 'UPDATE', 'DELETE'] as const
const MIGRATION = '0107_outbound_agent.sql'

export const OUTBOUND_AUDIT: AuditCoveragePart = {
  tables: {
    outbound_outreach: {
      ops: ALL,
      safe: ['account_id', 'basis', 'channel', 'contact_id', 'deal_id', 'decided_at', 'decided_by', 'outbox_id', 'prague_day',
        'signal_id', 'status'],
      ignore: [],
      soft: true,
    },
    outbound_signal: {
      ops: ALL,
      safe: ['account_id', 'attempts', 'contact_id', 'deal_id', 'decided_at', 'decided_by', 'detected_at', 'kind', 'qualified_at',
        'score', 'signal_date', 'source', 'status'],
      ignore: [],
      soft: true,
    },
    outreach_consent: {
      ops: ALL,
      safe: ['contact_id', 'granted_at', 'recorded_by', 'withdrawn_at'],
      ignore: [],
      soft: true,
    },
    outreach_suppression: {
      ops: ALL,
      safe: ['opted_out_at', 'outreach_id', 'recorded_by'],
      ignore: [],
      soft: true,
    },
  },
  triggerMigrations: {},
  triggerRedefinitions: {},
  softTriggerMigrations: {
    outbound_outreach: MIGRATION,
    outbound_signal: MIGRATION,
    outreach_consent: MIGRATION,
    outreach_suppression: MIGRATION,
  },
  softTriggerRedefinitions: {},
}
