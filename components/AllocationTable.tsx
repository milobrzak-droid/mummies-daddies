// Seznam alokací (kap. 10): kdo, na čem, kolik hodin, období, stav a zástup.
// Serverová komponenta nad DataTable; úpravu otevírá odkaz s ?alokace=<id>
// (panel s formulářem vykreslí stránka), ukončení je malý klientský
// formulář. Alokace bez zástupu je vidět hned ve sloupci „Zástup".
import Link from 'next/link'
import { DataTable } from '@/components/DataTable'
import { Chip } from '@/components/Chip'
import { AllocationEndButton } from '@/components/AllocationForms'
import {
  ALLOCATION_STATUS_LABEL,
  formatHours,
  formatPeriod,
  type AllocationStatus,
  type DescribedAllocation,
} from '@/domain/delivery/capacity'
import type { AllocationRow } from '@/domain/delivery/queries/capacity'

export type AllocationListRow = DescribedAllocation<AllocationRow>

const STATUS_TONE: Record<AllocationStatus, string> = { active: 'pos', planned: 'info', ended: 'neutral' }

export function AllocationTable({
  rows,
  showTarget,
  editHref,
  empty,
}: {
  rows: AllocationListRow[]
  showTarget: boolean
  editHref: (id: number) => string
  empty: string
}) {
  const label = (r: AllocationListRow) => `${r.memberName}, ${r.target.label}`
  return (
    <DataTable<AllocationListRow> mobile="cards"
      label="Alokace"
      rows={rows}
      empty={empty}
      columns={[
        { header: 'Kdo', cell: (r) => r.memberName },
        ...(showTarget
          ? [
              {
                header: 'Na čem',
                cell: (r: AllocationListRow) => (r.target.href ? <Link href={r.target.href}>{r.target.label}</Link> : r.target.label),
              },
            ]
          : []),
        { header: 'Hodin týdně', cell: (r) => formatHours(r.hours_per_week) },
        { header: 'Období', cell: (r) => <span className="whitespace-nowrap">{formatPeriod(r)}</span> },
        { header: 'Stav', cell: (r) => <Chip tone={STATUS_TONE[r.status]}>{ALLOCATION_STATUS_LABEL[r.status]}</Chip> },
        {
          header: 'Zástup',
          cell: (r) =>
            r.substituteName ?? (r.status === 'ended' ? '—' : <Chip tone="warn">bez zástupu</Chip>),
        },
        { header: 'Poznámka', cell: (r) => (r.note ? <span className="block max-w-[240px] truncate" title={r.note}>{r.note}</span> : '—') },
        {
          header: 'Akce',
          cell: (r) => (
            <span className="flex flex-wrap items-center gap-3">
              <Link href={editHref(r.id)} className="text-sm underline" aria-label={`Upravit alokaci — ${label(r)}`}>
                Upravit
              </Link>
              {r.canEnd && <AllocationEndButton allocationId={r.id} planned={r.status === 'planned'} label={label(r)} />}
            </span>
          ),
        },
      ]}
    />
  )
}
