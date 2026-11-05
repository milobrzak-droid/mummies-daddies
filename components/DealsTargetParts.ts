import { TARGET_STATUS_LABEL, type TargetListCounts } from '@/domain/crm/targetLists'
import type { SegmentedPart } from '@/components/DealsVisuals'

// Barvy stavů firem v cílovém seznamu (pro skládaný pruh).
export function targetStatusParts(c: TargetListCounts): SegmentedPart[] {
  return [
    { label: TARGET_STATUS_LABEL.navrzeno, value: c.navrzeno, color: 'var(--d-neutral)' },
    { label: TARGET_STATUS_LABEL.osloveno, value: c.osloveno, color: 'var(--d-blue)' },
    { label: TARGET_STATUS_LABEL.odpovedel, value: c.odpovedel, color: 'var(--d-turquoise)' },
    { label: TARGET_STATUS_LABEL.vyrazeno, value: c.vyrazeno, color: 'var(--c-hatch-line)' },
  ]
}
