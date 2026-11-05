import Link from 'next/link'

export type DealDetailTab = { key: string; label: string }

// Záložky detailu obchodu (server komponenta, docs/PROVOZ.md §11):
// stejný segmentový přepínač jako záložky sekce. Aktivní záložka je v adrese
// jako ?tab=…, takže jde odkázat i použít tlačítko Zpět.
export function DealsDetailTabs({ base, tabs, active }: { base: string; tabs: DealDetailTab[]; active: string }) {
  return (
    <nav aria-label="Části obchodu">
      <div className="seg">
        {tabs.map((t) => (
          <Link
            key={t.key}
            href={`${base}?tab=${t.key}`}
            scroll={false}
            className="seg-item"
            aria-current={t.key === active ? 'page' : undefined}
          >
            {t.label}
          </Link>
        ))}
      </div>
    </nav>
  )
}
