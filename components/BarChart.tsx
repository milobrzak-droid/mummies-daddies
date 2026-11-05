import { formatNumber, type ValueFormat } from '@/components/Sparkline'

export function summarizeBars(data: BarChartDatum[], caption?: string, format: ValueFormat = formatNumber): string {
  const head = caption ?? 'Sloupcový graf'
  if (data.length === 0) return `${head}: žádná data`
  let hi = data[0]
  let lo = data[0]
  for (const d of data) { if (d.value > hi.value) hi = d; if (d.value < lo.value) lo = d }
  if (data.length === 1) return `${head}: ${data[0].label} ${format(data[0].value)}`
  return `${head}: počet položek ${data.length}, nejvyšší ${hi.label} ${format(hi.value)}, nejnižší ${lo.label} ${format(lo.value)}`
}

export interface BarChartDatum {
  label: string
  value: number
}

// Magnitude = jedna veličina = jeden odstín (ne duha). Přímé hodnoty nad sloupci.
export function BarChart({
  data, caption, color = 'var(--d-blue)', format = (v) => String(v), label,
}: {
  data: BarChartDatum[]
  caption?: string
  color?: string
  format?: (v: number) => string
  /** Název grafu pro čtečky, když chybí caption. */
  label?: string
}) {
  if (data.length === 0) {
    return (
      <div className="bg-surface rounded-card border border-border p-6">
        {caption && <p className="text-muted text-sm mb-2">{caption}</p>}
        <p className="text-muted">Zatím žádná data.</p>
      </div>
    )
  }

  const width = 600
  const height = 200
  const paddingTop = 28
  const paddingBottom = 26
  const plotHeight = height - paddingTop - paddingBottom
  const max = Math.max(1, ...data.map((d) => d.value))
  const slot = width / data.length
  const barWidth = Math.min(64, slot * 0.55)

  return (
    <div className="bg-surface rounded-card border border-border p-6">
      {caption && <p className="text-muted text-sm mb-3">{caption}</p>}
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} role="img" aria-label={summarizeBars(data, caption ?? label, format)}>
        <line x1="0" y1={paddingTop + plotHeight} x2={width} y2={paddingTop + plotHeight} stroke="var(--c-line)" strokeWidth="1" aria-hidden="true" />
        {data.map((d, i) => {
          const barHeight = Math.max(2, (d.value / max) * plotHeight)
          const x = i * slot + (slot - barWidth) / 2
          const y = paddingTop + (plotHeight - barHeight)
          const r = 5
          return (
            <g key={d.label} aria-hidden="true">
              <text x={x + barWidth / 2} y={y - 8} textAnchor="middle" fontFamily="var(--font-body)" fontSize="12" fontWeight="500" fill="var(--c-ink)">
                {format(d.value)}
              </text>
              <path
                d={`M${x},${y + barHeight} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + barWidth - r},${y} Q${x + barWidth},${y} ${x + barWidth},${y + r} L${x + barWidth},${y + barHeight} Z`}
                fill={color}
              />
              <text x={x + barWidth / 2} y={height - paddingBottom + 15} textAnchor="middle" fontFamily="var(--font-body)" fontSize="11" fill="var(--muted)">
                {d.label.length > 12 ? `${d.label.slice(0, 11)}…` : d.label}
              </text>
            </g>
          )
        })}
      </svg>
      <ul className="sr-only">
        {data.map((d) => <li key={d.label}>{d.label}: {format(d.value)}</li>)}
      </ul>
    </div>
  )
}
