import { OPEN_DEAL_STAGES } from '@/domain/crm/sales'
import type { DealStage } from '@/lib/types'

// Invariant 1 (plán, kap. 5): aktivní obchod má vlastníka a další krok
// s termínem, nebo výslovný důvod, proč žádný není. Nezávislé na názvech
// fází — „aktivní" = OPEN_DEAL_STAGES. Zatím se NEVYNUCUJE při uložení
// (stará data ho mohou porušovat), jen se zobrazuje.

export type DealInvariantInput = {
  stage: DealStage | string
  owner_id?: string | null
  next_step?: string | null
  next_step_due?: string | null
  // Před migrací 0047 sloupec chybí → undefined, bere se jako null.
  no_next_step_reason?: string | null
}

export type DealInvariantViolation = 'missing_owner' | 'missing_next_step'

export const DEAL_INVARIANT_MESSAGES: Record<DealInvariantViolation, string> = {
  missing_owner: 'Obchod nemá vlastníka.',
  missing_next_step: 'Chybí další krok s termínem (nebo důvod, proč žádný není).',
}

const filled = (v: string | null | undefined) => typeof v === 'string' && v.trim() !== ''

export function checkDealInvariant(deal: DealInvariantInput): DealInvariantViolation[] {
  if (!(OPEN_DEAL_STAGES as string[]).includes(deal.stage)) return []
  const out: DealInvariantViolation[] = []
  if (!filled(deal.owner_id)) out.push('missing_owner')
  const hasStep = filled(deal.next_step) && filled(deal.next_step_due)
  if (!hasStep && !filled(deal.no_next_step_reason)) out.push('missing_next_step')
  return out
}

export function isMissingColumnError(error: { code?: string } | null | undefined): boolean {
  return error?.code === '42703' || error?.code === 'PGRST204'
}

// Zápis tolerantní k nenasazené 0047: když DB sloupec nezná, zopakuje se
// zápis bez no_next_step_reason (důvod se tím ztratí, ale nic jiného ne).
export async function writeWithoutMissingReason<R extends { no_next_step_reason?: unknown }>(
  row: R,
  write: (row: Omit<R, 'no_next_step_reason'> | R) => PromiseLike<{ error: { code?: string; message?: string } | null }>,
): Promise<{ error: { code?: string; message?: string } | null }> {
  const first = await write(row)
  if (!first.error || !isMissingColumnError(first.error) || !('no_next_step_reason' in row)) return first
  const { no_next_step_reason: _dropped, ...legacy } = row
  void _dropped
  return write(legacy)
}
