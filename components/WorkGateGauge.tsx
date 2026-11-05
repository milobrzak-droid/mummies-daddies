// Půlkruhový ukazatel: kolik z N úseků je splněno. Každý úsek je jeden oblouk
// (zelený splněno, červený nesplněno, šedý nehodnoceno). Význam nese číslo
// uprostřed a popis pro čtečku — barva sama nestačí.

export type GaugeState = boolean | null | undefined

const CX = 110
const CY = 108
const R = 84

function point(deg: number) {
  const rad = (deg * Math.PI) / 180
  return { x: +(CX + R * Math.cos(rad)).toFixed(2), y: +(CY - R * Math.sin(rad)).toFixed(2) }
}

/** Oblouky půlkruhu zleva doprava; `gap` je mezera mezi úseky ve stupních. */
export function gaugeArcs(states: readonly GaugeState[], gap = 5): { d: string; state: GaugeState }[] {
  const n = states.length
  if (n === 0) return []
  const span = 180 / n
  return states.map((state, i) => {
    const from = 180 - i * span - gap / 2
    const to = 180 - (i + 1) * span + gap / 2
    const a = point(i === 0 ? 180 : from)
    const b = point(i === n - 1 ? 0 : to)
    return { d: `M${a.x} ${a.y}A${R} ${R} 0 0 1 ${b.x} ${b.y}`, state }
  })
}

const COLOR = { ok: 'var(--d-turquoise)', bad: 'var(--d-red)', none: 'var(--c-hatch-line)' }

export function gaugeLabel(states: readonly GaugeState[], noun: string): string {
  const ok = states.filter((s) => s === true).length
  const bad = states.filter((s) => s === false).length
  const none = states.length - ok - bad
  return `${ok} z ${states.length} ${noun} splněno${bad ? `, ${bad} nesplněno` : ''}${none ? `, ${none} nehodnoceno` : ''}`
}

export function WorkGateGauge({ states, noun = 'bran', caption = 'bran splněno' }: { states: readonly GaugeState[]; noun?: string; caption?: string }) {
  const ok = states.filter((s) => s === true).length
  return (
    <div className="relative mx-auto" style={{ width: 220, height: 124 }} role="img" aria-label={gaugeLabel(states, noun)}>
      <svg viewBox="0 0 220 124" width="220" height="124" aria-hidden="true">
        <path d="M48 108A62 62 0 0 1 172 108" fill="none" stroke="var(--d-track)" strokeWidth="6" />
        {gaugeArcs(states).map((a, i) => (
          <path key={i} d={a.d} fill="none" strokeWidth="22" stroke={a.state === true ? COLOR.ok : a.state === false ? COLOR.bad : COLOR.none} />
        ))}
      </svg>
      <div className="absolute inset-x-0 bottom-0.5 text-center" aria-hidden="true">
        <div className="big-num text-[34px]">{ok} z {states.length}</div>
        <div className="eyebrow mt-1">{caption}</div>
      </div>
    </div>
  )
}
