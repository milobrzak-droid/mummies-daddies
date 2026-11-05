'use client'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { useId, useState, type ReactNode } from 'react'
import { signOut } from '@/app/login/actions'
import { useCommandPalette, usePaletteShortcutLabel } from '@/components/CommandPalette'
import { useShortcutsHelp } from '@/components/Shortcuts'
import { MobileMoreSheet } from '@/components/MobileMoreSheet'
import { buttonClass } from '@/components/ui/Button'
import { COMPANY } from '@/config'
import { isModuleOn } from '@/core/modules'
import type { ModuleKey } from '@/core/tenant'

const BRAND_LOGO = COMPANY.brand?.logo ?? '/logo.svg'
const BRAND_ALT = COMPANY.brand?.logoAlt ?? COMPANY.name

// Šest položek místo dvanácti. Podstránky skupiny jsou záložky nahoře (SectionTabs);
// `matches` určuje, které cesty patří pod položku (aktivní stav v menu).
interface NavItem {
  href: string
  label: string
  /** Kratší popisek do spodní lišty na mobilu (šestina šířky telefonu). */
  mobileLabel?: string
  salesOnly: boolean
  matches: string[]
  icon: ReactNode
  /** Modul, který jde u firmy vypnout (CompanyConfig.modules). */
  module?: ModuleKey
}

const NAV_ITEMS: NavItem[] = [
  { href: '/cockpit', label: 'Dnes', salesOnly: false, matches: ['/cockpit', '/cockpit/prehled-tydne'],
    icon: (<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></svg>) },
  { href: '/cockpit/rozhodnuti', label: 'Ke schválení', mobileLabel: 'Schválení', salesOnly: false, matches: ['/cockpit/rozhodnuti'],
    icon: (<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.1V12a10 10 0 1 1-5.9-9.1" /><path d="M22 4 12 14l-3-3" /></svg>) },
  { href: '/cockpit/pipeline', label: 'Obchody', salesOnly: true, matches: ['/cockpit/pipeline', '/cockpit/agent', '/cockpit/signaly', '/cockpit/cilove-seznamy', '/cockpit/oslovovani', '/cockpit/nabidka', '/cockpit/sales'],
    icon: (<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="7" width="20" height="14" rx="3" /><path d="M16 7V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v2M2 13h20" /></svg>) },
  { href: '/cockpit/clients', label: 'Klienti', salesOnly: false, matches: ['/cockpit/clients', '/cockpit/partners', '/cockpit/kontakty', '/cockpit/hledat'],
    icon: (<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="3" width="16" height="18" rx="2" /><path d="M9 8h.01M15 8h.01M9 12h.01M15 12h.01M10 21v-4h4v4" /></svg>) },
  { href: '/cockpit/tasks', label: 'Práce', salesOnly: false, matches: ['/cockpit/tasks', '/cockpit/pripady', '/cockpit/dodavky', '/cockpit/objednavky', '/cockpit/schuzky', '/cockpit/kapacity', '/cockpit/aktivity', '/cockpit/inventura'],
    icon: (<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="7" height="18" rx="2" /><rect x="14" y="3" width="7" height="11" rx="2" /></svg>) },
  { href: '/cockpit/finance', label: 'Finance', salesOnly: true, matches: ['/cockpit/finance'], module: 'finance',
    icon: (<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="2" y="5" width="20" height="14" rx="3" /><path d="M2 10h20M6 15h4" /></svg>) },
]

const ADMIN_NAV_ITEMS: NavItem[] = [
  { href: '/cockpit/tym', label: 'Tým a nastavení', salesOnly: false, matches: ['/cockpit/tym', '/cockpit/api-klice', '/cockpit/nastaveni'],
    icon: (<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12" /><circle cx="16" cy="6" r="2" /><circle cx="10" cy="12" r="2" /><circle cx="18" cy="18" r="2" /></svg>) },
]

/** Aktivní položka: `/` jen přesně, ostatní i s podstránkami (ne `/cockpit/tasks` pro `/tasksx`). */
export function isActivePath(pathname: string, href: string): boolean {
  if (href === '/cockpit') return pathname === '/cockpit'
  return pathname === href || pathname.startsWith(`${href}/`)
}

const ACCOUNT_LINKS = [
  { href: '/cockpit/nastaveni', label: 'Nastavení' },
  { href: '/auth/mfa/enroll', label: 'Zabezpečení (2FA)' },
]

/** Kolik sekcí se vejde do spodní lišty na mobilu (zbytek je v panelu „Další“). */
export const MOBILE_BAR_MAX = 5

export function Sidebar({ name, isAdmin = false, canSeeSales = false }:
  { name: string; isAdmin?: boolean; canSeeSales?: boolean }) {
  const pathname = usePathname()
  const palette = useCommandPalette()
  const help = useShortcutsHelp()
  const shortcut = usePaletteShortcutLabel()
  const mainItems = NAV_ITEMS.filter((item) => (!item.salesOnly || canSeeSales) && (!item.module || isModuleOn(COMPANY.modules, item.module)))
  const items = isAdmin ? [...mainItems, ...ADMIN_NAV_ITEMS] : mainItems
  const isActive = (item: { matches: string[] }) => item.matches.some((m) => isActivePath(pathname, m))
  // Spodní lišta na mobilu: nejvýš pět sekcí podle role (pořadí z NAV_ITEMS),
  // šestá pozice je „Další“ – panel se zbylými sekcemi (Finance, Tým…),
  // hledáním a účtem. Lišta se tak nikdy neposouvá do strany.
  const barCount = Math.min(MOBILE_BAR_MAX, mainItems.length)
  const moreItems = items.slice(barCount)
  const moreActive = moreItems.some(isActive)
    || ACCOUNT_LINKS.some((l) => isActivePath(pathname, l.href))
  const [moreOpen, setMoreOpen] = useState(false)
  const sheetId = useId()
  const closeMore = () => setMoreOpen(false)
  // Zavřít panel po přechodu na jinou stránku. Stav se nastaví během renderu
  // (vzor „adjusting state when a prop changes“), ne v efektu.
  const [lastPath, setLastPath] = useState(pathname)
  if (lastPath !== pathname) {
    setLastPath(pathname)
    setMoreOpen(false)
  }

  return (
    <>
    <aside aria-label="Navigace aplikace" className="fixed inset-x-0 bottom-0 z-40 flex h-auto w-full shrink-0 flex-col border-t border-border bg-surface/95 px-2 pt-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))] shadow-[0_-8px_30px_rgba(20,25,34,.08)] backdrop-blur md:sticky md:top-4 md:m-4 md:mr-0 md:h-[calc(100vh-2rem)] md:w-[236px] md:rounded-card md:border md:border-t-0 md:p-4 md:shadow-card">
      <div className="mb-5 hidden items-center gap-2.5 px-2 py-3 md:flex">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={BRAND_LOGO} alt={BRAND_ALT} className="h-[22px] w-auto" />
        <span className="font-body text-sm text-muted border-l border-border pl-2.5 leading-none">Cockpit</span>
      </div>
      <button
        type="button"
        onClick={() => palette.open()}
        aria-haspopup="dialog"
        aria-keyshortcuts="Control+K Meta+K"
        className="mb-3 hidden min-h-[40px] items-center gap-2.5 rounded-btn bg-[color:var(--c-soft)] px-3 text-left text-callout text-muted hover:text-ink md:flex"
      >
        <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
        <span className="flex-1">Hledat…</span>
        <kbd aria-hidden="true">{shortcut}</kbd>
      </button>
      <nav aria-label="Hlavní navigace" className="grid auto-cols-fr grid-flow-col gap-0.5 md:flex md:flex-col md:gap-1">
        {items.map((item, i) => {
          const active = isActive(item)
          const mobileLabel = item.mobileLabel
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? 'page' : undefined}
              className={`${i < barCount ? 'flex' : 'hidden md:flex'} min-h-[48px] min-w-0 flex-col items-center justify-center gap-0.5 rounded-btn px-0.5 py-1 text-[11px] leading-tight no-underline md:min-h-[44px] md:flex-row md:justify-start md:gap-3 md:px-3 md:py-2.5 md:text-[14.5px] md:font-semibold md:rounded-[14px] ${
                active ? 'bg-cta-bg text-cta-fg font-semibold' : 'text-[color:#3A424E] hover:bg-[color:var(--c-soft)] hover:text-ink'
              }`}
            >
              {item.icon}
              {mobileLabel ? (
                <>
                  <span className="max-w-full truncate md:hidden">{mobileLabel}</span>
                  <span className="hidden whitespace-nowrap md:inline">{item.label}</span>
                </>
              ) : (
                <span className="max-w-full truncate md:whitespace-nowrap">{item.label}</span>
              )}
            </Link>
          )
        })}
        <button
          type="button"
          aria-haspopup="dialog"
          aria-expanded={moreOpen}
          aria-controls={moreOpen ? sheetId : undefined}
          // Fokus na tlačítko i v Safari (to ho po kliknutí nefokusuje), ať se
          // na něj po zavření panelu vrátí (useModal vrací fokus na opener).
          onClick={(e) => { e.currentTarget.focus(); setMoreOpen(true) }}
          className={`flex min-h-[48px] min-w-0 flex-col items-center justify-center gap-0.5 rounded-btn px-0.5 py-1 text-[11px] leading-tight md:hidden ${
            moreActive ? 'bg-cta-bg text-cta-fg font-semibold' : moreOpen ? 'bg-[color:var(--c-soft)] text-ink' : 'text-[color:#3A424E]'
          }`}
        >
          <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="5" cy="12" r="1.4" /><circle cx="12" cy="12" r="1.4" /><circle cx="19" cy="12" r="1.4" /></svg>
          <span className="max-w-full truncate">Další</span>
        </button>
      </nav>
      <div className="mt-auto hidden flex-col gap-1 border-t border-border pt-4 md:flex">
        <span className="px-2 text-muted text-xs truncate">{name}</span>
        <Link href="/cockpit/nastaveni" aria-current={isActivePath(pathname, '/cockpit/nastaveni') ? 'page' : undefined} className="px-2 py-1 min-h-[24px] [@media(pointer:coarse)]:min-h-[44px] text-muted text-xs no-underline hover:text-ink flex items-center gap-2">
          <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M19.1 4.9L17 7M7 17l-2.1 2.1" />
          </svg>
          Nastavení
        </Link>
        <Link href="/auth/mfa/enroll" className="px-2 py-1 min-h-[24px] [@media(pointer:coarse)]:min-h-[44px] text-muted text-xs no-underline hover:text-ink flex items-center gap-2">
          <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="4.5" y="10.5" width="15" height="10" rx="2" />
            <path d="M8 10.5V7a4 4 0 0 1 8 0v3.5" />
          </svg>
          Zabezpečení (2FA)
        </Link>
        <button
          type="button"
          onClick={() => help.open()}
          aria-haspopup="dialog"
          aria-keyshortcuts="?"
          className="px-2 py-1 min-h-[24px] [@media(pointer:coarse)]:min-h-[44px] text-muted text-xs hover:text-ink flex items-center gap-2 text-left"
        >
          <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <rect x="2.5" y="6" width="19" height="12" rx="2.5" />
            <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" />
          </svg>
          <span className="flex-1">Klávesové zkratky</span>
          <kbd aria-hidden="true">?</kbd>
        </button>
        <form action={signOut} className="mt-1">
          <button type="submit" className={buttonClass('secondary', 'sm', 'w-full')}>Odhlásit</button>
        </form>
      </div>
    </aside>
    <MobileMoreSheet
      open={moreOpen}
      onClose={closeMore}
      id={sheetId}
      name={name}
      items={moreItems.map((item) => ({ href: item.href, label: item.label, icon: item.icon, active: isActive(item) }))}
      accountLinks={ACCOUNT_LINKS.map((l) => ({ ...l, active: isActivePath(pathname, l.href) }))}
      onSearch={() => { setMoreOpen(false); palette.open() }}
    />
    </>
  )
}
