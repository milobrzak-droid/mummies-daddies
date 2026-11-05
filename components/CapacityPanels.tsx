// Panely kapacit: alokace v plánu jako pastelové dlaždice a karta Zástup
// (.card-deep). Serverové komponenty nad už spočtenými daty stránky.
import Link from 'next/link'
import { Avatar } from '@/components/Avatar'
import { EmptyState } from '@/components/ui/EmptyState'
import { personColor } from '@/components/CapacityVisuals'
import { formatHours, formatPeriod, type DescribedAllocation, type SubstitutionSummary } from '@/domain/delivery/capacity'
import type { AllocationRow } from '@/domain/delivery/queries/capacity'

type Described = DescribedAllocation<AllocationRow>

export function AllocationTiles({
  allocations,
  capacityOf,
  colorIndexOf,
  limit = 4,
}: {
  allocations: Described[]
  capacityOf: (memberId: string) => number
  colorIndexOf: (memberId: string) => number
  limit?: number
}) {
  if (allocations.length === 0) {
    return (
      <EmptyState compact title="V plánu zatím není žádná alokace" action={{ href: '#pridat-alokaci', label: 'Přidat alokaci' }}>
        Alokace řekne, kdo na čem kolik hodin týdně pracuje.
      </EmptyState>
    )
  }
  const shown = allocations.slice(0, limit)
  return (
    <>
      <ul className="m-0 grid list-none gap-3.5 p-0 sm:grid-cols-2">
        {shown.map((a) => {
          const hours = Number(a.hours_per_week)
          const cap = capacityOf(a.member_id)
          const pct = cap > 0 ? Math.min(100, Math.round((hours / cap) * 100)) : 100
          return (
            <li key={a.id} className="tile tile-sky flex flex-col gap-2 !p-3.5">
              <div className="flex items-center gap-3">
                <Avatar name={a.memberName} size={48} />
                <div className="min-w-0">
                  <div className="eyebrow !text-[10px] !text-[color:#39414D]">
                    {a.target.href ? <Link href={a.target.href} className="hover:underline">{a.target.label}</Link> : a.target.label}
                  </div>
                  <b className="mt-0.5 block text-[15px] leading-tight">{a.memberName} · {formatHours(hours)} týdně</b>
                  <span className="mt-0.5 block text-[12.5px] leading-tight text-[color:#39414D]">{formatPeriod(a)}</span>
                </div>
              </div>
              <span aria-hidden="true" className="bar thin !bg-white/75">
                <i style={{ width: `${pct}%`, backgroundColor: personColor(colorIndexOf(a.member_id)) }} />
              </span>
              <div className="flex items-center gap-2 text-[12.5px] text-[color:#39414D]">
                {a.substituteName ? (
                  <>Zástup: <b className="text-ink">{a.substituteName}</b></>
                ) : (
                  <b className="text-ink">Bez zástupu</b>
                )}
              </div>
            </li>
          )
        })}
      </ul>
      {allocations.length > shown.length && (
        <p className="m-0 mt-3 text-[12.5px] text-muted">A dalších {allocations.length - shown.length} je v tabulce níže.</p>
      )}
    </>
  )
}

export function DeputiesCard({
  summary,
  names,
  withSubstitute,
  total,
}: {
  summary: SubstitutionSummary[]
  names: ReadonlyMap<string, string>
  withSubstitute: number
  total: number
}) {
  const name = (id: string) => names.get(id) ?? '—'
  const rows = summary.filter((s) => s.substitutes.length > 0 || s.withoutSubstitute > 0)
  return (
    <section className="card-deep p-5" aria-labelledby="zastup-h">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h2 id="zastup-h" className="m-0 font-heading text-title2 font-bold !text-white">Zástup</h2>
        <span className="text-xs font-semibold text-white/85">Kdo koho zastoupí</span>
      </div>
      <ul className="m-0 mt-3.5 flex list-none flex-col gap-2 p-0">
        {rows.length === 0 && (
          <li className="in-pill"><span>Zatím žádná alokace v plánu</span></li>
        )}
        {rows.map((s) => (
          <li key={s.memberId} className={`in-pill ${s.substitutes.length > 0 ? 'w' : ''}`}>
            <span>{name(s.memberId)}</span>
            <span className="text-right text-xs font-bold">
              {s.substitutes.length > 0
                ? `zástup: ${s.substitutes.map(name).join(', ')}`
                : `bez zástupu (${s.withoutSubstitute})`}
            </span>
          </li>
        ))}
        <li className={`in-pill ${total > 0 && withSubstitute === total ? 'g' : ''}`}>
          <span>Alokace se zástupem</span>
          <b>{withSubstitute} z {total}</b>
        </li>
      </ul>
    </section>
  )
}
