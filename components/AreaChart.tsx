import { formatNumber, summarizeSeries, type ValueFormat } from '@/components/Sparkline'

export function summarizeArea(labels: string[], series: AreaSeries[], title?: string, format: ValueFormat = formatNumber): string {
  const period = labels.length ? ` (${labels[0]} – ${labels[labels.length - 1]})` : ''
  const head = title ? `${title}${period}` : `Graf${period}`
  if (series.length === 0 || labels.length === 0) return `${head}: žádná data`
  return `${head}. ` + series.map((s) => summarizeSeries(s.values, s.name, format)).join('. ')
}

export type AreaSeries = { name: string; color: string; values: number[] }

// Hladký area graf (kubické křivky + gradientní výplň), 1–2 řady.
export function AreaChart({
  labels, series, height = 150, label, format = formatNumber,
}: { labels: string[]; series: AreaSeries[]; height?: number; label?: string; format?: ValueFormat }) {
  const W = 320
  const padX = 20
  const top = 22
  const base = height - 15
  const pts = labels.length
  if (pts < 2 || series.length === 0) return null

  const max = Math.max(1, ...series.flatMap((s) => s.values))
  const step = (W - padX * 2) / (pts - 1)
  const xy = (v: number, i: number): [number, number] => [
    padX + i * step,
    base - (v / max) * (base - top),
  ]

  // Kubická křivka přes body (kontrolní body ve 40 % vodorovné vzdálenosti).
  function path(vals: number[]): string {
    const p = vals.map(xy)
    let d = `M ${p[0][0]} ${p[0][1]}`
    for (let i = 0; i < p.length - 1; i++) {
      const [x0, y0] = p[i]
      const [x1, y1] = p[i + 1]
      const dx = (x1 - x0) * 0.4
      d += ` C ${x0 + dx} ${y0} ${x1 - dx} ${y1} ${x1} ${y1}`
    }
    return d
  }

  return (
    <>
      <svg width="100%" height={height} viewBox={`0 0 ${W} ${height}`} preserveAspectRatio="none" role="img"
           aria-label={summarizeArea(labels, series, label ?? series.map((s) => s.name).join(' vs '), format)}>
        <defs aria-hidden="true">
          {series.map((s, i) => (
            <linearGradient key={i} id={`ac-${i}-${s.color.replace(/[^a-zA-Z0-9]/g, '')}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" stopColor={s.color} stopOpacity="0.28" />
              <stop offset="1" stopColor={s.color} stopOpacity="0" />
            </linearGradient>
          ))}
        </defs>
        {series.map((s, i) => {
          const line = path(s.values)
          const last = xy(s.values[s.values.length - 1], s.values.length - 1)
          const first = xy(s.values[0], 0)
          return (
            <g key={s.name} aria-hidden="true">
              <path d={`${line} L ${last[0]} ${base} L ${first[0]} ${base} Z`} fill={`url(#ac-${i}-${s.color.replace(/[^a-zA-Z0-9]/g, '')})`} />
              <path d={line} fill="none" stroke={s.color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />
              {i === 0 && (
                <>
                  <circle cx={first[0]} cy={first[1]} r="4" fill="#fff" stroke={s.color} strokeWidth="2.5" />
                  <circle cx={last[0]} cy={last[1]} r="4" fill="#fff" stroke={s.color} strokeWidth="2.5" />
                </>
              )}
            </g>
          )
        })}
      </svg>
      <table className="sr-only">
        <caption>{label ?? series.map((s) => s.name).join(' vs ')}</caption>
        <thead><tr><th scope="col">Období</th>{series.map((s) => <th key={s.name} scope="col">{s.name}</th>)}</tr></thead>
        <tbody>
          {labels.map((l, i) => (
            <tr key={l}><th scope="row">{l}</th>{series.map((s) => <td key={s.name}>{s.values[i] === undefined ? '—' : format(s.values[i])}</td>)}</tr>
          ))}
        </tbody>
      </table>
      <div className="flex justify-between text-[11px] text-[color:var(--c-slate)] mt-1" aria-hidden="true">
        {labels.map((l) => <span key={l}>{l}</span>)}
      </div>
    </>
  )
}
