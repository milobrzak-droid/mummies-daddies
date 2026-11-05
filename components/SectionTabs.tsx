'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { isActivePath } from '@/components/Sidebar'
import { useAccess, type Access } from '@/components/AccessContext'
import { COMPANY } from '@/config'
import { isModuleOn } from '@/core/modules'
import type { ModuleKey } from '@/core/tenant'

// `salesOnly`: záložka vede do sekce, kterou role bez obchodu nesmí otevřít
// (stránka ji přesměruje) — stejné pravidlo jako položky menu v Sidebaru.
// `module`: záložka modulu, který jde u firmy vypnout (CompanyConfig.modules).
export type SectionTab = { href: string; label: string; count?: number; salesOnly?: boolean; module?: ModuleKey }

/** Záložky, které člověk s danými právy smí vidět (pořadí zůstává). */
export function visibleSectionTabs(tabs: readonly SectionTab[], access: Pick<Access, 'canSeeSales'>): SectionTab[] {
  return tabs.filter((t) => (!t.salesOnly || access.canSeeSales) && (!t.module || isModuleOn(COMPANY.modules, t.module)))
}

// Záložky sekce jako segmentový přepínač (docs/PROVOZ.md §11): jedna
// klidná dráha, aktivní segment je bílý a zvednutý. Nahrazují dřívější
// samostatné položky menu: Práce = Úkoly / Případy / Schůzky / Kapacity atd.
// Na úzkém displeji se dráha posouvá do strany (nezalamuje se do dvou řad).
export function SectionTabs({ tabs, label = 'Sekce' }: { tabs: SectionTab[]; label?: string }) {
  const pathname = usePathname()
  const visible = visibleSectionTabs(tabs, useAccess())
  // Jediná záložka nemá s čím přepínat — přepínač se pak nezobrazí vůbec.
  if (visible.length < 2) return null
  return (
    <nav aria-label={label} className="-mt-1 mb-6">
      <div className="seg">
        {visible.map((t) => (
          <Link key={t.href} href={t.href} className="seg-item" aria-current={isActivePath(pathname, t.href) ? 'page' : undefined}>
            {t.label}
            {typeof t.count === 'number' && t.count > 0 && <span className="seg-count tabular-nums">{t.count}</span>}
          </Link>
        ))}
      </div>
    </nav>
  )
}

export const WORK_TABS: SectionTab[] = [
  { href: '/cockpit/tasks', label: 'Úkoly' }, { href: '/cockpit/pripady', label: 'Případy' }, { href: '/cockpit/dodavky', label: 'Dodávky', module: 'deliveries' },
  { href: '/cockpit/objednavky', label: 'Objednávky', module: 'shopOrders' },
  { href: '/cockpit/schuzky', label: 'Schůzky', salesOnly: true, module: 'meetings' },
  { href: '/cockpit/kapacity', label: 'Kapacity', module: 'capacity' }, { href: '/cockpit/aktivity', label: 'Aktivity', salesOnly: true },
]
export const DEAL_TABS: SectionTab[] = [
  { href: '/cockpit/pipeline', label: 'Tabule', salesOnly: true }, { href: '/cockpit/agent', label: 'Agent', salesOnly: true, module: 'agent' },
  { href: '/cockpit/signaly', label: 'Signály', salesOnly: true, module: 'agent' },
  { href: '/cockpit/cilove-seznamy', label: 'Seznamy k oslovení', salesOnly: true, module: 'targetLists' },
  { href: '/cockpit/oslovovani', label: 'Oslovování', salesOnly: true, module: 'targetLists' },
]
export const CLIENT_TABS: SectionTab[] = [
  { href: '/cockpit/clients', label: 'Firmy' }, { href: '/cockpit/partners', label: 'Partneři', module: 'partners' }, { href: '/cockpit/hledat', label: 'Hledat' },
]
export const TODAY_TABS: SectionTab[] = [{ href: '/cockpit', label: 'Dnes' }, { href: '/cockpit/prehled-tydne', label: 'Týden', salesOnly: true }]
