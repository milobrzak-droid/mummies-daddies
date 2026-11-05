import Link from 'next/link'
import { formatDate } from '@/lib/format'
import { DELIVERY_PHASES, deliveryPhaseLabel, engagementKindLabel } from '@/lib/domain'
import {
  deliveryProjectTitle as projectTitle, isDeliveryOverdue as isOverdue, type DeliveryProjectRow,
} from '@/lib/queries/dashboard'
import { plural, type StageSlice } from '@/domain/crm/today'
import {
  ArrowRightIcon, TileChip, TodayCount, TodayStageRing, TodayTile,
} from '@/components/ui/TodayParts'
import { CARD, Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'

// Přehled pro role bez obchodu (projekťák, lektor, partner).
// Staví se z dodávek + deal_public (0058): název obchodu a „vyhráno", nic
// víc. Žádné částky, náklady ani marže — ty patří jen obchodním rolím.

// Fáze dodávek jen rozlišuje (pořadí = postup): datové tóny značky bez
// červené a žluté, které nesou význam problém / čeká (docs/PROVOZ.md §4).
const PHASE_COLORS = [
  'var(--d-blue)', 'var(--d-violet)', 'var(--d-turquoise)', 'var(--d-graphite)',
  'var(--t-blue)', 'var(--t-violet)', 'var(--t-turquoise)',
]

export function DeliveryOverview({
  projects, today, calendarCard, children,
}: {
  projects: DeliveryProjectRow[]
  today: string
  calendarCard: React.ReactNode
  /** Ranní přehled (Co se změnilo, Čeká na klienta) mezi čísly a fázemi. */
  children?: React.ReactNode
}) {
  const active = projects.filter((p) => p.phase !== 'uzavreno')
  const overdue = active.filter((p) => isOverdue(p, today))
  const slices: StageSlice[] = DELIVERY_PHASES.filter((f) => f.key !== 'uzavreno').map((f, i) => ({
    key: f.key,
    label: f.label,
    color: PHASE_COLORS[i % PHASE_COLORS.length],
    count: active.filter((p) => p.phase === f.key).length,
    value: 0,
  }))
  const href = (p: DeliveryProjectRow) => (p.account ? `/cockpit/clients/${p.account.id}/engagements/${p.id}/edit` : '#')
  const closed = projects.length - active.length
  const divider = 'border-t border-[color:var(--c-line-2)] sm:border-l sm:border-t-0'

  // Pořadí podle priority (i na mobilu, jeden sloupec): co dnes udělat a co je
  // po termínu, schůzky; pak čísla, ranní přehled a nakonec fáze dodávek.
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,24rem)]">
        <Card title="Co dnes udělat" sub={active.length ? `${active.length} ${plural(active.length, 'rozběhnutá dodávka', 'rozběhnuté dodávky', 'rozběhnutých dodávek')}` : undefined}>
          {active.length === 0 ? (
            <EmptyState compact title="Žádné rozběhnuté dodávky">Až nějaká vznikne, objeví se tady.</EmptyState>
          ) : (
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {active.map((p) => {
                const title = projectTitle(p)
                const late = isOverdue(p, today)
                return (
                  <TodayTile key={p.id} color={late ? 'peach' : 'pink'}>
                    <Link href={href(p)} className="block truncate font-heading text-[16px] font-bold leading-tight tracking-tight text-ink no-underline hover:text-ink hover:underline">{title}</Link>
                    <span className="mt-0.5 block truncate text-footnote text-muted">{p.account?.name ?? '—'} · {engagementKindLabel(p.kind)}</span>
                    <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
                      <span className="flex flex-wrap gap-1.5">
                        <TileChip>{deliveryPhaseLabel(p.phase)}</TileChip>
                        {late && <TileChip>Po termínu</TileChip>}
                      </span>
                      <span className="text-footnote font-semibold tabular-nums text-muted">{p.due_on ? `do ${formatDate(p.due_on)}` : 'bez termínu'}</span>
                    </div>
                  </TodayTile>
                )
              })}
            </div>
          )}
        </Card>

        <div className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-1">
          <Card title="Po termínu" badge={overdue.length ? <TodayCount n={overdue.length} tone="neg" /> : undefined}>
            {overdue.length === 0 ? (
              <EmptyState tone="calm" compact title="Nic není po termínu" />
            ) : (
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {overdue.map((p) => {
                  const body = (
                    <span className="min-w-0 flex-1">
                      <b className="block text-headline leading-tight">{p.account?.name ?? '—'}</b>
                      <span className="block text-footnote text-muted">{projectTitle(p)}</span>
                      <span className="mt-1.5 block text-callout text-neg">Termín {formatDate(p.due_on)} · {deliveryPhaseLabel(p.phase)}</span>
                    </span>
                  )
                  return (
                    <li key={p.id} className="rounded-tile border border-border">
                      {p.account ? (
                        <Link href={href(p)} className="flex min-h-[44px] items-start gap-3 rounded-tile p-3.5 text-ink no-underline transition-colors duration-fast hover:bg-[color:var(--c-soft)] hover:text-ink">
                          {body}
                          <span aria-hidden="true" className="mt-1 shrink-0 text-muted"><ArrowRightIcon size={15} /></span>
                        </Link>
                      ) : (
                        <div className="p-3.5">{body}</div>
                      )}
                    </li>
                  )
                })}
              </ul>
            )}
          </Card>
          <div className="min-w-0">{calendarCard}</div>
        </div>
      </div>

      <section aria-label="Dodávky v číslech" className={CARD}>
        <div className="grid grid-cols-1 sm:grid-cols-3">
          <div className="p-5">
            <div className="eyebrow">Rozběhnuté dodávky</div>
            <div className="big-num mt-2 text-[28px] text-ink">{active.length}</div>
          </div>
          <div className={`p-5 ${divider}`}>
            <div className="eyebrow">Po termínu</div>
            <div className={`big-num mt-2 text-[28px] ${overdue.length ? 'text-neg' : 'text-ink'}`}>{overdue.length}</div>
          </div>
          <div className={`p-5 ${divider}`}>
            <div className="eyebrow">Uzavřené</div>
            <div className="big-num mt-2 text-[28px] text-ink">{closed}</div>
          </div>
        </div>
      </section>

      {children}

      <Card title="Dodávky podle fáze" className="lg:max-w-md">
        {active.length ? <TodayStageRing slices={slices} centerLabel="dodávek" /> : <EmptyState compact title="Zatím žádná data">Prstenec se ukáže s první rozběhnutou dodávkou.</EmptyState>}
      </Card>
    </div>
  )
}
