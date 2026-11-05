import Link from 'next/link'
import { Chip } from '@/components/Chip'
import { CARD } from '@/components/ui/Card'
import { summarizeGates } from '@/domain/delivery/deliveryGates'
import { DELIVERY_PHASES, deliveryPhaseLabel, engagementKindLabel } from '@/lib/domain'
import { formatDate, formatPct, formatPp } from '@/lib/format'
import type { Engagement } from '@/lib/types'
import { isAutoDelivery } from '@/domain/delivery/autoDelivery'

// Karta dodávky: druh, fáze jako postup (pruh), šest bran kvality a čísla
// před/po. Údaje bez hodnoty se nezobrazují (nic se nedoplňuje).
export function ClientEngagementCard({ engagement: e, href }: { engagement: Engagement; href: string }) {
  const idx = DELIVERY_PHASES.findIndex((p) => p.key === e.phase)
  const pct = idx >= 0 ? Math.round(((idx + 1) / DELIVERY_PHASES.length) * 100) : 0
  const g = summarizeGates(e)
  const facts: [string, string][] = []
  if (e.baseline_adoption_pct != null) facts.push(['Výchozí stav', formatPct(e.baseline_adoption_pct)])
  if (e.post_adoption_pct != null) facts.push(['Po dodávce', formatPct(e.post_adoption_pct)])
  if (e.adoption_delta_pp != null) facts.push(['Změna', formatPp(e.adoption_delta_pp)])
  if (e.trained_count != null) facts.push(['Vyškoleno', String(e.trained_count)])

  return (
    <article className={`${CARD} flex flex-col gap-3 p-5`}>
      <div className="flex items-start justify-between gap-3">
        <Link href={href} className="font-heading text-title2 font-bold text-ink">
          {engagementKindLabel(e.kind)}
        </Link>
        <div className="flex flex-wrap justify-end gap-1.5">
          {isAutoDelivery(e) && <Chip>Založeno automaticky</Chip>}
          {e.reference_worthy && <Chip tone="pos">Vhodné jako reference</Chip>}
        </div>
      </div>

      <div
        className="bar green thin"
        style={{ height: 10 }}
        role="img"
        aria-label={`Postup dodávky: ${deliveryPhaseLabel(e.phase)}, fáze ${idx + 1} z ${DELIVERY_PHASES.length}`}
      >
        <i style={{ width: `${pct}%` }} />
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className={e.phase === 'uzavreno' ? 'st done' : 'st info'}>{deliveryPhaseLabel(e.phase)}</span>
        {g.overall === 'passed' && <Chip tone="pos">Brány kvality 6/6</Chip>}
        {g.overall === 'failed' && <Chip tone="neg">Brány kvality: {g.failed}× ne</Chip>}
        {g.overall === 'incomplete' && <Chip>Brány kvality {g.passed}/6</Chip>}
        {(e.started_on || e.due_on) && (
          <span className="text-footnote text-muted">
            {e.started_on ? `od ${formatDate(e.started_on)}` : ''}{e.started_on && e.due_on ? ' · ' : ''}{e.due_on ? `do ${formatDate(e.due_on)}` : ''}
          </span>
        )}
      </div>

      {facts.length > 0 && (
        <dl className="m-0 grid grid-cols-2 sm:grid-cols-4 gap-2">
          {facts.map(([k, v]) => (
            <div key={k} className="rounded-[14px] bg-[color:var(--c-soft)] px-3 py-2">
              <dt className="eyebrow">{k}</dt>
              <dd className="m-0 font-bold tabular-nums text-ink">{v}</dd>
            </div>
          ))}
        </dl>
      )}
    </article>
  )
}
