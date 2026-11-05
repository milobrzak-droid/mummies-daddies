import Link from 'next/link'
import { FeaturePending } from '@/components/ui/FeaturePending'
import { redirect } from 'next/navigation'
import { PageHeader } from '@/components/PageHeader'
import { DealsSectionTabs } from '@/components/DealsSectionTabs'
import { DealsSegmentedBar } from '@/components/DealsVisuals'
import { DealsStats } from '@/components/DealsKpis'
import { targetStatusParts } from '@/components/DealsTargetParts'
import { TargetListForm } from '@/components/TargetListForm'
import { buttonClass } from '@/components/ui/Button'
import { CARD, CardLink } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { getTargetLists } from '@/domain/crm/queries/targetLists'
import type { TargetListCounts } from '@/domain/crm/targetLists'
import { canCurrentUserSeeSales } from '@/lib/queries/access'

export const dynamic = 'force-dynamic'

const firms = (n: number) => (n === 1 ? 'firma' : n >= 2 && n <= 4 ? 'firmy' : 'firem')

// Seznamy k oslovení (plán vlny 2): nahoře klidné počty, pod nimi karty
// seznamů (klik na název otevře detail), formulář na konci (#novy-seznam).
export default async function TargetListsPage() {
  if (!await canCurrentUserSeeSales()) redirect('/cockpit')
  const res = await getTargetLists()
  const sum = (key: keyof TargetListCounts) => res.state === 'ok' ? res.lists.reduce((s, l) => s + l.counts[key], 0) : 0
  return (
    <>
      <PageHeader
        title="Seznamy k oslovení"
        eyebrow="Obchody"
        subtitle="Segment, proč ho oslovit, koho a s jakou hypotézou hodnoty. Oslovení se zapíše jako aktivita, nikdy jako obchod."
      >
        {res.state === 'ok' && <a href="#novy-seznam" className={buttonClass('primary')}>Založit seznam</a>}
      </PageHeader>
      <DealsSectionTabs />
      {res.state === 'missing_migration' && (
        <FeaturePending card migration="0048">Pak tu půjde zakládat seznamy a přidávat do nich firmy.</FeaturePending>
      )}
      {res.state === 'error' && (
        <div className={CARD}>
          <EmptyState title="Cílové seznamy se nepodařilo načíst." action={{ href: '/cockpit/cilove-seznamy', label: 'Zkusit znovu' }}>
            Může jít o chvilkový výpadek spojení.
          </EmptyState>
        </div>
      )}
      {res.state === 'ok' && (
        <div className="flex flex-col gap-8">
          <DealsStats
            className=""
            label="Seznamy v číslech"
            stats={[
              { label: 'Seznamy', value: res.lists.length },
              { label: 'Firem celkem', value: sum('total') },
              { label: 'Osloveno', value: sum('osloveno') },
              { label: 'Odpovědělo', value: sum('odpovedel') },
            ]}
          />

          {res.lists.length === 0 ? (
            <div className={CARD}>
              <EmptyState title="Zatím žádný seznam k oslovení." action={{ href: '#novy-seznam', label: 'Založit seznam' }}>
                Stačí název, segment a důvod, proč ho oslovit.
              </EmptyState>
            </div>
          ) : (
            <ul aria-label="Seznamy k oslovení" className="m-0 grid list-none gap-4 p-0 md:grid-cols-2 xl:grid-cols-3">
              {res.lists.map((l) => (
                <li key={l.id}>
                  <article className={`${CARD} flex h-full flex-col gap-3 p-5`}>
                    <div className="flex items-start gap-3">
                      <div className="min-w-0 flex-1">
                        <h2 className="m-0 font-heading text-title2 font-bold">
                          <Link href={`/cockpit/cilove-seznamy/${l.id}`} className="text-ink no-underline hover:underline">{l.name}</Link>
                        </h2>
                        <p className="m-0 mt-0.5 text-callout text-muted">{l.segment}</p>
                      </div>
                      <CardLink href={`/cockpit/cilove-seznamy/${l.id}`} label={`Otevřít seznam ${l.name}`} />
                    </div>
                    <p className="m-0 flex items-baseline gap-2">
                      <span className="big-num text-[32px]">{l.counts.total}</span>
                      <span className="text-callout font-semibold text-muted">{firms(l.counts.total)}</span>
                    </p>
                    <DealsSegmentedBar parts={targetStatusParts(l.counts)} />
                    <dl className="m-0 mt-auto grid grid-cols-4 gap-1 text-center">
                      {targetStatusParts(l.counts).map((p) => (
                        <div key={p.label} className="flex flex-col-reverse">
                          <dt className="text-[11px] text-muted">{p.label}</dt>
                          <dd className="m-0 text-headline tabular-nums">{p.value}</dd>
                        </div>
                      ))}
                    </dl>
                  </article>
                </li>
              ))}
            </ul>
          )}

          <section id="novy-seznam" aria-labelledby="novy-seznam-h" className="scroll-mt-24">
            <h2 id="novy-seznam-h" className="m-0 mb-3 font-heading text-title2 font-bold">Nový seznam</h2>
            <TargetListForm />
          </section>
        </div>
      )}
    </>
  )
}
