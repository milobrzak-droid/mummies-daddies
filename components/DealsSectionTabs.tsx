'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'

// Záložky sekce Obchody (docs/PROVOZ.md §11, plán vlny 2): stejný
// segmentový přepínač jako SectionTabs, jen s vlastní záložkou Reporty.
// Tabule (/pipeline) je aktivní i na /pipeline/new, ale ne na /pipeline/reporty
// – proto vlastní pravidlo místo prefixového isActivePath.
export type DealsTab = { href: string; label: string; count?: number }

export const DEALS_SECTION_TABS: DealsTab[] = [
  { href: '/cockpit/pipeline', label: 'Tabule' },
  { href: '/cockpit/pipeline/reporty', label: 'Reporty' },
  { href: '/cockpit/cilove-seznamy', label: 'Seznamy k oslovení' },
  { href: '/cockpit/oslovovani', label: 'Oslovování' },
]

export function isDealsTabActive(pathname: string, href: string): boolean {
  if (href === '/cockpit/pipeline') {
    return pathname === '/cockpit/pipeline' || (pathname.startsWith('/cockpit/pipeline/') && !pathname.startsWith('/cockpit/pipeline/reporty'))
  }
  return pathname === href || pathname.startsWith(`${href}/`)
}

/** Záložky Obchodů; `counts` doplní počet k záložce podle href (např. Oslovování). */
export function DealsSectionTabs({ counts }: { counts?: Partial<Record<string, number>> }) {
  const pathname = usePathname() ?? ''
  return (
    <nav aria-label="Obchody" className="-mt-1 mb-6">
      <div className="seg">
        {DEALS_SECTION_TABS.map((t) => {
          const count = counts?.[t.href]
          return (
            <Link key={t.href} href={t.href} className="seg-item" aria-current={isDealsTabActive(pathname, t.href) ? 'page' : undefined}>
              {t.label}
              {typeof count === 'number' && count > 0 && <span className="seg-count tabular-nums">{count}</span>}
            </Link>
          )
        })}
      </div>
    </nav>
  )
}
