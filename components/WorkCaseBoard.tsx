import Link from 'next/link'
import { Avatar } from '@/components/Avatar'
import { WorkChk } from '@/components/WorkUi'
import { CARD } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { CASE_STATUSES, NODES } from '@/core/workCase'
import { CASE_STATUS_LABELS, caseStatusLabel, nodeLabel, statusesForFilter, type CaseStatusFilter } from '@/core/workCaseFlow'
import type { WorkCaseListItem } from '@/core/loopQueries'

// Nástěnka případů (kanban) a dlaždice oblastí. Jen prezentace nad stejnými
// daty jako seznam: sloupec = stav, karta = štítek oblasti, název, klient,
// vlastník, datum změny a postup kroků (hotové / všechny).

const fmt = (iso: string) => new Date(iso).toLocaleDateString('cs-CZ')

// Barva nese stav, ne pořadí (docs/PROVOZ.md §4): dlaždice oblasti je
// bílá a žlutý proužek dostane jen tehdy, když v ní něco čeká. Štítek oblasti
// na kartě je neutrální – oblast říká slovo, barva by tu nic nenesla.
const DOT: Record<string, string> = {
  open: 'bg-[color:var(--d-neutral)]', in_progress: 'bg-[color:var(--d-blue)]', waiting: 'bg-[color:var(--d-yellow)]',
  done: 'bg-[color:var(--d-turquoise)]', cancelled: 'bg-[color:var(--d-neutral)]',
}

// Počet sloupců podle počtu dlaždic („Všechny oblasti“ + oblasti firmy), ať
// poslední řada nezůstane poloprázdná. Třídy celé kvůli Tailwindu.
const TILE_COLS: Record<number, string> = {
  2: 'lg:grid-cols-2', 3: 'lg:grid-cols-3', 4: 'lg:grid-cols-4', 5: 'lg:grid-cols-5', 6: 'sm:grid-cols-3 xl:grid-cols-6',
}
export function nodeTileCols(tiles: number): string {
  return TILE_COLS[tiles] ?? 'sm:grid-cols-3 xl:grid-cols-6'
}

export function NodeTiles({
  cases, hrefFor, activeNode,
}: {
  cases: WorkCaseListItem[]
  hrefFor: (node: string | null) => string
  activeNode: string | null
}) {
  return (
    <nav aria-label="Oblast" className={`grid grid-cols-2 ${nodeTileCols(NODES.length + 1)} gap-3`}>
      <Link
        href={hrefFor(null)}
        aria-current={activeNode === null ? 'page' : undefined}
        className="tile bg-white no-underline flex flex-col justify-between aria-[current=page]:ring-2 aria-[current=page]:ring-[color:var(--c-navy)]"
      >
        <span className="eyebrow">Všechny oblasti</span>
        <span className="big-num text-[34px] mt-2">{cases.length}<small className="text-sm font-bold text-muted ml-1.5">případů</small></span>
      </Link>
      {NODES.map((n) => {
        const mine = cases.filter((c) => c.node === n)
        const waiting = mine.filter((c) => c.status === 'waiting').length
        return (
          <Link
            key={n}
            href={hrefFor(n)}
            aria-current={activeNode === n ? 'page' : undefined}
            className={`tile ${waiting > 0 ? 'tile-sun' : ''} no-underline flex flex-col justify-between aria-[current=page]:ring-2 aria-[current=page]:ring-[color:var(--c-navy)]`}
          >
            <span className="text-[13.5px] font-bold text-ink">{nodeLabel(n)}</span>
            <span className="big-num text-[34px] mt-2">{mine.length}<small className="text-sm font-bold text-ink-2 ml-1.5">případů</small></span>
            <span className="text-[12.5px] text-ink-2 mt-1">{waiting > 0 ? `${waiting} čeká` : 'nic nečeká'}</span>
          </Link>
        )
      })}
    </nav>
  )
}

export function WorkCaseBoard({
  cases, statusFilter, emptyAction = { href: '/cockpit/pripady/nova', label: 'Založit případ' },
}: {
  cases: WorkCaseListItem[]
  statusFilter: CaseStatusFilter
  /** Cesta dál z prázdného výběru (výchozí: založit případ). */
  emptyAction?: { href: string; label: string }
}) {
  const statuses = statusesForFilter(statusFilter) ?? CASE_STATUSES
  const columns = CASE_STATUSES.filter((s) => statuses.includes(s))
  if (cases.length === 0) {
    return (
      <div className={CARD}>
        <EmptyState title="Žádné případy pro tento výběr" action={emptyAction}>
          Změň oblast nebo stav nahoře, nebo založ nový případ.
        </EmptyState>
      </div>
    )
  }
  return (
    <div className={`grid grid-cols-1 gap-4 ${columns.length >= 4 ? 'md:grid-cols-2 xl:grid-cols-4' : columns.length === 3 ? 'md:grid-cols-3' : columns.length === 2 ? 'md:grid-cols-2' : ''}`}>
      {columns.map((s) => {
        const col = cases.filter((c) => c.status === s)
        return (
          <section key={s} aria-labelledby={`pripady-${s}`} className="flex min-w-0 flex-col gap-3 rounded-card bg-[color:var(--c-soft)] p-3">
            <div className="flex items-center gap-2 px-1 pt-0.5">
              <span className={`inline-block h-2.5 w-2.5 rounded-full ${DOT[s]}`} aria-hidden />
              <h2 id={`pripady-${s}`} className="m-0 font-heading text-headline font-bold">
                {CASE_STATUS_LABELS[s]}<span className="sr-only">, {col.length}</span>
              </h2>
              <span aria-hidden="true" className="ml-auto rounded-full bg-surface px-2.5 py-px text-footnote font-bold tabular-nums text-muted">{col.length}</span>
            </div>
            {col.length === 0 && (
              <p className="m-0 rounded-tile border border-dashed border-[color:var(--c-hatch-line)] px-3 py-7 text-center text-footnote text-muted">Žádné případy</p>
            )}
            {col.map((c) => {
              const pct = c.steps_total ? Math.round((c.steps_done / c.steps_total) * 100) : null
              return (
                <article key={c.id} className="flex flex-col gap-2.5 rounded-tile bg-surface p-3.5 shadow-[0_1px_2px_rgba(20,25,34,.06)] transition-shadow duration-fast hover:shadow-card-hover">
                  <div className="flex items-center justify-between gap-2">
                    <span className="rounded-xs bg-[color:var(--c-soft)] px-2.5 py-0.5 text-[11.5px] font-bold text-ink-2">{nodeLabel(c.node)}</span>
                    {c.status === 'done' && <WorkChk done />}
                  </div>
                  <Link href={`/cockpit/pripady/${c.id}`} className="font-heading text-[15px] font-bold leading-tight no-underline">{c.title}</Link>
                  {c.account_id && c.account_name && (
                    <Link href={`/cockpit/clients/${c.account_id}`} className="text-footnote text-muted underline underline-offset-2">{c.account_name}</Link>
                  )}
                  <div className="flex items-center gap-2 text-[12.5px] text-ink-2">
                    {c.lead_owner_name ? (
                      <>
                        <Avatar name={c.lead_owner_name} size={24} />
                        <span className="truncate">{c.lead_owner_name}</span>
                      </>
                    ) : (
                      <span className="text-muted">Bez vlastníka</span>
                    )}
                    <span className="ml-auto whitespace-nowrap font-semibold">{fmt(c.updated_at)}</span>
                  </div>
                  {pct !== null && (
                    <div>
                      <div className="flex justify-between text-[12px] font-semibold mb-1">
                        <span>Kroky {c.steps_done}/{c.steps_total}</span><span>{pct} %</span>
                      </div>
                      <div
                        className={`bar thin ${pct === 100 ? 'turquoise' : 'blue'}`}
                        role="img"
                        aria-label={`Hotovo ${c.steps_done} z ${c.steps_total} kroků`}
                      >
                        <i style={{ width: `${pct}%` }} />
                      </div>
                    </div>
                  )}
                  <span className="sr-only">{caseStatusLabel(c.status)}</span>
                </article>
              )
            })}
          </section>
        )
      })}
    </div>
  )
}
