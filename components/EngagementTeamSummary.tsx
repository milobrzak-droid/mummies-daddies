import { Avatar } from '@/components/Avatar'
import { FeaturePending } from '@/components/ui/FeaturePending'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { formatHours } from '@/domain/delivery/capacity'
import type { AllocationListRow } from '@/components/AllocationTable'

// Tým a vytížení na přehledu dodávky. Řádek = člověk: kolik hodin týdně
// teď na dodávce má (jen běžící alokace) a kolik to je z jeho týdenní
// kapacity. Vlastník a zástupce jsou vidět i bez alokace.

export type TeamPerson = { id: string; full_name: string }

export type TeamRowModel = {
  id: string
  name: string
  role: string | null
  hours: number
  plannedHours: number
  capacity: number | null
  pct: number | null
}

export function buildTeamRows(opts: {
  allocations: readonly AllocationListRow[]
  people: readonly TeamPerson[]
  capacity: ReadonlyMap<string, number>
  ownerId: string | null
  deputyId: string | null
}): TeamRowModel[] {
  const names = new Map(opts.people.map((p) => [p.id, p.full_name]))
  const ids: string[] = []
  const add = (id: string | null) => { if (id && !ids.includes(id)) ids.push(id) }
  add(opts.ownerId)
  add(opts.deputyId)
  for (const a of opts.allocations) if (a.status !== 'ended') add(a.member_id)
  return ids.map((id) => {
    const mine = opts.allocations.filter((a) => a.member_id === id)
    const hours = mine.filter((a) => a.status === 'active').reduce((s, a) => s + a.hours_per_week, 0)
    const plannedHours = mine.filter((a) => a.status === 'planned').reduce((s, a) => s + a.hours_per_week, 0)
    const capacity = opts.capacity.get(id) ?? null
    return {
      id,
      name: names.get(id) ?? 'Neznámý člen týmu',
      role: id === opts.ownerId ? 'Vlastník dodávky' : id === opts.deputyId ? 'Zástupce, převezme, když vlastník chybí' : null,
      hours,
      plannedHours,
      capacity,
      pct: capacity && capacity > 0 ? Math.round((hours / capacity) * 100) : null,
    }
  })
}

export function EngagementTeamSummary({
  rows, state, tabHref,
}: {
  rows: TeamRowModel[]
  state: 'ok' | 'missing_migration' | 'error'
  tabHref?: string
}) {
  const total = rows.reduce((s, r) => s + r.hours, 0)
  return (
    <Card
      title="Tým a vytížení"
      sub={state === 'ok' && rows.length > 0 ? `${formatHours(total)} týdně celkem` : undefined}
      {...(tabHref ? { href: tabHref, hrefLabel: 'Otevřít tým' } : {})}
    >
      {state === 'missing_migration' ? (
        <FeaturePending variant="compact" migration="0062">Pak tu bude vidět, kdo na dodávce pracuje.</FeaturePending>
      ) : state === 'error' ? (
        <EmptyState compact title="Tým se nepodařilo načíst">Zkus to prosím později.</EmptyState>
      ) : rows.length === 0 ? (
        <EmptyState compact title="Na dodávce zatím nikdo není" action={tabHref ? { href: tabHref, label: 'Přidat člověka' } : undefined}>
          Přidej vlastníka a alokace v záložce Tým.
        </EmptyState>
      ) : (
        <ul className="list-none p-0 m-0">
          {rows.map((r) => (
            <li key={r.id} className="grid grid-cols-[auto_minmax(0,1fr)] sm:grid-cols-[auto_minmax(0,1fr)_170px] items-center gap-x-4 gap-y-2 py-3 border-t border-[color:var(--c-line)] first:border-t-0">
              <Avatar name={r.name} size={44} />
              <div className="min-w-0">
                <b className="block truncate text-headline">{r.name}</b>
                {r.role && <span className="block text-xs text-muted mt-0.5">{r.role}</span>}
                {r.plannedHours > 0 && <span className="block text-xs text-muted mt-0.5">Naplánováno dalších {formatHours(r.plannedHours)} týdně</span>}
              </div>
              <div className="col-span-2 sm:col-span-1">
                {r.hours > 0 ? (
                  <>
                    <div className="big-num text-[28px]">{formatHours(r.hours).replace(' h', '')}<small className="text-xs font-bold text-muted ml-1">h týdně</small></div>
                    {r.pct !== null && r.capacity !== null && (
                      <>
                        <div
                          className={`bar thin mt-2 ${r.pct > 100 ? 'red' : 'blue'}`}
                          role="img"
                          aria-label={`${r.pct} % z týdenní kapacity ${formatHours(r.capacity)}${r.pct > 100 ? ', přetížení' : ''}`}
                        >
                          <i style={{ width: `${Math.min(100, r.pct)}%` }} />
                        </div>
                        <div className="text-xs text-muted mt-1">{r.pct} % z kapacity {formatHours(r.capacity)}</div>
                      </>
                    )}
                  </>
                ) : (
                  <span className="text-sm text-muted">Bez běžící alokace</span>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  )
}
