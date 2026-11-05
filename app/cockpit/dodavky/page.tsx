import { PageHeader } from '@/components/PageHeader'
import { SectionTabs, WORK_TABS } from '@/components/SectionTabs'
import { WorkSegNav } from '@/components/WorkUi'
import { CARD } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { TodayNote } from '@/components/ui/TodayParts'
import { PortfolioCard, PortfolioImpactCard, PortfolioKeys, PortfolioRingCard, portfolioHref } from '@/components/DeliveryPortfolio'
import {
  PORTFOLIO_FILTERS, PORTFOLIO_FILTER_LABEL, filterPortfolio, parsePortfolioFilter, parsePortfolioScope, summarizePortfolio,
} from '@/domain/delivery/portfolio'
import { getDeliveryPortfolio } from '@/domain/delivery/queries/portfolio'
import { plural } from '@/domain/crm/today'
import { getCurrentMember, memberSeesSales } from '@/lib/queries/currentMember'
import { pragueToday } from '@/lib/pragueDate'

export const dynamic = 'force-dynamic'

// Portfolio dodávek: všechny běžící dodávky na jednom místě, nejrizikovější
// nahoře. Filtr Moje / Celý tým (?kdo=) a stav (?stav=). Bez peněz; rozsah
// z přijaté nabídky vidí jen obchodní role, ostatním se ukáže rozsah
// z předávacího balíčku dodávky.

export default async function DeliveryPortfolioPage({
  searchParams,
}: {
  searchParams: Promise<{ kdo?: string | string[]; stav?: string | string[] }>
}) {
  const sp = await searchParams
  const scope = parsePortfolioScope(sp.kdo)
  const filter = parsePortfolioFilter(sp.stav)
  const { user, member } = await getCurrentMember()
  const result = await getDeliveryPortfolio({ today: pragueToday(), canSeeSales: memberSeesSales(member) })

  const header = (children?: React.ReactNode, subtitle?: string) => (
    <>
      <PageHeader
        title="Dodávky"
        eyebrow="Práce"
        subtitle={subtitle ?? 'Co je slíbeno, kdy to má být hotové, na co se čeká a kdo za to odpovídá. Nejrizikovější dodávky jsou nahoře.'}
      >
        {children}
      </PageHeader>
      <SectionTabs tabs={WORK_TABS} label="Práce" />
    </>
  )

  if (result.state === 'error') {
    return (
      <>
        {header()}
        <div className={CARD}>
          <EmptyState title="Dodávky se nepodařilo načíst" action={{ href: portfolioHref({ scope, filter }), label: 'Zkusit znovu' }}>
            Zkus to prosím za chvíli znovu.
          </EmptyState>
        </div>
      </>
    )
  }

  const all = result.items
  const mine = filterPortfolio(all, { scope: 'moje', meId: user?.id ?? null })
  const inScope = scope === 'moje' ? mine : all
  const summary = summarizePortfolio(inScope)
  const shown = filterPortfolio(inScope, { scope: 'vse', meId: null, filter })

  return (
    <>
      {header(
        <WorkSegNav
          label="Čí dodávky"
          items={[
            { href: portfolioHref({ scope: 'moje', filter }), label: 'Moje', active: scope === 'moje', count: mine.length },
            { href: portfolioHref({ scope: 'vse', filter }), label: 'Celý tým', active: scope === 'vse', count: all.length },
          ]}
        />,
        summary.active === 0
          ? undefined
          : `${summary.active} ${plural(summary.active, 'aktivní dodávka', 'aktivní dodávky', 'aktivních dodávek')}${summary.late > 0 ? `, ${summary.late} po termínu` : ''}. Nejrizikovější jsou nahoře.`,
      )}

      {result.unavailable.length > 0 && (
        <div className="mb-4">
          <TodayNote problem>
            Nepodařilo se načíst: {result.unavailable.join(', ')}. Zbytek portfolia je vidět, ale u dodávek to může chybět.
          </TodayNote>
        </div>
      )}

      <section aria-labelledby="dod-souhrn" className="mb-8 flex flex-col gap-4">
        <h2 id="dod-souhrn" className="sr-only">Souhrn dodávek</h2>
        <PortfolioKeys summary={summary} scope={scope} active={filter} withStale />
        <div className="grid gap-4 lg:grid-cols-2">
          <PortfolioRingCard summary={summary} />
          <PortfolioImpactCard summary={summary} />
        </div>
      </section>

      <section aria-labelledby="dod-seznam">
        <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
          <h2 id="dod-seznam" className="m-0 font-heading text-title1 font-bold">
            {filter ? PORTFOLIO_FILTER_LABEL[filter] : 'Podle rizika'}
            <span className="ml-2 font-body text-body font-semibold tabular-nums text-muted">
              {shown.length} {plural(shown.length, 'dodávka', 'dodávky', 'dodávek')}
            </span>
          </h2>
          <WorkSegNav
            label="Filtr podle stavu"
            items={[
              { href: portfolioHref({ scope }), label: 'Vše', active: filter === null },
              ...PORTFOLIO_FILTERS.map((f) => ({ href: portfolioHref({ scope, filter: f }), label: PORTFOLIO_FILTER_LABEL[f], active: filter === f })),
            ]}
          />
        </div>

        {all.length === 0 ? (
          <div className={CARD}>
            <EmptyState title="Zatím žádná běžící dodávka" action={{ href: '/cockpit/clients', label: 'Vybrat klienta' }}>
              Dodávku založíš u klienta v záložce Dodávky.
            </EmptyState>
          </div>
        ) : shown.length === 0 ? (
          <div className={CARD}>
            {filter ? (
              <EmptyState tone="calm" title="Žádná dodávka neodpovídá filtru" action={{ href: portfolioHref({ scope }), label: 'Ukázat všechny' }}>
                V tomhle stavu teď nic není.
              </EmptyState>
            ) : (
              <EmptyState title="Nemáš žádnou dodávku" action={{ href: portfolioHref({ filter }), label: 'Ukázat celý tým' }}>
                Sem se dostanou dodávky, kde jsi vlastník, zástupce nebo vlastník milníku.
              </EmptyState>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            {shown.map((item) => <PortfolioCard key={item.id} item={item} />)}
          </div>
        )}
      </section>
    </>
  )
}
