import Link from 'next/link'
import { redirect } from 'next/navigation'
import { PageHeader } from '@/components/PageHeader'
import { DealsSectionTabs } from '@/components/DealsSectionTabs'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { AgentKpiTiles } from '@/components/AgentKpiTiles'
import { AgentBreakdown, AgentFunnel } from '@/components/AgentFunnel'
import { AgentActivityTable, AgentAttentionTable } from '@/components/AgentActivityTable'
import { ShopOrderOverviewCard } from '@/components/ShopOrderOverviewCard'
import { requireModule } from '@/app/cockpit/moduleGuard'
import { COMPANY } from '@/config'
import { isModuleOn } from '@/core/modules'
import { PERIOD_DAYS, parsePeriod } from '@/domain/crm/agentKpi'
import { loadAgentOverview } from '@/domain/crm/agentKpiQueries'
import { canCurrentUserSeeSales } from '@/lib/queries/access'
import { pragueToday } from '@/lib/pragueDate'

export const dynamic = 'force-dynamic'

// Přehled agenta na poptávky (P5): CSO a CEO na jedné stránce vidí frontu,
// která čeká na člověka, KPI, trychtýř podle fáze obchodu, důvody eskalací
// a proher, poslední rozhodnutí agenta a objednávky cheesecaků z webu.
// Data čte pod session přihlášeného (RLS can_see_sales); text e-mailů ani
// kontakty se sem nenačítají.
export default async function AgentPage({ searchParams }: { searchParams: Promise<{ obdobi?: string | string[] }> }) {
  // Brána modulu je i v layout.tsx; tady kvůli přímému volání stránky (testy).
  requireModule('agent')
  if (!await canCurrentUserSeeSales()) redirect('/cockpit')
  const days = parsePeriod((await searchParams).obdobi)
  const today = pragueToday()
  const withShop = isModuleOn(COMPANY.modules, 'shopOrders')
  const o = await loadAgentOverview({ today, days, withShop })
  const { kpi } = o

  return (
    <>
      <PageHeader title="Agent na poptávky" eyebrow="Obchody"
        subtitle="Co agent rozhodl, co čeká na člověka a jak rychle zákazník dostane odpověď a nabídku." />
      <DealsSectionTabs />

      <nav aria-label="Období" className="-mt-2 mb-6">
        <div className="seg">
          {PERIOD_DAYS.map((d) => (
            <Link key={d} href={`/cockpit/agent?obdobi=${d}`} className="seg-item" aria-current={d === days ? 'page' : undefined}>
              {d} dní
            </Link>
          ))}
        </div>
      </nav>

      {o.agentMissing && (
        <div className="mb-6">
          <EmptyState title="Agent není zapnutý.">
            Tabulky agenta na poptávky ještě nejsou nasazené. Až agent poběží, uvidíš tady jeho rozhodnutí, odeslané zprávy a čísla.
          </EmptyState>
        </div>
      )}

      {o.unavailable.length > 0 && (
        <p role="status" className="mb-4 rounded-btn bg-[color:var(--c-warn-soft)] px-3 py-2 text-sm text-[color:var(--c-warn)]">
          Nepodařilo se načíst: {o.unavailable.join(', ')}. Čísla z těchto zdrojů mohou chybět.
        </p>
      )}

      <section id="fronta" aria-labelledby="fronta-nadpis" className="mb-8">
        <h2 id="fronta-nadpis" className="m-0 font-heading text-title1 font-bold">Čeká na člověka</h2>
        <p className="mb-4 mt-1 text-callout text-muted">
          Zprávy agenta, které potřebují kontrolu nebo je brána odeslání zastavila — bez ohledu na období.
        </p>
        <AgentAttentionTable rows={o.attention} />
      </section>

      <AgentKpiTiles kpi={kpi} />

      <div className="mb-8 grid gap-4 lg:grid-cols-2">
        <Card title="Trychtýř" sub={`Obchody založené za posledních ${days} dní podle dosažené fáze`}>
          <AgentFunnel steps={kpi.funnel} />
        </Card>
        <Card title="Proč agent eskaloval" sub="Důvody předání poptávky člověku (jedna poptávka může mít víc důvodů)">
          <AgentBreakdown rows={kpi.escalations.byReason} empty="Agent v období nic neeskaloval." label="Důvody eskalace" />
        </Card>
        <Card title="Důvody prohry" sub={`Obchody prohrané za posledních ${days} dní`}>
          <AgentBreakdown rows={kpi.lostReasons} empty="V období žádný prohraný obchod." label="Důvody prohry" />
        </Card>
        <Card title="Rozhodnutí agenta" sub="Jak agent naložil s přijatými zprávami">
          <AgentBreakdown rows={kpi.inquiries.byDecision} empty="Agent v období nic nerozhodoval." label="Rozhodnutí agenta" />
        </Card>
      </div>

      <section id="rozhodnuti" aria-labelledby="rozhodnuti-nadpis" className="mb-8">
        <h2 id="rozhodnuti-nadpis" className="m-0 font-heading text-title1 font-bold">Poslední rozhodnutí</h2>
        <p className="mb-4 mt-1 text-callout text-muted">Nejnovější nahoře; bez textu e-mailů a kontaktů — detail je v obchodu.</p>
        <AgentActivityTable rows={o.activity} />
      </section>

      {o.shop && (
        <section aria-label="Objednávky cheesecaků" className="mb-8">
          <ShopOrderOverviewCard shop={o.shop} days={days} />
        </section>
      )}
    </>
  )
}
