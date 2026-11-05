import { formatCzkShort } from '@/lib/format'

// ── Přístupnost grafů: čisté funkce generující český textový souhrn dat. ──
export type ValueFormat = (v: number) => string

const nf = new Intl.NumberFormat('cs-CZ', { maximumFractionDigits: 2 })
// Čísla bez měny; mezery sjednocené stejně jako v lib/format.ts.
export function formatNumber(v: number): string {
  return nf.format(v).replace(/[\u00a0\u202f]/g, ' ')
}
export const formatCzkValue: ValueFormat = (v) => formatCzkShort(v)

// Souhrn číselné řady: „Nasmlouváno: 6 hodnot, od 120 tis. Kč do 480 tis. Kč (minimum …, maximum …)".
export function summarizeSeries(values: number[], label?: string, format: ValueFormat = formatNumber): string {
  const prefix = label ? `${label}: ` : ''
  const vals = values.filter((v) => Number.isFinite(v))
  if (vals.length === 0) return `${prefix}žádná data`
  if (vals.length === 1) return `${prefix}jediná hodnota ${format(vals[0])}`
  const first = vals[0]
  const last = vals[vals.length - 1]
  const min = Math.min(...vals)
  const max = Math.max(...vals)
  const trend = last > first ? 'rostoucí' : last < first ? 'klesající' : 'beze změny'
  return `${prefix}počet hodnot ${vals.length}, od ${format(first)} do ${format(last)} (${trend}), minimum ${format(min)}, maximum ${format(max)}`
}

// Slovní popis změny: „+12 %" → „nárůst o 12 %", „−3" → „pokles o 3".
export function describeDelta(delta: string | null | undefined): string {
  const t = (delta ?? '').trim()
  if (!t) return ''
  const m = t.match(/^([+\-\u2212\u2013])\s*(.*)$/)
  if (!m) return /^0([.,]0+)?(\s|$)/.test(t) ? `beze změny (${t})` : `změna ${t}`
  const rest = m[2]
  if (/^0([.,]0+)?(\s|$)/.test(rest)) return `beze změny (${t})`
  return m[1] === '+' ? `nárůst o ${rest}` : `pokles o ${rest}`
}

// Deterministic short hash so the gradient <defs> id is unique per distinct
// input without calling an impure function (Math.random) during render.
function hashId(input: string): string {
  let h = 0
  for (let i = 0; i < input.length; i++) {
    h = (h * 31 + input.charCodeAt(i)) | 0
  }
  return Math.abs(h).toString(36)
}

// Hand-rolled inline-SVG area sparkline. Zero deps: builds a smooth path
// through the data points (quadratic-bezier-through-midpoints, a cheap but
// effective smoothing technique) with a soft gradient fill underneath and a
// crisp line on top.
export function Sparkline({
  points,
  color = 'var(--d-turquoise)',
  height = 36,
  width = 200,
  strokeWidth = 2,
  showBaseline = false,
  className,
  label,
}: {
  points: number[]
  color?: string
  height?: number
  width?: number
  strokeWidth?: number
  showBaseline?: boolean
  className?: string
  /** Pokud je zadán, graf je pro čtečky obrázek se souhrnem dat; jinak je dekorativní. */
  label?: string
}) {
  if (!points || points.length < 2) return null

  const pad = strokeWidth
  const min = Math.min(...points)
  const max = Math.max(...points)
  const range = max - min || 1
  const stepX = width / (points.length - 1)
  const coords = points.map((p, i): [number, number] => [
    i * stepX,
    pad + (1 - (p - min) / range) * (height - pad * 2),
  ])

  let linePath = `M ${coords[0][0]},${coords[0][1]}`
  for (let i = 0; i < coords.length - 1; i++) {
    const [x0, y0] = coords[i]
    const [x1, y1] = coords[i + 1]
    const mx = (x0 + x1) / 2
    const my = (y0 + y1) / 2
    linePath += ` Q ${x0},${y0} ${mx},${my}`
  }
  const [lastX, lastY] = coords[coords.length - 1]
  linePath += ` L ${lastX},${lastY}`

  const areaPath = `${linePath} L ${lastX},${height} L 0,${height} Z`
  const gradientId = `spark-grad-${hashId(`${color}-${width}x${height}-${points.join(',')}`)}`

  return (
    <svg
      width="100%"
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      className={className ?? 'block'}
      {...(label
        ? { role: 'img', 'aria-label': summarizeSeries(points, label) }
        : { role: 'presentation', 'aria-hidden': true })}
    >
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.32" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
      </defs>
      {showBaseline && (
        <line x1="0" y1={height - 0.5} x2={width} y2={height - 0.5} stroke={color} strokeOpacity="0.12" strokeWidth="1" />
      )}
      <path d={areaPath} fill={`url(#${gradientId})`} stroke="none" />
      <path d={linePath} fill="none" stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}
