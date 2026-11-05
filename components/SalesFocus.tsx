import Link from 'next/link'
import { formatCzk, formatDate, formatPersonName } from '@/lib/format'
import { dealStageLabel, defaultProbabilityForStage } from '@/lib/domain'
import { normalizeDealStage } from '@/lib/dealStageLegacy'
import { plural } from '@/domain/crm/today'
import type { SalesFocusItem } from '@/domain/crm/sales'
import type { Task } from '@/lib/types'
import { ArrowRightIcon, STAGE_TILE_COLOR, TileChip, TodayTile } from '@/components/ui/TodayParts'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { buttonClass } from '@/components/ui/Button'
import { TodayTaskChecklist } from '@/components/ui/TodayTaskChecklist'

const MAX_TILES = 4
const MAX_TASKS = 5

function initials(name: string): string {
  return (name.trim()[0] ?? '?').toUpperCase()
}

// „Co dnes udělat“: dlaždice obchodů, které potřebují krok (chybí další
// krok, blíží se uzavření, dlouho bez aktivity) a úkoly na dnešek, které jdou
// dokončit zaškrtnutím přímo tady (Zpět v toastu). Obchody po termínu mají
// vlastní kartu „Po termínu“. Řazení dodává buildSalesFocus (naléhavost, pak
// dopad); tady se jen vykresluje.
export function SalesFocus({
  items, tasksToday = [], completeTask,
}: {
  items: SalesFocusItem[]
  tasksToday?: Task[]
  /** Serverová akce updateTaskStatus; bez ní jsou úkoly jen odkazem. */
  completeTask?: (id: number, status: string) => Promise<void>
}) {
  const tiles = items.slice(0, MAX_TILES)
  const hiddenDeals = items.length - tiles.length
  const tasks = tasksToday.slice(0, MAX_TASKS)
  const hiddenTasks = tasksToday.length - tasks.length
  const total = items.length + tasksToday.length

  return (
    <Card
      title="Co dnes udělat"
      sub={total === 0 ? undefined : `${items.length} ${plural(items.length, 'obchod čeká', 'obchody čekají', 'obchodů čeká')} na krok${tasksToday.length ? ` · ${tasksToday.length} ${plural(tasksToday.length, 'úkol', 'úkoly', 'úkolů')} na dnes` : ''}`}
      href="/cockpit/pipeline"
      hrefLabel="Otevřít všechny obchody"
      className="h-full"
    >
      {total === 0 ? (
        <EmptyState tone="calm" compact title="Všechno důležité má další krok.">
          Každý otevřený obchod má krok a termín, nic není po termínu.
        </EmptyState>
      ) : (
        <div className="flex flex-col gap-4">
          {tiles.length > 0 && (
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {tiles.map((item) => {
                const { deal } = item
                const stage = normalizeDealStage(deal.stage) ?? ''
                const firm = deal.account?.name ?? deal.title
                const probability = deal.probability_pct ?? defaultProbabilityForStage(deal.stage)
                return (
                  <TodayTile key={deal.id} color={STAGE_TILE_COLOR[stage] ?? 'sun'} className="flex flex-col">
                    <div className="flex items-start gap-3">
                      <span aria-hidden="true" className="grid h-9 w-9 shrink-0 place-items-center rounded-btn bg-[color:var(--c-soft)] font-heading text-[15px] font-bold text-ink">{initials(firm)}</span>
                      <div className="min-w-0 flex-1">
                        <Link href={deal.account_id ? `/cockpit/clients/${deal.account_id}/deals/${deal.id}/edit` : '/cockpit/pipeline'} className="block truncate font-heading text-[16px] font-bold leading-tight tracking-tight text-ink no-underline hover:text-ink hover:underline">
                          {firm}
                        </Link>
                        <span className="mt-0.5 block truncate text-footnote text-muted">{deal.title}</span>
                      </div>
                    </div>
                    <div className="big-num mt-3 whitespace-nowrap text-[24px] text-ink">
                      {formatCzk(deal.amount_one_time)}
                    </div>
                    <p className="m-0 mt-1.5 text-callout font-semibold text-ink">{item.recommendation}</p>
                    <p className="m-0 mt-0.5 text-footnote text-muted">
                      {deal.next_step_due ? `Termín ${formatDate(deal.next_step_due)}` : null}
                      {deal.next_step_due && deal.owner ? ' · ' : null}
                      {deal.owner ? formatPersonName(deal.owner.full_name, deal.owner.email) : null}
                    </p>
                    <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-3">
                      <span className="flex flex-wrap gap-1.5">
                        <TileChip>{item.label}</TileChip>
                        <TileChip>{dealStageLabel(deal.stage)} · {probability} %</TileChip>
                      </span>
                      <Link href={`/cockpit/aktivity?account=${deal.account_id}&deal=${deal.id}`} className={buttonClass('quiet', 'sm', '-mr-2')}>
                        Vyřešit <ArrowRightIcon size={15} />
                      </Link>
                    </div>
                  </TodayTile>
                )
              })}
            </div>
          )}
          {hiddenDeals > 0 && (
            <Link href="/cockpit/pipeline" className="inline-flex min-h-[44px] items-center self-start text-callout font-semibold text-muted no-underline">
              … a dalších {hiddenDeals} v obchodech →
            </Link>
          )}
          {tasks.length > 0 && (
            <div>
              <h3 className="eyebrow m-0 mb-1">Úkoly na dnes</h3>
              <TodayTaskChecklist
                tasks={tasks.map((t) => ({ id: t.id, title: t.title, status: t.status, sub: t.account ? t.account.name : 'Úkol na dnes' }))}
                complete={completeTask}
              />
              {hiddenTasks > 0 && (
                <Link href="/cockpit/tasks" className="inline-flex min-h-[44px] items-center text-callout font-semibold text-muted no-underline">
                  … a dalších {hiddenTasks} v úkolech →
                </Link>
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  )
}
