// „Kdo na tom pracuje" na stránce dodávky (kap. 10, migrace 0062): alokace
// této dodávky, úprava přes ?alokace=<id>, ukončení a přidání člověka.
// Celkové vytížení lidí (i přes jiné dodávky) je na /kapacity.
import { WorkNotice } from '@/components/WorkUi'
import { FeaturePending } from '@/components/ui/FeaturePending'
import Link from 'next/link'
import { AllocationTable, type AllocationListRow } from '@/components/AllocationTable'
import { AllocationCreateForm, AllocationEditForm, type PersonOption } from '@/components/AllocationForms'
import { formatHours } from '@/domain/delivery/capacity'


// 1 člověk / 2–4 lidé / 5+ lidí, se shodou slovesa.
function peopleCount(n: number): string {
  if (n === 1) return 'pracuje 1 člověk'
  if (n >= 2 && n <= 4) return `pracují ${n} lidé`
  return `pracuje ${n} lidí`
}

export function EngagementAllocations({
  accountId,
  engagementId,
  members,
  today,
  editId,
  state,
  allocations,
}: {
  accountId: number
  engagementId: number
  members: PersonOption[]
  today: string
  editId: number | null
} & (
  | { state: 'missing_migration'; allocations?: undefined }
  | { state: 'error'; allocations?: undefined }
  | { state: 'ok'; allocations: AllocationListRow[] }
)) {
  if (state === 'missing_migration') {
    return (
      <FeaturePending card variant="compact" migration="0062">
        Pak tu půjde zapsat, kdo na dodávce pracuje, kolik hodin týdně a kdo ho zastoupí.
      </FeaturePending>
    )
  }
  if (state === 'error') {
    return <WorkNotice title="Alokace se nepodařilo načíst">Zkus to prosím později.</WorkNotice>
  }
  const basePath = `/cockpit/clients/${accountId}/engagements/${engagementId}/edit`
  const editing = editId !== null ? allocations.find((a) => a.id === editId) : undefined
  const running = allocations.filter((a) => a.status === 'active')
  const runningPeople = new Set(running.map((a) => a.member_id)).size
  const weekly = running.reduce((sum, a) => sum + a.hours_per_week, 0)
  return (
    <div className="flex flex-col gap-4">
      <p className="m-0 text-callout text-muted">
        {runningPeople > 0
          ? `Teď na dodávce ${peopleCount(runningPeople)}, celkem ${formatHours(weekly)} týdně.`
          : 'Teď na dodávce nikdo alokovaný není.'}{' '}
        Celkové vytížení lidí je na stránce <Link href="/cockpit/kapacity" className="underline">Kapacity</Link>.
      </p>
      {editing && (
        <div id="upravit-alokaci" className="flex flex-col gap-2 scroll-mt-6">
          <h3 className="m-0 font-heading text-title2 font-bold">Upravit alokaci</h3>
          <AllocationEditForm
            key={editing.id}
            allocation={{
              id: editing.id,
              member_id: editing.member_id,
              memberName: editing.memberName,
              targetLabel: editing.target.label,
              hours_per_week: editing.hours_per_week,
              starts_on: editing.starts_on,
              ends_on: editing.ends_on,
              substitute_id: editing.substitute_id,
              note: editing.note,
            }}
            members={members}
            closeHref={`${basePath}?zalozka=tym#kdo-na-tom-pracuje`}
          />
        </div>
      )}
      <AllocationTable
        rows={allocations}
        showTarget={false}
        editHref={(id) => `${basePath}?alokace=${id}#upravit-alokaci`}
        empty="Na dodávce zatím nikdo není alokovaný."
      />
      <h3 className="m-0 font-heading text-title2 font-bold">Přidat člověka</h3>
      {members.length === 0 ? (
        <WorkNotice title="V týmu zatím nikdo není" action={{ href: '/cockpit/tym', label: 'Otevřít tým' }} />
      ) : (
        <AllocationCreateForm members={members} engagement={{ accountId, engagementId }} today={today} />
      )}
    </div>
  )
}
