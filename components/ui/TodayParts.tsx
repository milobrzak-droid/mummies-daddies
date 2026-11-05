import Link from 'next/link'
import type { ReactNode } from 'react'
import { moneyParts, type SourceRow, type SourceTone, type StageSlice } from '@/domain/crm/today'
import { CheckIcon as SharedCheckIcon } from '@/components/ui/Icons'

// Stavební kameny obrazovky „Dnes“ a záložky „Týden“: pastelová dlaždice,
// velké číslo, prstenec, pruh, stavová pilulka, řádek seznamu. Čistě
// prezentační (server komponenty, bez stavu). Karty a prázdné stavy jsou
// sdílené `Card` a `EmptyState` (components/ui/Card.tsx, EmptyState.tsx).

const ICON_PROPS = { 'aria-hidden': true, focusable: false, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' } as const

// Šipky a zaškrtnutí jsou sdílené (components/ui/Icons.tsx); tady jen převzaté
// pod původními jmény, ať se nemění volání.
export { ArrowUpRightIcon, ArrowRightIcon } from '@/components/ui/Icons'
export function CheckIcon({ size = 22 }: { size?: number }) {
  return <SharedCheckIcon size={size} />
}
export function BellIcon({ size = 16 }: { size?: number }) {
  return <svg {...ICON_PROPS} width={size} height={size}><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10 21a2 2 0 0 0 4 0" /></svg>
}
export function ClockIcon({ size = 18 }: { size?: number }) {
  return <svg {...ICON_PROPS} width={size} height={size}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
}
export function MailIcon({ size = 18 }: { size?: number }) {
  return <svg {...ICON_PROPS} width={size} height={size}><rect x="3" y="5" width="18" height="14" rx="3" /><path d="m3 8 9 6 9-6" /></svg>
}
export function SearchIcon({ size = 16 }: { size?: number }) {
  return <svg {...ICON_PROPS} width={size} height={size}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
}

/** Kulatý štítek s číslem v hlavičce karty. */
export function TodayCount({ n, tone = 'neutral' }: { n: number; tone?: 'neutral' | 'neg' }) {
  return (
    <span className={`inline-flex min-w-[28px] items-center justify-center rounded-full px-2.5 py-1 text-xs font-bold tabular-nums ${tone === 'neg' ? 'bg-[color:var(--c-neg-soft)] text-neg' : 'bg-[color:var(--c-soft)] text-ink'}`}>
      {n}
    </span>
  )
}

// Třídy jsou tu záměrně napsané celé: Tailwind hledá názvy tříd ve zdrojácích
// v app/ a components/ (ne v lib/), jinak by je z @layer components vyřadil.
const ST_CLASS: Record<SourceTone, string> = { done: 'st done', wait: 'st', fail: 'st fail', info: 'st info' }

/** Stavová pilulka s barevnou tečkou; stav je vždy i slovem, ne jen barvou. */
export function TodayStatus({ tone, children }: { tone: SourceTone; children: ReactNode }) {
  return <span className={ST_CLASS[tone]}>{children}</span>
}

const TILE_CLASS = { peach: 'tile tile-peach', sky: 'tile tile-sky', pink: 'tile tile-pink', mint: 'tile tile-mint', lav: 'tile tile-lav', sun: 'tile tile-sun' } as const
export type TileColor = keyof typeof TILE_CLASS
/** Proužek dlaždice podle fáze obchodu: stejný význam jako DEAL_STAGES.tone
 *  (kvalifikace bez barvy, diagnostika modrá, nabídka žlutá, rozhodování fialová). */
export const STAGE_TILE_COLOR: Record<string, TileColor> = {
  kvalifikace: 'pink', diagnostika: 'sky', rozsah_nabidka: 'sun', rozhodovani: 'lav',
}

export function TodayTile({ color, children, className = '' }: { color: TileColor; children: ReactNode; className?: string }) {
  return <article className={`${TILE_CLASS[color]} ${className}`}>{children}</article>
}

/** Tichá pilulka na dlaždici (štítek, fáze). */
export function TileChip({ children }: { children: ReactNode }) {
  return <span className="inline-flex items-center rounded-full bg-[color:var(--c-soft)] px-2.5 py-1 text-[11.5px] font-semibold text-ink">{children}</span>
}

/** Velké číslo se zmenšenou jednotkou („2,67“ + „mil. Kč“). */
export function BigMoney({ value, size = 32 }: { value: number; size?: number }) {
  const { value: v, unit } = moneyParts(value)
  return (
    <div className="big-num whitespace-nowrap text-ink" style={{ fontSize: size }}>
      {v}<small className="ml-1.5 font-heading text-[13px] font-bold tracking-normal text-muted">{unit}</small>
    </div>
  )
}

// ── prstenec podle fáze ────────────────────────────────────────────────────

/** Prstenec: kolik otevřených obchodů je v které fázi. Legenda s počty pod ním. */
export function TodayStageRing({ slices, centerLabel = 'obchodů', size = 168, subject = 'Otevřené obchody podle fáze', emptyText = 'žádný otevřený obchod' }: { slices: StageSlice[]; centerLabel?: string; size?: number; subject?: string; emptyText?: string }) {
  const total = slices.reduce((s, x) => s + x.count, 0)
  const active = slices.filter((s) => s.count > 0)
  const gap = active.length > 1 ? 1.6 : 0
  let at = 0
  const stops = active.map((s) => {
    const frac = (s.count / total) * 100
    const from = at
    at += frac
    return gap ? `${s.color} ${from}% ${at - gap}%, #fff ${at - gap}% ${at}%` : `${s.color} ${from}% ${at}%`
  })
  const conic = total > 0 ? `conic-gradient(${stops.join(', ')})` : 'conic-gradient(var(--d-track) 0 100%)'
  const summary = total > 0
    ? `${subject}, celkem ${total}: ${active.map((s) => `${s.label} ${s.count}`).join(', ')}`
    : `${subject}: ${emptyText}`
  return (
    <div>
      <div className="grid place-items-center">
        <div
          role="img"
          aria-label={summary}
          className="relative rounded-full"
          style={{ width: size, height: size, background: `repeating-linear-gradient(90deg,rgba(255,255,255,.3) 0 2px,transparent 2px 5px), ${conic}` }}
        >
          <div aria-hidden="true" className="absolute inset-[17%] flex flex-col items-center justify-center rounded-full bg-surface text-center">
            <span className="big-num text-[40px] text-ink">{total}</span>
            <span className="mt-0.5 text-xs text-muted">{centerLabel}</span>
          </div>
        </div>
      </div>
      <ul className="m-0 mt-4 flex list-none flex-col gap-1 p-0">
        {slices.map((s) => (
          <li key={s.key} className={`flex items-center gap-2.5 py-1 text-[13px] font-semibold ${s.count ? 'text-ink' : 'text-muted'}`}>
            <i aria-hidden="true" className="h-[11px] w-[11px] shrink-0 rounded-full" style={s.count ? { background: s.color } : { boxShadow: `inset 0 0 0 2px ${s.color}` }} />
            <span className="min-w-0 flex-1">{s.label}</span>
            <b className="text-sm tabular-nums">{s.count}</b>
          </li>
        ))}
      </ul>
    </div>
  )
}

// ── pruhy ──────────────────────────────────────────────────────────────────

/** Tenký pruh s jednou barvou a podílem 0–100. */
export function TodayBar({ pct, color = 'blue', label }: { pct: number; color?: 'blue' | 'green' | 'amber' | 'red' | 'navy'; label: string }) {
  const CLS = { blue: 'bar thin blue', green: 'bar thin green', amber: 'bar thin amber', red: 'bar thin red', navy: 'bar thin navy' } as const
  const w = Math.max(0, Math.min(100, pct))
  return (
    <div role="img" aria-label={label} className={CLS[color]}>
      <i style={{ width: `${w}%` }} />
    </div>
  )
}

// ── stav zdrojů ────────────────────────────────────────────────────────────

export function TodaySources({ rows }: { rows: SourceRow[] }) {
  return (
    <ul className="m-0 flex list-none flex-col gap-3 p-0">
      {rows.map((r) => (
        <li key={r.key} className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <div className="min-w-0 flex-1">
            <b className="text-[14px]">{r.label}</b>
            <span className="ml-1.5 text-[12.5px] text-muted">{r.via}</span>
            <div className="text-[12.5px] text-muted">{r.detail}</div>
          </div>
          <TodayStatus tone={r.tone}>{r.status}</TodayStatus>
        </li>
      ))}
    </ul>
  )
}

/** Poznámka s zvonkem pod kartou (např. platnost okamžitého upozornění). */
export function TodayNote({ children, problem = false }: { children: ReactNode; problem?: boolean }) {
  return (
    <p className={`m-0 mt-4 flex items-center gap-2 rounded-[14px] px-3 py-2.5 text-[12.5px] ${problem ? 'bg-[color:var(--c-neg-soft)] text-neg' : 'bg-[color:var(--c-soft)] text-[color:#3A424E]'}`}>
      <BellIcon />
      <span>{children}</span>
    </p>
  )
}

/** Řádek seznamu s malou barevnou ikonou (Po termínu, Ke schválení). */
export function TodayRow({
  href, icon, tone, title, sub, trailing,
}: { href: string; icon: ReactNode; tone: 'pink' | 'sun' | 'mint' | 'sky' | 'lav'; title: string; sub?: string; trailing?: ReactNode }) {
  const BG = { pink: 'bg-[color:var(--p-pink)]', sun: 'bg-[color:var(--p-sun)]', mint: 'bg-[color:var(--p-mint)]', sky: 'bg-[color:var(--p-sky)]', lav: 'bg-[color:var(--p-lav)]' } as const
  return (
    <li className="border-b border-[color:var(--c-line-2)] last:border-b-0">
      <Link href={href} className="flex min-h-[44px] items-center gap-3 py-2.5 text-ink no-underline hover:text-ink">
        <span aria-hidden="true" className={`grid h-[34px] w-[34px] shrink-0 place-items-center rounded-[11px] text-ink ${BG[tone]}`}>{icon}</span>
        <span className="min-w-0 flex-1">
          <b className="block truncate text-[14px] leading-tight">{title}</b>
          {sub && <span className="block truncate text-xs text-muted">{sub}</span>}
        </span>
        {trailing}
      </Link>
    </li>
  )
}
