import Link from 'next/link'

export type ClientsSegment = { key: string; href: string; label: string; count?: number; active: boolean }

// Filtr jako segmentový přepínač (docs/PROVOZ.md §11, stejná dráha jako
// záložky sekce): odkazy, ne tlačítka – stav je v URL, funguje bez JS, jde
// sdílet a zpět v prohlížeči. Aktivní segment má aria-current.
export function ClientsSegments({ items, label, className = '' }: { items: ClientsSegment[]; label: string; className?: string }) {
  return (
    <nav aria-label={label} className={`max-w-full ${className}`}>
      <div className="seg">
        {items.map((it) => (
          <Link
            key={it.key}
            href={it.href}
            scroll={false}
            className="seg-item whitespace-nowrap no-underline [@media(pointer:coarse)]:min-h-[44px]"
            aria-current={it.active ? 'page' : undefined}
          >
            {it.label}
            {typeof it.count === 'number' && <span className="seg-count tabular-nums">{it.count.toLocaleString('cs-CZ')}</span>}
          </Link>
        ))}
      </div>
    </nav>
  )
}
