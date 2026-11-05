import type { DealInvariantViolation } from '@/domain/crm/dealInvariant'

// Důvody, proč obchod patří do inventury (/inventura), a jejich popisky.
// Samostatný modul bez serverových závislostí — importuje ho i klientská
// komponenta InventoryRow.
export type InventoryReason =
  | 'missing_deal_kind' | 'missing_decision_maker' | 'missing_decision_due'
  | DealInvariantViolation

export const INVENTORY_REASON_LABELS: Record<InventoryReason, string> = {
  missing_deal_kind: 'Chybí typ obchodu (workshop/implementace/provoz/jiné).',
  missing_decision_maker: 'Chybí kdo rozhoduje.',
  missing_decision_due: 'Chybí termín rozhodnutí.',
  missing_owner: 'Obchod nemá vlastníka.',
  missing_next_step: 'Chybí další krok s termínem (nebo důvod, proč žádný není).',
}
