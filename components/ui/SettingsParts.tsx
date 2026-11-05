import type { ReactNode } from 'react'

// Stavební kameny stránek Tým, API klíče, Nastavení a Hledat: bílá dlaždice
// s barevným proužkem a velkým číslem (klidné KPI) a kostra záhlaví pro
// loading.tsx. Čistě prezentační (žádný stav ani hooky).
// Karty a prázdné stavy jsou sdílené `Card` a `EmptyState`
// (components/ui/Card.tsx, EmptyState.tsx).

export type TileColor = 'peach' | 'sky' | 'pink' | 'mint' | 'lav' | 'sun'

/** Klidné KPI: bílá dlaždice s barevným proužkem, velké číslo a popisek (barva = druh věci). */
export function SettingsTile({ color, label, value, note }: { color: TileColor; label: string; value: ReactNode; note?: string }) {
  return (
    <div className={`tile tile-${color} flex min-h-[112px] flex-col justify-between !p-5`}>
      <div className="eyebrow">{label}</div>
      <div className="big-num mt-3 text-[40px] text-ink">{value}</div>
      {note && <div className="mt-2 text-footnote text-muted">{note}</div>}
    </div>
  )
}

/** Kostra záhlaví stránky pro loading.tsx (stejný rozměr jako PageHeader, bez čáry). */
export function SettingsLoadingHeader({ subtitle = false }: { subtitle?: boolean }) {
  return (
    <div className="mb-6" aria-hidden="true">
      <div className="mb-1.5 h-[11px] w-24 rounded-full bg-[color:rgba(23,32,46,.07)] motion-safe:animate-pulse" />
      <div className="h-[32px] w-56 rounded-[16px] bg-[color:rgba(23,32,46,.07)] motion-safe:animate-pulse" />
      {subtitle && <div className="mt-2 h-4 w-72 max-w-full rounded-full bg-[color:rgba(23,32,46,.07)] motion-safe:animate-pulse" />}
    </div>
  )
}
