import Link from 'next/link'

export type ClientTab = { key: string; label: string; count?: number }

// Záložky detailu klienta jako query `?tab=` (routing se nemění, funguje bez
// JS a odkaz na záložku jde sdílet). První záložka je výchozí bez parametru.
// Vzhled je segmentový přepínač stejný jako záložky sekce (SectionTabs,
// docs/PROVOZ.md §11); na úzkém displeji se dráha posouvá do strany.
export function ClientTabs({ base, tabs, active }: { base: string; tabs: ClientTab[]; active: string }) {
  return (
    <nav aria-label="Oddíly klienta" className="mb-6 max-w-full">
      <div className="seg">
        {tabs.map((t, i) => (
          <Link
            key={t.key}
            href={i === 0 ? base : `${base}?tab=${t.key}`}
            scroll={false}
            className="seg-item whitespace-nowrap no-underline [@media(pointer:coarse)]:min-h-[44px]"
            aria-current={t.key === active ? 'page' : undefined}
          >
            {t.label}
            {typeof t.count === 'number' && t.count > 0 && (
              <span className="seg-count tabular-nums">{t.count}</span>
            )}
          </Link>
        ))}
      </div>
    </nav>
  )
}
