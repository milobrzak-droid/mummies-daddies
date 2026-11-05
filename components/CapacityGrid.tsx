// Plán proti kapacitě (kap. 10): řádek = člověk, sloupec = ISO týden.
// Buňka ukazuje naplánované hodiny / kapacitu a proužkovaný pruh vytížení
// v barvě osoby; přetížení je zvýrazněné barvou I textem („přetížení +5 h"),
// ne jen barvou. Na mobilu (< md) místo široké tabulky seznam lidí a pod
// každým jeho týdny jako malé dlaždice ve dvou sloupcích; od md tabulka,
// která se při nedostatku místa posouvá do strany se jménem přilepeným vlevo.
import { CARD } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { formatHoursValue, formatWeekRange, weekLabel, type IsoWeek, type WeekLoad } from '@/domain/delivery/capacity'

export type CapacityGridRow = { id: string; name: string; capacity: number; weeks: WeekLoad[]; color?: string }

function Cell({ w, color }: { w: WeekLoad; color: string }) {
  const pct = w.utilization === null ? (w.load > 0 ? 100 : 0) : Math.min(100, Math.round(w.utilization * 100))
  return (
    <td className={`px-3 py-2.5 align-top ${w.overloaded ? 'bg-[color:var(--c-neg-soft)]' : ''}`}>
      <div className="flex min-w-[84px] flex-col gap-1">
        <span className={`tabular-nums whitespace-nowrap ${w.overloaded ? 'font-semibold text-neg' : w.load === 0 ? 'text-muted' : 'text-ink'}`}>
          {formatHoursValue(w.load)} / {formatHoursValue(w.capacity)} h
        </span>
        <span aria-hidden="true" className="bar thin">
          <i style={{ width: `${pct}%`, backgroundColor: w.overloaded ? 'var(--c-neg)' : color }} />
        </span>
        {w.overloaded && (
          <span className="whitespace-nowrap text-[11px] font-medium text-neg">
            přetížení +{formatHoursValue(-w.free)} h
          </span>
        )}
      </div>
    </td>
  )
}

export function CapacityGrid({ rows, weeks, currentWeekKey }: { rows: CapacityGridRow[]; weeks: IsoWeek[]; currentWeekKey: string }) {
  if (rows.length === 0) {
    return (
      <div className={CARD}>
        <EmptyState title="V týmu zatím nikdo není" action={{ href: '/cockpit/tym', label: 'Otevřít tým' }}>
          Plán se ukáže, až bude v týmu aspoň jeden člověk.
        </EmptyState>
      </div>
    )
  }
  return (
    <>
    <ul aria-label="Vytížení lidí po týdnech" className={`${CARD} m-0 list-none p-0 md:hidden`}>
      {rows.map((r) => (
        <li key={r.id} className="border-b border-[color:var(--c-line-2)] px-4 py-4 last:border-0">
          <h3 className="m-0 break-words text-headline font-semibold text-ink">{r.name}</h3>
          <p className="m-0 text-footnote text-muted">kapacita {formatHoursValue(r.capacity)} h/týden</p>
          <ul aria-label={`Týdny — ${r.name}`} className="m-0 mt-3 grid list-none grid-cols-2 gap-2 p-0">
            {r.weeks.map((w) => (
              <MobileWeek key={w.week.key} w={w} color={r.color ?? 'var(--d-violet)'} current={w.week.key === currentWeekKey} />
            ))}
          </ul>
        </li>
      ))}
    </ul>
    <div className={`${CARD} hidden overflow-x-auto md:block`}>
      <table className="w-full text-sm">
        <caption className="sr-only">
          Vytížení lidí po týdnech: naplánované hodiny proti týdenní kapacitě. Přetížené týdny jsou označené textem „přetížení“.
        </caption>
        <thead>
          <tr className="border-b border-border">
            <th
              scope="col"
              className="eyebrow sticky left-0 z-10 bg-surface text-left px-4 py-2.5 whitespace-nowrap"
            >
              Člověk
            </th>
            {weeks.map((w) => (
              <th key={w.key} scope="col" className="text-left font-body px-3 py-2.5 align-bottom whitespace-nowrap">
                <span className="eyebrow block">
                  {weekLabel(w)}
                  {w.key === currentWeekKey && <span className="ml-1 normal-case tracking-normal text-ink">· tento týden</span>}
                </span>
                <span className="block text-[11px] font-normal text-muted">{formatWeekRange(w)}</span>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.id} className="border-b border-[color:var(--c-line-2)] last:border-0">
              <th scope="row" className="sticky left-0 z-10 bg-surface text-left px-4 py-2.5 align-top font-medium text-ink">
                <span className="block max-w-[160px] truncate">{r.name}</span>
                <span className="block text-xs font-normal text-muted whitespace-nowrap">kapacita {formatHoursValue(r.capacity)} h/týden</span>
              </th>
              {r.weeks.map((w) => (
                <Cell key={w.week.key} w={w} color={r.color ?? 'var(--d-violet)'} />
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    </>
  )
}

/** Týden na mobilu: dlaždice s výplní (ne karta v kartě), hodiny, pruh, přetížení slovem. */
function MobileWeek({ w, color, current }: { w: WeekLoad; color: string; current: boolean }) {
  const pct = w.utilization === null ? (w.load > 0 ? 100 : 0) : Math.min(100, Math.round(w.utilization * 100))
  return (
    <li className={`min-w-0 rounded-tile px-3 py-2.5 ${w.overloaded ? 'bg-[color:var(--c-neg-soft)]' : 'bg-[color:var(--c-soft)]'}`}>
      <span className="block text-[11px] font-semibold uppercase tracking-[0.06em] text-muted">
        {weekLabel(w.week)}
        {current && <span className="ml-1 normal-case tracking-normal text-ink">· tento týden</span>}
      </span>
      <span className="block text-[11px] text-muted">{formatWeekRange(w.week)}</span>
      <span className={`mt-1 block tabular-nums ${w.overloaded ? 'font-semibold text-neg' : w.load === 0 ? 'text-muted' : 'text-ink'}`}>
        {formatHoursValue(w.load)} / {formatHoursValue(w.capacity)} h
      </span>
      <span aria-hidden="true" className="bar thin mt-1 block">
        <i style={{ width: `${pct}%`, backgroundColor: w.overloaded ? 'var(--c-neg)' : color }} />
      </span>
      {w.overloaded && (
        <span className="mt-1 block text-[11px] font-medium text-neg">přetížení +{formatHoursValue(-w.free)} h</span>
      )}
    </li>
  )
}
