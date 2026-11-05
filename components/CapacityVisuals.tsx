// Grafika kapacit: půlkruh využití týmu a tečková matice týdnů. Čisté
// serverové komponenty nad daty z domain/delivery/capacity.ts (žádné dotazy,
// žádná vymyšlená čísla). Každý graf má role="img" a aria-label; barva osoby
// není jediný nositel informace — hodiny jsou vždy vypsané textem.
import { formatHoursValue, formatWeekRange, weekLabel, type IsoWeek, type WeekLoad } from '@/domain/delivery/capacity'

/** Barvy osob v grafech: datové a textové tóny značky (≥ 3:1 vůči bílé; text
 *  v nich nikdy není). Červená chybí záměrně – ta znamená „nad kapacitou“. */
export const PERSON_COLORS = [
  'var(--d-violet)', 'var(--d-blue)', 'var(--d-turquoise)', 'var(--d-yellow)',
  'var(--d-graphite)', 'var(--t-violet)', 'var(--t-blue)', 'var(--t-turquoise)',
]
export const personColor = (i: number) => PERSON_COLORS[i % PERSON_COLORS.length]
const FREE = 'var(--d-track)'
const OVER = 'var(--t-red)'
const EMPTY_DOT = 'var(--c-hatch-line)'

export type VisualPerson = { id: string; name: string; capacity: number; weeks: WeekLoad[] }

const hoursOf = (p: VisualPerson) => p.weeks.reduce((s, w) => s + w.load, 0)

// --- Půlkruh využití ---------------------------------------------------------

export function CapacityGauge({ people, weeksCount }: { people: VisualPerson[]; weeksCount: number }) {
  const totalCap = people.reduce((s, p) => s + p.capacity * weeksCount, 0)
  const rows = people.map((p, i) => ({ p, hours: hoursOf(p), color: personColor(i) }))
  const totalLoad = rows.reduce((s, r) => s + r.hours, 0)
  const pct = totalCap > 0 ? Math.round((totalLoad / totalCap) * 100) : 0
  const free = Math.max(0, totalCap - totalLoad)

  // Segmenty půlkruhu (pathLength 100), po sobě, dohromady nejvýš 100.
  const segs = rows.map((r, i) => {
    const before = rows.slice(0, i).reduce((sum, x) => sum + (totalCap > 0 ? (x.hours / totalCap) * 100 : 0), 0)
    const offset = Math.min(before, 100)
    const share = totalCap > 0 ? Math.min((r.hours / totalCap) * 100, 100 - offset) : 0
    return { ...r, share, offset }
  })
  const label = `Využití týmu: ${pct} % z ${formatHoursValue(totalCap)} h za ${weeksCount} týdnů. ${rows
    .map((r) => `${r.p.name} ${formatHoursValue(r.hours)} h`)
    .join(', ')}, volno ${formatHoursValue(free)} h.`
  const ARC = 'M20 100 A80 80 0 0 1 180 100'
  return (
    <div>
      <div className="relative mx-auto h-[104px] w-[200px]">
        <svg viewBox="0 0 200 104" className="block h-[104px] w-[200px]" role="img" aria-label={label}>
          <path d={ARC} pathLength={100} fill="none" stroke={FREE} strokeWidth={22} />
          {segs.map((s) =>
            s.share > 0 ? (
              <path
                key={s.p.id}
                d={ARC}
                pathLength={100}
                fill="none"
                stroke={s.color}
                strokeWidth={22}
                strokeDasharray={`${s.share} ${100 - s.share}`}
                strokeDashoffset={-s.offset}
              />
            ) : null
          )}
        </svg>
        <div aria-hidden="true" className="big-num absolute inset-x-0 bottom-0 text-center text-[38px]">{pct} %</div>
      </div>
      <p className="mb-2 mt-1 text-center text-[12.5px] font-semibold leading-snug text-muted">
        obsazeno z {formatHoursValue(totalCap)} h za {weeksCount} týdnů
      </p>
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {rows.map((r) => (
          <li key={r.p.id} className="flex items-center gap-2.5 text-[13.5px] font-semibold text-ink-2">
            <i aria-hidden="true" className="h-[11px] w-[11px] flex-none rounded-full" style={{ background: r.color }} />
            <span className="min-w-0 truncate">{r.p.name}</span>
            <b className="ml-auto pl-2 text-ink">{formatHoursValue(r.hours)} h</b>
          </li>
        ))}
        <li className="flex items-center gap-2.5 text-[13.5px] font-semibold text-ink-2">
          <i aria-hidden="true" className="h-[11px] w-[11px] flex-none rounded-full" style={{ background: FREE }} />
          Volno<b className="ml-auto pl-2 text-ink">{formatHoursValue(free)} h</b>
        </li>
      </ul>
    </div>
  )
}

// --- Tečková matice týdnů ----------------------------------------------------

const DOT_HOURS = 4 // 1 tečka = půl dne
const MAX_DOTS = 24

function Dots({ w, color, who }: { w: WeekLoad; color: string; who: string }) {
  const capDots = Math.min(MAX_DOTS, Math.ceil(w.capacity / DOT_HOURS))
  const filled = Math.min(MAX_DOTS, w.load > 0 ? Math.max(1, Math.round(w.load / DOT_HOURS)) : 0)
  const total = Math.max(capDots, filled)
  return (
    <div
      role="img"
      aria-label={`${who}, ${weekLabel(w.week)}: ${formatHoursValue(w.load)} z ${formatHoursValue(w.capacity)} h${w.overloaded ? ', přetížení' : ''}`}
      className="grid justify-center gap-1"
      style={{ gridTemplateRows: 'repeat(2, 11px)', gridAutoFlow: 'column' }}
    >
      {Array.from({ length: total }, (_, i) => (
        <i
          key={i}
          aria-hidden="true"
          className="h-[11px] w-[11px] rounded-full"
          style={{ background: i < filled ? (i >= capDots ? OVER : color) : EMPTY_DOT }}
        />
      ))}
    </div>
  )
}

export function CapacityDotMatrix({ people, weeks, currentWeekKey }: { people: VisualPerson[]; weeks: IsoWeek[]; currentWeekKey: string }) {
  const cols = `minmax(96px,120px) repeat(${weeks.length}, minmax(52px, 1fr))`
  return (
    <div className="overflow-x-auto">
      <div className="min-w-[600px]">
        <div className="mb-1.5 grid items-end px-2" style={{ gridTemplateColumns: cols }}>
          <div />
          {weeks.map((w) => (
            <div key={w.key} className="text-center font-mono text-xs font-medium leading-tight text-ink-2">
              <span className={`inline-block rounded-full px-3 py-0.5 ${w.key === currentWeekKey ? 'bg-navy text-white' : ''}`}>{weekLabel(w)}</span>
              <small className="block font-body text-[11.5px] font-medium text-muted">{formatWeekRange(w).split(' – ')[0]}</small>
            </div>
          ))}
        </div>
        <div className="flex flex-col gap-2">
          {people.map((p, i) => (
            <div key={p.id} className="grid min-h-[56px] items-center rounded-[20px] bg-[color:var(--c-soft)] p-2" style={{ gridTemplateColumns: cols }}>
              <div className="min-w-0 pr-2">
                <b className="block truncate text-[13.5px] leading-tight">{p.name}</b>
                <small className="mt-px block text-xs font-semibold text-ink-2">{formatHoursValue(hoursOf(p))} h</small>
              </div>
              {p.weeks.map((w) => (
                <Dots key={w.week.key} w={w} color={personColor(i)} who={p.name} />
              ))}
            </div>
          ))}
        </div>
      </div>
      <p className="m-0 mt-3 flex flex-wrap gap-x-5 gap-y-1 text-[12.5px] font-semibold text-ink-2">
        <span>1 tečka = půl dne ({DOT_HOURS} h)</span>
        <span className="inline-flex items-center gap-1.5"><i aria-hidden="true" className="h-[11px] w-[11px] rounded-full" style={{ background: EMPTY_DOT }} />volno</span>
        <span className="inline-flex items-center gap-1.5"><i aria-hidden="true" className="h-[11px] w-[11px] rounded-full" style={{ background: OVER }} />nad kapacitou</span>
      </p>
    </div>
  )
}
