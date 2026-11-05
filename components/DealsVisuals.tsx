// Grafické prvky sekce Obchody (tabule, detail obchodu, seznamy k oslovení).
// Čistě prezentační komponenty bez dotazů — čísla dostávají z existujících
// queries. Grafy mají role="img" + aria-label se stejnou informací jako text.
import type { CSSProperties, ReactNode } from 'react'
import { CARD, CARD_PAD } from '@/components/ui/Card'
import { formatCzk, formatCzkShort } from '@/lib/format'
import { DEAL_STAGES } from '@/lib/domain'

// ── ikony ────────────────────────────────────────────────────────────────
const PATHS = {
  flag: 'M5 21V4M5 4h11l-2 4 2 4H5',
  calendar: 'M3 5h18v16H3zM8 3v4M16 3v4M3 10h18',
  briefcase: 'M2 7h20v14H2zM16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2M2 13h20',
  plus: 'M12 5v14M5 12h14',
  arrow: 'M7 17 17 7M8 7h9v9',
  check: 'm5 12 5 5 9-10',
  alert: 'M12 8v5M12 16.5h.01M12 3 2 20h20z',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c1-5 4-7 8-7s7 2 8 7',
  target: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
  list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
} as const

export function DealsIcon({ name, size = 16, className = '' }: { name: keyof typeof PATHS; size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor"
      strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
      className={`shrink-0 ${className}`}
    >
      <path d={PATHS[name]} />
    </svg>
  )
}

// ── barvy fází ──────────────────────────────────────────────────────────
// Jeden zdroj: DEAL_STAGES.tone (lib/domain.ts) – datové tóny značky podle
// významu fáze; u kvalifikace a odložených neutrální šedá.
export const STAGE_COLOR: Record<string, string> = Object.fromEntries(DEAL_STAGES.map((s) => [s.key, s.tone]))
const NEUTRAL = 'var(--d-neutral)'

// ── peníze jako velké číslo ─────────────────────────────────────────────
const NBSP = /[  ]/g
export function moneyParts(v: number): { num: string; unit: string } {
  const abs = Math.abs(v)
  if (abs >= 1_000_000) {
    const mil = v / 1_000_000
    return { num: mil.toLocaleString('cs-CZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(NBSP, ' '), unit: 'mil. Kč' }
  }
  return { num: Math.round(v).toLocaleString('cs-CZ').replace(NBSP, ' '), unit: 'Kč' }
}

// ── logo firmy: pastelová dlaždice s písmenem ────────────────────────────
// Plochy značky bez červené a žluté (ty nesou význam problém / čeká).
const LOGO_BG = ['var(--p-turquoise)', 'var(--p-blue)', 'var(--p-violet)', 'var(--c-soft)']
export function DealsCompanyLogo({ name, size = 30 }: { name: string; size?: number }) {
  let n = 0
  for (const ch of name) n = (n + ch.charCodeAt(0)) % 997
  const letter = (name.trim()[0] ?? '?').toUpperCase()
  return (
    <span
      aria-hidden="true"
      className="inline-grid shrink-0 place-items-center font-heading font-bold text-ink"
      style={{ width: size, height: size, borderRadius: Math.round(size / 3), fontSize: Math.round(size * 0.45), background: LOGO_BG[n % LOGO_BG.length] }}
    >
      {letter}
    </span>
  )
}

// ── tenký pruh s podílem ────────────────────────────────────────────────
export function DealsBar({ pct, color, label, thin = true }: { pct: number; color?: string; label?: string; thin?: boolean }) {
  const w = Math.max(0, Math.min(100, pct))
  return (
    <div className={`bar ${thin ? 'thin' : ''}`} {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}>
      <i style={{ width: `${w}%`, ...(color ? { backgroundColor: color } : {}) }} />
    </div>
  )
}

// ── prstenec podle fází ─────────────────────────────────────────────────
export type StageRingSlice = { key: string; label: string; count: number; amount: number }

export function DealsStageRing({ slices }: { slices: StageRingSlice[] }) {
  const size = 124
  const thickness = 20
  const r = (size - thickness) / 2
  const c = 2 * Math.PI * r
  const totalCount = slices.reduce((s, x) => s + x.count, 0)
  const totalAmount = slices.reduce((s, x) => s + x.amount, 0)
  // podíl podle částky; když nemá částku žádný obchod, podle počtu
  const weight = (x: StageRingSlice) => (totalAmount > 0 ? x.amount : x.count)
  const totalWeight = totalAmount > 0 ? totalAmount : totalCount
  const active = slices.filter((x) => weight(x) > 0)
  const arcs = active.map((x, i) => {
    const before = active.slice(0, i).reduce((sum, y) => sum + weight(y) / totalWeight, 0)
    const frac = weight(x) / totalWeight
    return { ...x, len: Math.max(0, frac * c - (active.length > 1 ? 2 : 0)), rot: before * 360 - 90 }
  })
  const summary = totalCount === 0
    ? 'Podle fází: žádný otevřený obchod'
    : `Podle fází: ${totalCount} ${totalCount === 1 ? 'obchod' : totalCount < 5 ? 'obchody' : 'obchodů'}; `
      + slices.filter((x) => x.count > 0).map((x) => `${x.label} ${x.count}, ${formatCzk(x.amount)}`).join('; ')
  return (
    <div className="flex flex-wrap items-center gap-4">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} role="img" aria-label={summary} className="shrink-0">
        <g aria-hidden="true">
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--d-track)" strokeWidth={thickness} />
          {arcs.map((a) => (
            <circle
              key={a.key} cx={size / 2} cy={size / 2} r={r} fill="none" stroke={STAGE_COLOR[a.key] ?? NEUTRAL}
              strokeWidth={thickness} strokeDasharray={`${a.len} ${c - a.len}`} transform={`rotate(${a.rot} ${size / 2} ${size / 2})`}
            />
          ))}
          <text x="50%" y="47%" textAnchor="middle" dominantBaseline="central" className="font-heading" style={{ fontSize: 30, fontWeight: 900, fill: 'var(--c-ink)' }}>{totalCount}</text>
          <text x="50%" y="66%" textAnchor="middle" dominantBaseline="central" className="eyebrow" style={{ fontSize: 10, fill: 'var(--c-slate)' }}>{totalCount === 1 ? 'obchod' : totalCount < 5 ? 'obchody' : 'obchodů'}</text>
        </g>
      </svg>
      <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
        {slices.map((x) => (
          <li key={x.key} className="flex items-start gap-2.5">
            <i aria-hidden="true" className="mt-1 block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: STAGE_COLOR[x.key] ?? NEUTRAL }} />
            <div>
              <b className="block text-[13px] leading-tight">{x.label}</b>
              <small className="block text-xs text-muted">{x.count > 0 ? `${x.count} × · ${formatCzkShort(x.amount)}` : 'žádný obchod'}</small>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ── šrafované sloupce: hodnota obchodu a hodnota s pravděpodobností ─────
export type ValueHatchItem = { id: number; label: string; amount: number; weighted: number; probability: number }

export function DealsValueHatch({ items }: { items: ValueHatchItem[] }) {
  const max = Math.max(1, ...items.map((i) => i.amount))
  const H = 150
  const summary = items.length === 0
    ? 'Hodnota a šance obchodů: žádný otevřený obchod s částkou'
    : 'Hodnota a šance obchodů: ' + items.map((i) => `${i.label} ${formatCzk(i.amount)}, šance ${i.probability} %, s pravděpodobností ${formatCzk(i.weighted)}`).join('; ')
  if (items.length === 0) {
    return <p className="m-0 text-sm text-muted">Zatím tu není žádný otevřený obchod s částkou.</p>
  }
  const hatch: CSSProperties = {
    backgroundImage: 'repeating-linear-gradient(135deg,transparent 0 6px,rgba(20,25,34,.28) 6px 7px)',
    backgroundColor: '#fff',
  }
  return (
    <div role="img" aria-label={summary}>
      <div aria-hidden="true" className="mb-3 flex flex-wrap gap-x-5 gap-y-1 text-[12.5px] font-semibold text-ink-2">
        <span className="inline-flex items-center gap-1.5"><i className="inline-block h-3 w-3 rounded border border-[color:var(--c-hatch-line)]" style={hatch} />hodnota obchodu</span>
        <span className="inline-flex items-center gap-1.5"><i className="inline-block h-3 w-3 rounded" style={{ background: 'var(--c-navy)' }} />s pravděpodobností</span>
      </div>
      <div aria-hidden="true" className="flex items-end gap-3 sm:gap-4">
        {items.map((it) => {
          const h = Math.max(28, Math.round((it.amount / max) * H))
          const fill = it.amount > 0 ? Math.max(4, Math.round((it.weighted / it.amount) * h)) : 0
          return (
            <div key={it.id} className="flex min-w-0 flex-1 flex-col justify-end gap-1 text-center">
              <b className="text-[13px]">{formatCzkShort(it.amount).replace(' Kč', '')}</b>
              <div className="relative overflow-hidden rounded-[14px] border border-[color:var(--c-hatch-line)]" style={{ height: h, ...hatch }}>
                <i
                  className="absolute inset-x-0 bottom-0 block"
                  style={{ height: fill, backgroundColor: 'var(--c-navy)', backgroundImage: 'repeating-linear-gradient(135deg,transparent 0 6px,rgba(255,255,255,.35) 6px 7px)' }}
                />
              </div>
              <span className="truncate text-[12.5px] font-bold">{it.label}</span>
              <small className="block text-[11.5px] text-muted">šance {it.probability} %</small>
            </div>
          )
        })}
      </div>
    </div>
  )
}

// ── postup fází (detail obchodu) ────────────────────────────────────────
export function DealsStageStrip({ stage }: { stage: string }) {
  const open = DEAL_STAGES.filter((s) => s.open)
  const openIdx = open.findIndex((s) => s.key === stage)
  const won = stage === 'vyhráno'
  const states = open.map((s, i): 'done' | 'now' | 'next' | 'idle' => {
    if (won) return 'done'
    if (openIdx < 0) return 'idle'
    return i < openIdx ? 'done' : i === openIdx ? 'now' : 'next'
  })
  const captions = { done: 'Hotovo', now: 'Teď', next: 'Další fáze', idle: '—' } as const
  const summary = 'Fáze obchodu: ' + open.map((s, i) => {
    const st = states[i]
    return `${s.label} ${st === 'done' ? 'hotovo' : st === 'now' ? 'právě teď' : st === 'next' ? 'další' : 'neprobíhá'}`
  }).join(', ')
  const stripes = (a: number) => `repeating-linear-gradient(90deg,rgba(255,255,255,${a}) 0 2px,transparent 2px 5px)`
  return (
    <div role="img" aria-label={summary} className="grid grid-cols-2 gap-1.5 sm:grid-cols-4">
      {open.map((s, i) => {
        const st = states[i]
        const style: CSSProperties =
          st === 'done' ? { backgroundColor: 'var(--c-navy)', backgroundImage: stripes(0.1), color: '#fff' }
            : st === 'now' ? { backgroundColor: 'var(--c-accent)', backgroundImage: stripes(0.22), color: 'var(--c-navy)' }
              : { backgroundColor: 'var(--c-soft)', color: 'var(--c-ink-2)' }
        return (
          <div key={s.key} aria-hidden="true" className="flex flex-col gap-1 rounded-[18px] px-3 py-2.5" style={style}>
            <span className="flex items-center gap-2 text-[13px] font-extrabold">
              <span
                className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-full text-xs font-extrabold"
                style={{ background: st === 'done' ? 'rgba(255,255,255,.2)' : '#fff', color: st === 'done' ? '#fff' : 'var(--c-navy)' }}
              >
                {st === 'done' ? <DealsIcon name="check" size={14} /> : i + 1}
              </span>
              {s.label}
            </span>
            <span className="text-xs" style={{ opacity: st === 'done' ? 0.85 : 1 }}>{captions[st]}</span>
          </div>
        )
      })}
    </div>
  )
}

// ── skládaný pruh stavů (cílové seznamy) ────────────────────────────────
export type SegmentedPart = { label: string; value: number; color: string }
export function DealsSegmentedBar({ parts }: { parts: SegmentedPart[] }) {
  const total = parts.reduce((s, p) => s + p.value, 0)
  const summary = total === 0
    ? 'Stav firem: seznam je zatím prázdný'
    : 'Stav firem: ' + parts.filter((p) => p.value > 0).map((p) => `${p.label} ${p.value}`).join(', ')
  return (
    <div role="img" aria-label={summary} className="flex h-3 gap-0.5 overflow-hidden rounded-full bg-[color:var(--d-track)]">
      {parts.filter((p) => p.value > 0).map((p) => (
        <i key={p.label} className="block h-full" style={{ width: `${(p.value / total) * 100}%`, backgroundColor: p.color }} />
      ))}
    </div>
  )
}

// ── drobnosti ───────────────────────────────────────────────────────────
export function DealsCard({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <section className={`${CARD} ${CARD_PAD} ${className}`}>{children}</section>
}

export function DealsCardHead({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
      <h2 className="m-0 font-heading text-title2 font-bold">{title}</h2>
      {children && <div className="flex items-center gap-2">{children}</div>}
    </div>
  )
}

export function stageDotColor(stage: string): string {
  return STAGE_COLOR[stage] ?? NEUTRAL
}
