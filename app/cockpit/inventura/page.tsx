import { redirect } from 'next/navigation'
import { FeaturePending } from '@/components/ui/FeaturePending'
import { PageHeader } from '@/components/PageHeader'
import { InventoryRow } from '@/components/InventoryRow'
import { CARD } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { canCurrentUserSeeSales } from '@/lib/queries/access'
import { getInventoryDeals } from '@/domain/crm/queries/inventory'
import { updateInventoryDeal } from '@/domain/crm/actions/inventory'

export const dynamic = 'force-dynamic'

// Inventura otevřených obchodů (kap. 5, rozhodnutí vlastníka 28. 9. 2026):
// Viktor tu sám doplňuje typ obchodu a rozhodovatele u obchodů, kde to
// chybí. Sales-only, stejně jako /schuzky — viz lib/queries/access.ts.
//
// Ze Sidebaru sem záměrně žádný odkaz nevede (mimo rozsah téhle změny) —
// zatím stránka na /inventura existuje bez navigačního vstupu; nav odkaz
// (Sidebar nebo /pipeline) je potřeba doplnit zvlášť.
export default async function InventoryPage() {
  if (!await canCurrentUserSeeSales()) redirect('/cockpit')
  const { deals, totalOpen, done, columns0052Available } = await getInventoryDeals()

  return (
    <>
      <PageHeader
        title="Inventura obchodů"
        eyebrow="Obchody"
        back={{ href: '/cockpit/pipeline', label: 'Obchody' }}
        subtitle={deals.length === 0
          ? 'Všechny otevřené obchody mají typ, rozhodovatele, vlastníka i další krok.'
          : `U ${deals.length} ${deals.length === 1 ? 'obchodu' : 'obchodů'} chybí typ, rozhodovatel s termínem rozhodnutí, vlastník nebo další krok. Doplň je přímo v řádku.`}
      />

      <section className={`${CARD} mb-6 flex flex-wrap items-center gap-x-8 gap-y-3 p-5`} aria-label="Postup inventury">
        <div>
          <div className="eyebrow">Postup inventury</div>
          <div className="big-num mt-1.5 text-[34px]" role="status">Hotovo {done} z {totalOpen}</div>
        </div>
        {totalOpen > 0 && (
          <div className="min-w-[200px] flex-1">
            <div className="bar green" role="img" aria-label={`Hotovo ${done} z ${totalOpen} otevřených obchodů`}>
              <i style={{ width: `${Math.round((done / totalOpen) * 100)}%` }} />
            </div>
          </div>
        )}
      </section>

      {!columns0052Available && (
        <p role="status" className="mb-6 rounded-btn bg-[color:var(--c-warn-soft)] px-3 py-2 text-callout">
          <FeaturePending
            variant="inline"
            migration="0052"
            title="Typ obchodu a rozhodovací pole (kdo rozhoduje, termín rozhodnutí) se připravují. Zatím se tu kontroluje jen vlastník a další krok."
          />
        </p>
      )}

      {deals.length === 0 ? (
        <div className={CARD}>
          <EmptyState tone="calm" title="Inventura je hotová" action={{ href: '/cockpit/pipeline', label: 'Otevřít obchody' }}>
            Žádný otevřený obchod nic nepostrádá.
          </EmptyState>
        </div>
      ) : (
        <ul className="space-y-4 list-none p-0 m-0">
          {deals.map((deal) => (
            <InventoryRow
              key={deal.id}
              deal={deal}
              action={updateInventoryDeal}
              columns0052Available={columns0052Available}
            />
          ))}
        </ul>
      )}
    </>
  )
}
