import type { CountRow, FunnelStep } from '@/domain/crm/agentKpi'

// Trychtýř poptávka → nabídka → potvrzeno → realizováno (P5) a rozpad
// důvodů (eskalace, prohry). Jedna řada = jeden odstín, bez legendy; délka
// pruhu nese velikost, číslo a podíl jsou vždy i textem (barva sama nestačí).
// Najetí ukáže totéž v title (hover vrstva u vodorovných pruhů).

export function AgentFunnel({ steps }: { steps: readonly FunnelStep[] }) {
  const first = steps[0]?.count ?? 0
  if (first === 0) {
    return <p className="m-0 text-callout text-muted">V období nevznikl žádný obchod.</p>
  }
  return (
    <ol className="m-0 grid list-none gap-3 p-0" aria-label="Trychtýř podle fáze obchodu">
      {steps.map((s, i) => {
        const width = first > 0 ? Math.round((s.count / first) * 100) : 0
        const conv = s.pctOfPrevious == null ? null : `${s.pctOfPrevious.toLocaleString('cs-CZ')} % z předchozí fáze`
        const title = `${s.label}: ${s.count}${conv ? ` (${conv})` : ''}`
        return (
          <li key={s.key} title={title}>
            <div className="mb-1 flex items-baseline justify-between gap-3">
              <span className="text-callout font-semibold text-ink">{i + 1}. {s.label}</span>
              <span className="text-callout tabular-nums text-ink">
                {s.count}
                {conv && <span className="ml-2 text-footnote text-muted">{conv}</span>}
              </span>
            </div>
            <div className="bar blue" role="img" aria-label={title}>
              <i style={{ width: `${width}%` }} />
            </div>
          </li>
        )
      })}
    </ol>
  )
}

/** Vodorovné pruhy počtů (důvody eskalace, důvody prohry); řazené od největšího. */
export function AgentBreakdown({ rows, empty, label }: { rows: readonly CountRow[]; empty: string; label: string }) {
  if (rows.length === 0) return <p className="m-0 text-callout text-muted">{empty}</p>
  const max = Math.max(...rows.map((r) => r.count))
  return (
    <ul className="m-0 grid list-none gap-2.5 p-0" aria-label={label}>
      {rows.map((r) => (
        <li key={r.key} title={`${r.label}: ${r.count}`} className="grid grid-cols-[minmax(0,10rem)_1fr_auto] items-center gap-3">
          <span className="truncate text-callout text-ink">{r.label}</span>
          <div className="bar thin violet" aria-hidden="true"><i style={{ width: `${max > 0 ? Math.round((r.count / max) * 100) : 0}%` }} /></div>
          <span className="text-callout tabular-nums text-ink">{r.count}</span>
        </li>
      ))}
    </ul>
  )
}
