import { PageHeader } from '@/components/PageHeader'
import { PipelineBoard } from '@/components/PipelineBoard'
import { DealsSectionTabs } from '@/components/DealsSectionTabs'
import { DealsKpis } from '@/components/DealsKpis'
import { DealsFilterBar } from '@/components/DealsFilterBar'
import { ButtonLink } from '@/components/ui/Button'
import { CARD, CARD_PAD } from '@/components/ui/Card'
import { getOutreachQueue } from '@/domain/crm/queries/outreach'
import { updateDealNextStep, updateDealStage } from '@/domain/crm/actions/sales'
import { getSalesDeals } from '@/domain/crm/queries/sales'
import { listTeamMembers } from '@/lib/queries/team'
import { clientOwnerContext, loadOwnerChangeContext } from '@/lib/queries/ownerChange'
import { buildSalesDashboard, OPEN_DEAL_STAGES, weightedValue } from '@/domain/crm/sales'
import { checkDealInvariant } from '@/domain/crm/dealInvariant'
import { filterPipelineDeals, parsePipelineParams, pipelineStages } from '@/domain/crm/pipelineFilter'
import { ExportButtons } from '@/components/ExportButtons'
import { canCurrentUserSeeSales } from '@/lib/queries/access'
import { redirect } from 'next/navigation'
import { pragueToday, PRAGUE_TZ } from '@/lib/pragueDate'

export const dynamic = 'force-dynamic'

const monthFmt = new Intl.DateTimeFormat('cs-CZ', { timeZone: PRAGUE_TZ, month: 'long', year: 'numeric' })

// Tabule obchodů (plán vlny 2): nahoře tři čísla jako na Dnes, pod nimi jeden
// řádek filtrů a tabule. Fázi i další krok jde změnit přímo na kartě (toast
// se Zpět); grafy a žebříček jsou v záložce Reporty (/pipeline/reporty).
export default async function PipelinePage({
  searchParams,
}: { searchParams: Promise<{ q?: string; owner?: string; state?: string; kind?: string }> }) {
  const params = await searchParams
  if (!await canCurrentUserSeeSales()) redirect('/cockpit')
  const [allDeals, members, outreachQueue, ownerCtx] = await Promise.all([
    getSalesDeals(), listTeamMembers(),
    // Fronta oslovování je jen počet u záložky — když ji nejde načíst, tabule nespadne.
    getOutreachQueue().catch(() => null),
    // Kdo smí měnit vlastníka obchodu a koho jde vybrat (0093).
    loadOwnerChangeContext(),
  ])
  // Filtry stejné jako export (domain/crm/pipelineFilter.ts).
  const filters = parsePipelineParams(params)
  const { owner, state, kind } = filters
  const scopedDeals = filterPipelineDeals(allDeals, filters)
  const open = allDeals.filter((deal) => OPEN_DEAL_STAGES.includes(deal.stage))
  const today = pragueToday()
  const stages = pipelineStages(state)

  const dashboard = buildSalesDashboard(allDeals, [], members)
  const openTotal = open.reduce((sum, deal) => sum + Number(deal.amount_one_time ?? 0), 0)
  const openWeighted = open.reduce((sum, deal) => sum + weightedValue(deal), 0)
  const missingCount = open.filter((deal) => checkDealInvariant(deal).length > 0).length
  const overdueCount = open.filter((deal) => !!deal.next_step_due && deal.next_step_due < today).length
  const attention = [
    missingCount > 0 ? `${missingCount} bez kroku nebo vlastníka` : null,
    overdueCount > 0 ? `${overdueCount} po termínu` : null,
  ].filter(Boolean)
  const subtitle = attention.length > 0
    ? `Pozornost chce ${attention.join(' a ')}. Každý obchod má mít vlastníka, další krok a termín.`
    : 'Každý otevřený obchod má vlastníka, další krok a termín.'
  const owners = members.filter((member) => member.role === 'obchodnik' || member.role === 'vedeni')

  return (
    <>
      <PageHeader title="Obchody" eyebrow="Přehled prodeje" subtitle={subtitle}>
        <ExportButtons prehled="pipeline" params={{ q: params.q, owner, state, kind }} />
        <ButtonLink href="/cockpit/import/zakazky" variant="outline">Import zakázek</ButtonLink>
        <ButtonLink href="/cockpit/inventura" variant="outline">Inventura obchodů</ButtonLink>
        <ButtonLink href="/cockpit/pipeline/new" variant="primary">Založit obchod</ButtonLink>
      </PageHeader>
      <DealsSectionTabs counts={{ '/cockpit/oslovovani': outreachQueue?.length ?? 0 }} />

      <DealsKpis
        open={openTotal}
        weighted={openWeighted}
        won={dashboard.wonThisMonth}
        openCount={open.length}
        monthLabel={monthFmt.format(new Date())}
      />

      <section aria-label="Tabule obchodů" className={`${CARD} ${CARD_PAD}`}>
        <DealsFilterBar values={{ q: params.q ?? '', owner, state, kind }} owners={owners} />
        <PipelineBoard
          key={scopedDeals.map((deal) => `${deal.id}:${deal.stage}:${deal.owner_id ?? ''}:${deal.next_step ?? ''}:${deal.next_step_due ?? ''}`).join('|')}
          deals={scopedDeals}
          stages={stages}
          updateStage={updateDealStage}
          updateNextStep={updateDealNextStep}
          ownerContext={clientOwnerContext(ownerCtx)}
        />
      </section>
    </>
  )
}
