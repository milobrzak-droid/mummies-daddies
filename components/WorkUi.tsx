import Link from 'next/link'
import type { ReactNode } from 'react'
import { CARD } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'

// Malé stavební prvky sekce Práce a Dodávky (stavová pilulka, kulaté
// zaškrtnutí, hláška v kartě, segmenty, klidná čísla). Karty a prázdné stavy
// jsou sdílené `Card` a `EmptyState`. Bez stavu a bez dotazů — jen
// prezentace, ať jsou stránky úkolů, případů, schůzek a dodávek jednotné.

// Tečka stavové pilulky (.st): výchozí je jantarová, hotovo zelená, chyba
// červená, „info" modrá. Šedou („nečinné") přidáváme tady, globals.css ji nemá.
export type WorkStatusTone = 'wait' | 'done' | 'fail' | 'info' | 'idle'

export function WorkStatus({ tone = 'wait', children }: { tone?: WorkStatusTone; children: ReactNode }) {
  const cls = tone === 'wait' ? 'st' : tone === 'idle' ? 'st [&::before]:bg-[color:var(--c-slate-2)]' : `st ${tone}`
  return <span className={cls}>{children}</span>
}

// Kulaté zaškrtnutí; stav je i v textu pro čtečku.
export function WorkChk({ done, label }: { done: boolean; label?: string }) {
  return (
    <span className={done ? 'chk done' : 'chk'} role="img" aria-label={label ?? (done ? 'Hotovo' : 'Nehotovo')}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M20 6 9 17l-5-5" />
      </svg>
    </span>
  )
}

// Iniciála v barevném čtverci místo loga firmy (vymyšlená loga nepoužíváme).
// Bílé písmeno, proto textové tóny značky (bílá na nich ≥ 4,5 : 1); bez
// červené a žluté, které nesou význam problém / čeká.
const LOGO_COLORS = ['var(--t-violet)', 'var(--t-blue)', 'var(--t-turquoise)', 'var(--d-graphite)']
export function logoColor(key: string): string {
  let n = 0
  for (const ch of key) n = (n + ch.charCodeAt(0)) % 997
  return LOGO_COLORS[n % LOGO_COLORS.length]
}

export function WorkLogo({ name, size = 30 }: { name: string; size?: number }) {
  const ch = (name.trim()[0] ?? '?').toUpperCase()
  return (
    <span
      aria-hidden="true"
      className="inline-grid place-items-center rounded-[10px] font-heading font-bold text-white shrink-0"
      style={{ width: size, height: size, background: logoColor(name), fontSize: Math.round(size * 0.44) }}
    >
      {ch}
    </span>
  )
}

// Klidná hláška v kartě (před migrací, chyba načtení, prázdný seznam):
// EmptyState uvnitř bílé karty, volitelně s cestou dál.
export function WorkNotice({ title, children, action, tone }: {
  title: string
  children?: ReactNode
  action?: { href: string; label: string }
  tone?: 'neutral' | 'calm'
}) {
  return (
    <div className={CARD}>
      <EmptyState compact title={title} action={action} tone={tone}>{children}</EmptyState>
    </div>
  )
}

// Filtr nebo přepínač pohledu jako segment (docs/PROVOZ.md §11):
// jedna klidná dráha, aktivní položka bílá s aria-current. Na rozdíl od
// SectionTabs se aktivní položka určuje z parametrů adresy (?stav=, ?kdo=).
export type WorkSegItem = { href: string; label: string; active: boolean; count?: number }

export function WorkSegNav({ label, items, className = '' }: { label: string; items: WorkSegItem[]; className?: string }) {
  return (
    <nav aria-label={label} className={`max-w-full ${className}`}>
      <div className="seg">
        {items.map((it) => (
          <Link key={it.href} href={it.href} className="seg-item" aria-current={it.active ? 'page' : undefined}>
            {it.label}
            {typeof it.count === 'number' && <span className="seg-count tabular-nums">{it.count}</span>}
          </Link>
        ))}
      </div>
    </nav>
  )
}

// Klidná čísla (KPI) v jedné kartě: popisek Fira Mono, velké číslo, tichá
// nápověda; buňky dělí jemná čára. Barvu nenesou – jen číslo a slovo.
export type WorkKpi = { key: string; label: string; value: ReactNode; hint?: ReactNode }

export function WorkKpiStrip({ items, label }: { items: WorkKpi[]; label: string }) {
  const four = items.length >= 4
  const cols = four ? 'grid-cols-2 lg:grid-cols-4' : items.length === 3 ? 'grid-cols-1 sm:grid-cols-3' : 'grid-cols-2'
  // Dělicí čáry: vlevo mezi buňkami v řadě, nahoře u druhé řady (mobil).
  const divider = (i: number) => {
    if (i === 0) return ''
    if (four) return i === 1 ? 'border-l' : i === 2 ? 'border-t lg:border-l lg:border-t-0' : 'border-l border-t lg:border-t-0'
    if (items.length === 3) return 'border-t sm:border-l sm:border-t-0'
    return 'border-l'
  }
  return (
    <section aria-label={label} className={`${CARD} overflow-hidden`}>
      <dl className={`m-0 grid ${cols}`}>
        {items.map((k, i) => (
          <div key={k.key} className={`flex flex-col border-[color:var(--c-line-2)] p-5 ${divider(i)}`}>
            <dt className="eyebrow">{k.label}</dt>
            <dd className="m-0 mt-2 big-num text-[34px] text-ink">{k.value}</dd>
            {k.hint && <dd className="m-0 mt-1 text-footnote text-muted">{k.hint}</dd>}
          </div>
        ))}
      </dl>
    </section>
  )
}

// Stupně pravomoci slovy (v textech pro uživatele se L1–L4 nepoužívá).
export function levelWords(level: string): string {
  return ({ L1: 'jen čte a hlásí', L2: 'připraví ke schválení', L3: 'provede schválený krok', L4: 'ohraničený postup' } as Record<string, string>)[level] ?? level
}
