// Tvar dílčího seznamu auditovaných tabulek (kontrakt paralelních balíků).
// Každý balík, který zakládá tabulku s audit triggerem, ji zapíše do svého
// souboru core/auditCoverage.<balík>.ts; core/auditCoverage.ts je spojí
// spreadem. Sdílený soubor auditCoverage.ts tak po rozvětvení nikdo nemění.
import type { AuditTableConfig } from './auditCoverage'

export interface AuditCoveragePart {
  /** Tabulky s triggerem (stejný tvar jako DB_AUDITED_TABLES). */
  tables: Readonly<Record<string, AuditTableConfig>>
  /** Tabulka → migrace, která na ni napojuje audit_row_change() (tvrdý audit). */
  triggerMigrations: Readonly<Record<string, string>>
  /** Tabulka → migrace, která na UŽ krytou tabulku tvrdý trigger předefinuje. */
  triggerRedefinitions: Readonly<Record<string, string>>
  /** Tabulka → migrace s audit_row_change_soft() na nové tabulce. */
  softTriggerMigrations: Readonly<Record<string, string>>
  /** Tabulka → migrace, která měkký trigger předefinuje. */
  softTriggerRedefinitions: Readonly<Record<string, string>>
}

export const EMPTY_AUDIT_PART: AuditCoveragePart = {
  tables: {},
  triggerMigrations: {},
  triggerRedefinitions: {},
  softTriggerMigrations: {},
  softTriggerRedefinitions: {},
}
