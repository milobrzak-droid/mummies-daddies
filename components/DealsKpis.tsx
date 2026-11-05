import { CARD } from '@/components/ui/Card'
import { moneyParts } from '@/components/DealsVisuals'

// Souhrn nahoře na Obchodech (plán vlny 2): tři klidná čísla stejná jako na
// Dnes – Otevřené obchody, S pravděpodobností, Vyhráno tento měsíc. Pruh jen
// u „S pravděpodobností“ (podíl z otevřené hodnoty), jinde žádná výzdoba.
// Čísla přicházejí z existujících dotazů stránky, nic se nedopočítává navíc.

function plural(n: number, one: string, few: string, many: string): string {
  if (n === 1) return one
  if (n >= 2 && n <= 4) return few
  return many
}

function Money({ value }: { value: number }) {
  const { num, unit } = moneyParts(value)
  return (
    <div className="big-num whitespace-nowrap text-[32px] text-ink">
      {num}<small className="ml-1.5 font-heading text-[13px] font-bold tracking-normal text-muted">{unit}</small>
    </div>
  )
}

export function DealsKpis({ open, weighted, won, openCount, monthLabel }: {
  open: number
  weighted: number
  won: number
  openCount: number
  monthLabel: string
}) {
  const weightedPct = open > 0 ? Math.max(0, Math.min(100, Math.round((weighted / open) * 100))) : 0
  return (
    <section aria-label="Obchody v číslech" className={`${CARD} mb-6 !p-0`}>
      <div className="grid grid-cols-1 sm:grid-cols-3">
        <div className="p-5">
          <h2 className="eyebrow m-0">Otevřené obchody</h2>
          <div className="my-2.5"><Money value={open} /></div>
          <p className="m-0 text-footnote text-muted">
            <span className="tabular-nums">{openCount}</span> {plural(openCount, 'obchod', 'obchody', 'obchodů')} · součet hodnot
          </p>
        </div>
        <div className="border-t border-[color:var(--c-line-2)] p-5 sm:border-l sm:border-t-0">
          <h2 className="eyebrow m-0">S pravděpodobností</h2>
          <div className="my-2.5"><Money value={weighted} /></div>
          <div role="img" aria-label={`S pravděpodobností je to ${weightedPct} % z otevřené hodnoty`} className="bar thin blue">
            <i style={{ width: `${weightedPct}%` }} />
          </div>
          <p className="m-0 mt-2 text-footnote text-muted">{weightedPct} % otevřené hodnoty podle šance na výhru</p>
        </div>
        <div className="border-t border-[color:var(--c-line-2)] p-5 sm:border-l sm:border-t-0">
          <h2 className="eyebrow m-0">Vyhráno tento měsíc</h2>
          <div className="my-2.5"><Money value={won} /></div>
          <p className="m-0 text-footnote text-muted">{monthLabel}{won === 0 ? ' · zatím nic uzavřeno' : ''}</p>
        </div>
      </div>
    </section>
  )
}

export type DealsStat = { label: string; value: number; note?: string }

/**
 * Řada klidných počtů (seznamy k oslovení, oslovování): jedna karta, sloupce
 * oddělené čarou, velké číslo a popisek. Bez barevných ploch – barva patří
 * jen stavu, který chce pozornost, a ten tu říká text.
 */
export function DealsStats({ label, stats, className = 'mb-6' }: { label: string; stats: DealsStat[]; className?: string }) {
  const cols = stats.length >= 4 ? 'grid-cols-2 md:grid-cols-4' : stats.length === 3 ? 'grid-cols-1 sm:grid-cols-3' : 'grid-cols-2'
  return (
    <section aria-label={label} className={`${CARD} overflow-hidden ${className}`}>
      <dl className={`m-0 grid ${cols}`}>
        {stats.map((s) => (
          <div key={s.label} className="-ml-px -mt-px border-l border-t border-[color:var(--c-line-2)] p-5">
            <dt className="eyebrow">{s.label}</dt>
            <dd className="m-0 mt-2 big-num text-[32px] text-ink">{s.value}</dd>
            {s.note && <dd className="m-0 mt-1 text-footnote text-muted">{s.note}</dd>}
          </div>
        ))}
      </dl>
    </section>
  )
}
