'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { isActivePath } from '@/components/Sidebar'

// Záložky sekce „Tým a nastavení“: Tým / API klíče / Nastavení.
// Definované tady (ne v SectionTabs.tsx), aby se sdílený soubor nemusel měnit.
// Tým a API klíče jsou jen pro adminy (stránky si to hlídají samy); ostatním
// se záložky neukazují vůbec, protože by měli jedinou.
export type SettingsTab = { href: string; label: string; adminOnly: boolean }

export const SETTINGS_TABS: SettingsTab[] = [
  { href: '/cockpit/tym', label: 'Tým', adminOnly: true },
  { href: '/cockpit/api-klice', label: 'API klíče', adminOnly: true },
  { href: '/cockpit/nastaveni', label: 'Nastavení', adminOnly: false },
]

export function SettingsTabs({ isAdmin }: { isAdmin: boolean }) {
  const pathname = usePathname() ?? ''
  const tabs = SETTINGS_TABS.filter((t) => isAdmin || !t.adminOnly)
  if (tabs.length < 2) return null
  return (
    <nav aria-label="Tým a nastavení" className="seg mb-6">
      {tabs.map((t) => (
        <Link key={t.href} href={t.href} className="seg-item" aria-current={isActivePath(pathname, t.href) ? 'page' : undefined}>
          {t.label}
        </Link>
      ))}
    </nav>
  )
}
