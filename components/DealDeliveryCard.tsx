import Link from 'next/link'
import { DealsCard, DealsIcon } from '@/components/DealsVisuals'
import { CreateDeliveryButton } from '@/components/CreateDeliveryButton'
import { deliveryPhaseLabel, engagementKindLabel } from '@/lib/domain'
import {
  startTaskInfo, workingDaysLabel, type DealDeliverySummary,
} from '@/domain/delivery/autoDelivery'

// Karta „Dodávka" na detailu VYHRANÉHO obchodu. Dodávka se po vyhrání
// zakládá sama (migrace 0080), takže běžný stav je klidná karta s odkazem;
// tlačítko „Založit dodávku" se ukáže jen jako záloha, když dodávka chybí.
const PILL = 'rounded-full border border-border bg-surface px-4 py-2 text-sm font-semibold no-underline'

export function DealDeliveryCard({
  accountId, dealId, summary,
}: { accountId: number; dealId: number; summary: DealDeliverySummary }) {
  const base = `/cockpit/clients/${accountId}/engagements`
  const task = startTaskInfo()

  if (summary.state === 'missing') {
    return (
      <DealsCard className="mb-4">
        <div className="flex flex-wrap items-center gap-4">
          <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full" style={{ background: 'var(--p-sun)' }}>
            <DealsIcon name="alert" size={20} />
          </span>
          <div className="min-w-0 grow basis-64">
            <p className="eyebrow m-0">Dodávka</p>
            <p className="m-0 mt-1 font-heading text-xl font-bold leading-tight tracking-tight">K vyhranému obchodu zatím chybí dodávka</p>
            <p className="m-0 mt-1 text-sm text-muted">
              Dodávka se po vyhrání zakládá sama. Tady se to z nějakého důvodu nestalo. Tlačítko ji založí
              se stejnými výchozími hodnotami: vlastník, rozsah, milníky a úkol pro vlastníka.
            </p>
          </div>
          <CreateDeliveryButton accountId={accountId} dealId={dealId} />
        </div>
      </DealsCard>
    )
  }

  const auto = summary.state === 'auto'
  const first = summary.deliveries[0]
  return (
    <DealsCard className="mb-4">
      <div className="flex flex-wrap items-center gap-4">
        <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full" style={{ background: 'var(--p-mint)' }}>
          <DealsIcon name="check" size={20} />
        </span>
        <div className="min-w-0 grow basis-64">
          <p className="eyebrow m-0">Dodávka</p>
          <p className="m-0 mt-1 font-heading text-xl font-bold leading-tight tracking-tight">
            {auto ? 'Dodávka byla založena automaticky' : 'K obchodu je založená dodávka'}
          </p>
          <p className="m-0 mt-1 text-sm text-muted">
            {auto
              ? 'Po vyhrání obchodu Cockpit sám založil dodávku a předvyplnil klienta, vlastníka, rozsah a milníky.'
              : 'Dodávku k obchodu založil člověk ručně.'}
            {auto && task && ` Vlastník má úkol „${task.title}", termín do ${workingDaysLabel(task.workingDays)}.`}
          </p>
          {summary.deliveries.length > 1 && (
            <ul className="m-0 mt-2 flex list-none flex-wrap gap-2 p-0" aria-label="Dodávky obchodu">
              {summary.deliveries.map((d) => (
                <li key={d.id}>
                  <Link href={`${base}/${d.id}/edit`} className="rounded-full bg-[color:var(--c-soft)] px-3 py-1 text-[12.5px] font-semibold text-ink no-underline">
                    {engagementKindLabel(d.kind)} · {deliveryPhaseLabel(d.phase)}
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
        {auto && <span className="st done">Založeno automaticky</span>}
        <Link href={`${base}/${first.id}/edit`} className={PILL}>Otevřít dodávku</Link>
      </div>
    </DealsCard>
  )
}
