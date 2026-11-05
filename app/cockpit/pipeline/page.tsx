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
import type { DealStage } from '@/lib/types'
import { DEAL_STAGES, isDealKind } from '@/lib/domain'
import { checkDealInvariant } from '@/domain/crm/dealInvariant'

// Uzavřené fáze odvozené z DEAL_STAGES (open: false), v pořadí definice.
const CLOSED_DEAL_STAGES: DealStage[] = DEAL_STAGES.filter((s) => !s.open).map((s) => s.key)
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
  const q = (params.q ?? '').trim().toLowerCase()
  const owner = params.owner ?? 'all'
  const allowedStates: string[] = ['open', 'all', ...CLOSED_DEAL_STAGES]
  const state = allowedStates.includes(params.state ?? 'open')
    ? (params.state ?? 'open')
    : 'open'
  // Typ obchodu (0052): workshop a implementace jsou oddělené obchody.
  // 'none' = zatím neroztříděné (inventura); před nasazením 0052 jsou takové
  // všechny (sloupec chybí).
  const kind = params.kind === 'none' || isDealKind(params.kind) ? params.kind : 'all'
  const scopedDeals = allDeals.filter((deal) => {
    if (owner !== 'all' && deal.owner_id !== owner) return false
    if (kind === 'none' && deal.deal_kind != null) return false
    if (kind !== 'all' && kind !== 'none' && deal.deal_kind !== kind) return false
    if (q && !`${deal.title} ${deal.account?.name ?? ''} ${deal.primary_contact?.full_name ?? ''}`.toLowerCase().includes(q)) return false
    if (state === 'open') return OPEN_DEAL_STAGES.includes(deal.stage)
    if (state === 'all') return true
    return deal.stage === state
  })
  const open = allDeals.filter((deal) => OPEN_DEAL_STAGES.includes(deal.stage))
  const today = pragueToday()
  const stages: DealStage[] = state === 'open'
    ? OPEN_DEAL_STAGES
    : state === 'all'
      ? [...OPEN_DEAL_STAGES, ...CLOSED_DEAL_STAGES]
      : [state as DealStage]

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
