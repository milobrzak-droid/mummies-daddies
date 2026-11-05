// Auditované tabulky vstupu z webu (migrace 0102 základového balíku; další
// tabulky webu přidá balík P6 v 0106 a zapíše je sem). Měkký audit (0082):
// jen stavy, data a cizí klíče — jména, e-maily, telefony, adresy, zprávy
// ani segment nikdy.
import type { AuditCoveragePart } from './auditCoveragePart'

const ALL = ['INSERT', 'UPDATE', 'DELETE'] as const

export const WEB_AUDIT: AuditCoveragePart = {
  tables: {
    shop_order: {
      ops: ALL,
      safe: ['account_id', 'contact_id', 'delivery_czk', 'fulfilment', 'fulfilment_date', 'marketing_consent', 'received_at',
        'status', 'status_changed_at', 'status_changed_by', 'total_czk'],
      ignore: [],
      soft: true,
    },
    web_inquiry: {
      ops: ALL,
      safe: ['account_id', 'attempts', 'contact_id', 'deal_id', 'decided_at', 'decision_kind', 'event_date', 'guests',
        'marketing_consent', 'received_at', 'status'],
      ignore: [],
      soft: true,
    },
  },
  triggerMigrations: {},
  triggerRedefinitions: {},
  softTriggerMigrations: {
    shop_order: '0102_web_intake.sql',
    web_inquiry: '0102_web_intake.sql',
  },
  softTriggerRedefinitions: {},
}
