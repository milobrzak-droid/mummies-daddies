import Link from 'next/link'

// Záložky stránky dodávky. Je to navigace odkazy (?zalozka=…), ne role="tab":
// každá záložka je vlastní adresa, funguje sdílení odkazu i tlačítko Zpět.
export const ENGAGEMENT_TABS = [
  { key: 'prehled', label: 'Přehled' },
  { key: 'milniky', label: 'Milníky' },
  { key: 'predani', label: 'Předání' },
  { key: 'tym', label: 'Tým' },
  { key: 'dopad', label: 'Dopad' },
  { key: 'dokumenty', label: 'Dokumenty' },
  { key: 'udaje', label: 'Údaje' },
] as const

export type EngagementTabKey = (typeof ENGAGEMENT_TABS)[number]['key']

export function parseEngagementTab(v: string | string[] | undefined, fallback: EngagementTabKey = 'prehled'): EngagementTabKey {
  const raw = Array.isArray(v) ? v[0] : v
  return ENGAGEMENT_TABS.find((t) => t.key === raw)?.key ?? fallback
}

// Vzhled jako záložky sekce (segment, docs/PROVOZ.md §11): jedna
// klidná dráha, aktivní záložka bílá; na úzkém displeji se dráha posouvá.
export function EngagementTabs({ basePath, current }: { basePath: string; current: EngagementTabKey }) {
  return (
    <nav aria-label="Části dodávky" className="mb-6 max-w-full">
      <div className="seg">
        {ENGAGEMENT_TABS.map((t) => (
          <Link
            key={t.key}
            href={t.key === 'prehled' ? basePath : `${basePath}?zalozka=${t.key}`}
            className="seg-item"
            aria-current={t.key === current ? 'page' : undefined}
          >
            {t.label}
          </Link>
        ))}
      </div>
    </nav>
  )
}
