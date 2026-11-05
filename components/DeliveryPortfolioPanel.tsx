import { plural } from '@/domain/crm/today'
import type { RiskState } from '@/domain/delivery/portfolio'
import { summarizePortfolio } from '@/domain/delivery/portfolio'
import type { PortfolioResult } from '@/domain/delivery/queries/portfolio'
import { PortfolioKeys } from '@/components/DeliveryPortfolio'
import { ArrowRightIcon, ClockIcon, TodayNote, TodayRow } from '@/components/ui/TodayParts'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'

// Panel „Dodávky" na obrazovce Dnes (jen role, které vidí obchod i dodávky):
// čtyři čísla jako klávesy a tři nejrizikovější dodávky s odkazem. Celý
// přehled je na /dodavky. Pomocná karta: chyba načtení ji nesmí shodit.

const ROW_TONE: Record<RiskState, 'pink' | 'sun' | 'sky' | 'lav'> = { late: 'pink', blocked: 'pink', waiting: 'sun', stale: 'sky', ok: 'lav' }

export function DeliveryPortfolioPanel({ result }: { result: PortfolioResult }) {
  const link = { href: '/cockpit/dodavky', hrefLabel: 'Otevřít portfolio dodávek' }
  if (result.state === 'error') {
    return (
      <Card title="Dodávky" {...link}>
        <TodayNote problem>Dodávky se nepodařilo načíst. Zkus to prosím později, ostatní karty jsou v pořádku.</TodayNote>
      </Card>
    )
  }
  const summary = summarizePortfolio(result.items)
  if (summary.active === 0) {
    return (
      <Card title="Dodávky" {...link}>
        <EmptyState compact title="Žádná aktivní dodávka" action={{ href: '/cockpit/dodavky', label: 'Otevřít dodávky' }}>Až nějaká vznikne, ukáže se tady.</EmptyState>
      </Card>
    )
  }
  const risky = result.items.filter((i) => i.riskScore > 0).slice(0, 3)
  return (
    <Card
      title="Dodávky"
      sub={`${summary.active} ${plural(summary.active, 'aktivní dodávka', 'aktivní dodávky', 'aktivních dodávek')}`}
      {...link}
    >
      <div className="grid gap-6 lg:grid-cols-[minmax(0,26rem)_minmax(0,1fr)]">
        <PortfolioKeys summary={summary} />
        <div className="min-w-0">
          <h3 className="eyebrow m-0 mb-1">Nejrizikovější</h3>
          {risky.length === 0 ? (
            <EmptyState tone="calm" compact title="Žádná dodávka nepotřebuje pozornost">Nic není po termínu, blokované ani bez pohybu.</EmptyState>
          ) : (
            <ul className="m-0 flex list-none flex-col p-0">
              {risky.map((i) => (
                <TodayRow
                  key={i.id}
                  href={i.href}
                  icon={<ClockIcon />}
                  tone={ROW_TONE[i.state]}
                  title={`${i.accountName}: ${i.title}`}
                  sub={i.reasons.map((r) => r.text).join(' · ')}
                  trailing={<span aria-hidden="true" className="shrink-0 text-muted"><ArrowRightIcon size={15} /></span>}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </Card>
  )
}
