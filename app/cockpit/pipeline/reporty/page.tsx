import Link from 'next/link'
import { redirect } from 'next/navigation'
import { PageHeader } from '@/components/PageHeader'
import { ExportButtons } from '@/components/ExportButtons'
import { DealsSectionTabs } from '@/components/DealsSectionTabs'
import { Card } from '@/components/ui/Card'
import { DataTable } from '@/components/DataTable'
import { SalesLeaderboard, type SalesLeaderboardEntry } from '@/components/SalesLeaderboard'
import { DealsStageRing, DealsValueHatch, moneyParts, type StageRingSlice, type ValueHatchItem } from '@/components/DealsVisuals'
import { getSalesDeals } from '@/domain/crm/queries/sales'
import { listTeamMembers } from '@/lib/queries/team'
import { getAccountRollup, getPipelineByLine } from '@/lib/queries/dashboard'
import { formatCzkShort } from '@/lib/format'
import { buildSalesDashboard, OPEN_DEAL_STAGES, weightedValue } from '@/domain/crm/sales'
import { dealStageLabel, defaultProbabilityForStage, revenueLineLabel } from '@/lib/domain'
import { canCurrentUserSeeSales } from '@/lib/queries/access'

export const dynamic = 'force-dynamic'


// Reporty obchodů (plán vlny 2): grafy a tabulky, které dřív visely pod
// tabulí. Stejná data a stejná brána jako tabule (jen obchodní role).
export default async function PipelineReportsPage() {
  if (!await canCurrentUserSeeSales()) redirect('/cockpit')
  const [allDeals, members, pipelineByLine, accountRollup] = await Promise.all([
    getSalesDeals(), listTeamMembers(), getPipelineByLine(), getAccountRollup(),
  ])
  const open = allDeals.filter((deal) => OPEN_DEAL_STAGES.includes(deal.stage))

  // 37 klientů má řádek v rollupu, ale drtivá většina bez podepsané zakázky
  // (contracted_one_time 0/null) — bez filtru by tabulka byla šum, ne report.
  // Řazení od největšího už dělá getAccountRollup() na úrovni SQL, filtr ho nemění.
  const rollupRows = accountRollup.filter(
    (row) => row.contracted_one_time != null && Number(row.contracted_one_time) !== 0,
  )

  // Žebříček obchodníků: buildSalesDashboard() nad daty, která už tahle
  // stránka natáhla (allDeals, members) — bez další DB query. Aktivity
  // sem nedáváme (prázdné pole), protože počítají jen do activities30d,
  // sloupec, který v tabulce dole nezobrazujeme.
  const dealCountByOwner = new Map<string | null, number>()
  for (const deal of open) {
    const key = deal.owner_id ?? null
    dealCountByOwner.set(key, (dealCountByOwner.get(key) ?? 0) + 1)
  }
  const dashboard = buildSalesDashboard(allDeals, [], members)
  const leaderboard: SalesLeaderboardEntry[] = dashboard.leaderboard.map((row) => ({
    ...row,
    dealCount: dealCountByOwner.get(row.ownerId) ?? 0,
  }))

  const ringSlices: StageRingSlice[] = OPEN_DEAL_STAGES.map((stage) => {
    const inStage = open.filter((deal) => deal.stage === stage)
    return {
      key: stage, label: dealStageLabel(stage), count: inStage.length,
      amount: inStage.reduce((sum, deal) => sum + Number(deal.amount_one_time ?? 0), 0),
    }
  })
  const hatchItems: ValueHatchItem[] = open
    .filter((deal) => Number(deal.amount_one_time ?? 0) > 0)
    .sort((a, b) => Number(b.amount_one_time) - Number(a.amount_one_time))
    .slice(0, 6)
    .map((deal) => ({
      id: deal.id, label: deal.account?.name ?? deal.title, amount: Number(deal.amount_one_time),
      weighted: weightedValue(deal), probability: deal.probability_pct ?? defaultProbabilityForStage(deal.stage),
    }))
  const closing = moneyParts(dashboard.closing30d)

  return (
    <>
      <PageHeader title="Reporty obchodů" eyebrow="Obchody" subtitle="Kde vzniká byznys: fáze, největší obchody, obchodníci a klienti.">
        {/* Všechny verze nabídek (deal_scope_version) s klientem, stavem a částkou. */}
        <ExportButtons prehled="nabidky" title="Nabídky" label="Stáhnout přehled nabídek" />
      </PageHeader>
      <DealsSectionTabs />

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_300px]">
        <Card title="Podle fází" sub="Otevřené obchody podle počtu a hodnoty">
          <DealsStageRing slices={ringSlices} />
        </Card>
        <Card title="Hodnota a šance obchodů" sub="Šest největších otevřených obchodů">
          <DealsValueHatch items={hatchItems} />
        </Card>
        <Card title="Uzavření do 30 dní" sub="Otevřené obchody s očekávaným uzavřením do měsíce" className="lg:col-span-2 xl:col-span-1">
          <div className="big-num text-[32px] text-ink">
            {closing.num}<small className="ml-1.5 font-heading text-[13px] font-bold tracking-normal text-muted">{closing.unit}</small>
          </div>
        </Card>
      </div>

      <section aria-labelledby="zebricek" className="mt-8">
        <h2 id="zebricek" className="m-0 font-heading text-title1 font-bold">Žebříček</h2>
        <p className="mb-4 mt-1 text-callout text-muted">
          Každý vlastník obchodu (i s nulami), obchody bez vlastníka pod „Nepřiřazeno&rdquo; — seřazeno podle hodnoty s pravděpodobností.
        </p>
        <SalesLeaderboard rows={leaderboard} />
      </section>

      {/* v_pipeline_by_line a v_account_rollup: obě views v Postgresu počítají
          reálná čísla, tady je jejich jediné místo v UI. */}
      <section aria-labelledby="podle-produktu" className="mt-8">
        <h2 id="podle-produktu" className="m-0 font-heading text-title1 font-bold">Otevřené obchody podle produktu</h2>
        <p className="mb-4 mt-1 text-callout text-muted">
          Otevřené obchody (bez vyhraných, prohraných a odložených) rozdělené podle produktu — ukazuje, kde reálně vzniká byznys, ne jen celkový součet.
        </p>
        <DataTable mobile="cards" label="Otevřené obchody podle produktu"
          rows={pipelineByLine}
          empty="Žádný otevřený obchod."
          columns={[
            { header: 'Produkt', cell: (row) => revenueLineLabel(row.revenue_line) },
            { header: 'Počet obchodů', cell: (row) => <span className="tabular-nums">{row.deals}</span> },
            { header: 'Hrubá hodnota', cell: (row) => <span className="tabular-nums">{formatCzkShort(row.gross_one_time)}</span> },
            { header: 'S pravděpodobností', cell: (row) => <span className="tabular-nums">{formatCzkShort(row.weighted_pipeline)}</span> },
          ]}
        />
      </section>

      <section aria-labelledby="podle-klienta" className="mt-8">
        <h2 id="podle-klienta" className="m-0 font-heading text-title1 font-bold">Přehled podle klienta</h2>
        <p className="mb-4 mt-1 text-callout text-muted">
          Klienti s podepsanou jednorázovou zakázkou, seřazení od největší — běžící a ohrožené měsíční platby se teprve plní z tabulky předplatných, dnes proto většinou ukáže 0 Kč.
        </p>
        <DataTable mobile="cards" label="Přehled podle klienta"
          rows={rollupRows}
          empty="Žádný klient zatím nemá podepsanou jednorázovou zakázku."
          columns={[
            { header: 'Klient', cell: (row) => <Link href={`/cockpit/clients/${row.id}`}>{row.name}</Link> },
            { header: 'Jednorázově', cell: (row) => <span className="tabular-nums">{formatCzkShort(row.contracted_one_time)}</span> },
            { header: 'Běžící měsíčně', cell: (row) => <span className="tabular-nums">{formatCzkShort(row.running_mrr)}</span> },
            { header: 'Měsíčně v riziku', cell: (row) => <span className="tabular-nums">{formatCzkShort(row.at_risk_mrr)}</span> },
          ]}
        />
      </section>
    </>
  )
}
