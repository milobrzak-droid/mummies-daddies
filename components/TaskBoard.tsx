'use client'
import type { ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { formatDate } from '@/lib/format'
import { Avatar } from '@/components/Avatar'
import type { Task, TaskPriority, TaskStatus } from '@/lib/types'
import Link from 'next/link'
import { useUndoToast } from '@/components/ui/Toast'
import { TASK_QUICK_ANCHOR } from '@/components/TaskForm'
import type { ActionResult } from '@/lib/actionResult'

type Member = { id: string; full_name: string }

// Kanban úkolů: sloupec = stav (název + počet v kolečku), karta = štítek
// priority, název, kdo na tom dělá a termín. Stav se mění přímo na kartě:
// zaškrtnutím (hotovo) nebo segmentem (K udělání / Dělá se / Blokováno),
// nikdy tažením; termín polem s datem (u otevřeného úkolu). Každá změna jde
// vrátit tlačítkem Zpět v toastu.
const COLUMNS: { key: TaskStatus; label: string; dot: string }[] = [
  { key: 'todo', label: 'K udělání', dot: 'bg-[color:var(--d-neutral)]' },
  { key: 'in_progress', label: 'Dělá se', dot: 'bg-[color:var(--d-blue)]' },
  { key: 'blocked', label: 'Blokováno', dot: 'bg-[color:var(--d-red)]' },
  { key: 'done', label: 'Hotovo', dot: 'bg-[color:var(--d-turquoise)]' },
]

const PRIORITY_LABEL: Record<TaskPriority, string> = {
  high: 'Vysoká', normal: 'Normální', low: 'Nízká',
}
// Štítky priority z tónů značky (text --t-* na ploše --p-*, ≥ 4,5 : 1).
// Vysoká = pozor (žlutá), ne problém: červená patří až blokovanému úkolu.
const PRIORITY_TAG: Record<TaskPriority, string> = {
  high: 'bg-[color:var(--p-yellow)] text-[color:var(--t-yellow)]',
  normal: 'bg-[color:var(--p-blue)] text-[color:var(--t-blue)]',
  low: 'bg-[color:var(--c-soft)] text-ink-2',
}

function localToday(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function TaskBoard({
  tasks, members, updateStatus, updateDueOn, today: todayProp, quickAdd,
}: {
  tasks: Task[]
  /** Dnešní den (YYYY-MM-DD) ze serveru, ať se neliší server a prohlížeč. */
  today?: string
  members: Member[]
  updateStatus: (id: number, status: string) => Promise<void>
  /** Rychlá změna termínu na kartě (updateTaskDueOn); bez ní je termín jen text. */
  updateDueOn?: (id: number, dueOn: string | null) => Promise<ActionResult>
  /** Rychlé přidání úkolu: řádek nahoře v prvním sloupci (K udělání). */
  quickAdd?: ReactNode
}) {
  const router = useRouter()
  const toast = useUndoToast()
  const today = todayProp ?? localToday()

  function memberName(id: string | null): string | null {
    if (!id) return null
    return members.find((m) => m.id === id)?.full_name ?? null
  }

  // Změna stavu se provede hned; toast nabídne Zpět, které zavolá tutéž akci
  // s původním stavem (pravidla na serveru se nemění).
  async function handleStatusChange(task: Task, status: TaskStatus) {
    const previous = task.status
    if (previous === status) return
    try {
      await updateStatus(task.id, status)
    } catch {
      toast.show({ message: 'Stav úkolu se nepodařilo změnit. Zkus to znovu.' })
      router.refresh()
      return
    }
    router.refresh()
    const label = COLUMNS.find((c) => c.key === status)?.label ?? status
    const name = task.title.length > 40 ? `${task.title.slice(0, 39)}…` : task.title
    toast.show({
      message: `Úkol „${name}“ je teď ve stavu ${label}.`,
      undo: async () => {
        await updateStatus(task.id, previous)
        router.refresh()
      },
    })
  }

  // Změna termínu se provede hned; Zpět zavolá tutéž akci s původním termínem
  // (i prázdným). Vrací true, když se termín změnil (pole se jinak vrátí).
  async function handleDueChange(task: Task, dueOn: string | null): Promise<boolean> {
    if (!updateDueOn) return false
    const previous = task.due_on ?? null
    if (previous === dueOn) return true
    const result = await updateDueOn(task.id, dueOn).catch(() => ({ success: false, error: undefined } as ActionResult))
    if (!result.success) {
      toast.show({ message: result.error ?? 'Termín úkolu se nepodařilo změnit. Zkus to znovu.' })
      router.refresh()
      return false
    }
    router.refresh()
    const name = task.title.length > 40 ? `${task.title.slice(0, 39)}…` : task.title
    toast.show({
      message: dueOn ? `Termín úkolu „${name}“ je ${formatDate(dueOn)}.` : `Úkol „${name}“ je bez termínu.`,
      undo: async () => {
        const back = await updateDueOn(task.id, previous)
        if (!back.success) throw new Error(back.error ?? 'undo')
        router.refresh()
      },
    })
    return true
  }

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
      {COLUMNS.map((col, i) => {
        const colTasks = tasks.filter((t) => t.status === col.key)
        const headingId = `sloupec-${col.key}`
        return (
          <section key={col.key} aria-labelledby={headingId} className="flex min-w-0 flex-col gap-3 rounded-card bg-[color:var(--c-soft)] p-3">
            <div className="flex items-center gap-2 px-1 pt-0.5">
              <span className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${col.dot}`} aria-hidden />
              <h2 id={headingId} className="m-0 font-heading text-headline font-bold">
                {col.label}<span className="sr-only">, {colTasks.length}</span>
              </h2>
              <span aria-hidden="true" className="ml-auto rounded-full bg-surface px-2.5 py-px text-footnote font-bold tabular-nums text-muted">{colTasks.length}</span>
            </div>
            {i === 0 && quickAdd && (
              <div id={TASK_QUICK_ANCHOR} className="scroll-mt-6">{quickAdd}</div>
            )}
            {colTasks.length === 0 && (
              <p className="m-0 rounded-tile border border-dashed border-[color:var(--c-hatch-line)] px-3 py-7 text-center text-footnote text-muted">
                {col.key === 'done' ? 'Zatím nic hotového' : 'Žádné úkoly'}
              </p>
            )}
            {colTasks.map((task) => {
              const assignee = memberName(task.assignee_id)
              const overdue = !!task.due_on && task.due_on < today && task.status !== 'done'
              const done = task.status === 'done'
              return (
                <article
                  key={task.id}
                  aria-label={task.title}
                  className="flex flex-col gap-2.5 rounded-tile bg-surface p-3.5 shadow-[0_1px_2px_rgba(20,25,34,.06)] transition-shadow duration-fast hover:shadow-card-hover"
                >
                  <div className="flex items-start gap-2">
                    <div className="min-w-0 flex-1">
                      <span className={`rounded-xs px-2.5 py-0.5 text-[11.5px] font-bold ${PRIORITY_TAG[task.priority]}`}>{PRIORITY_LABEL[task.priority]}</span>
                      <div className={`mt-2 font-heading text-[15px] font-bold leading-tight ${done ? 'text-muted line-through decoration-1' : ''}`}>{task.title}</div>
                    </div>
                    <DoneToggle done={done} title={task.title} onToggle={() => handleStatusChange(task, done ? 'todo' : 'done')} />
                  </div>
                  {(task.account || task.deal) && (
                    <div className="text-footnote text-muted">
                      {task.account && <Link href={`/cockpit/clients/${task.account.id}`} className="underline underline-offset-2">{task.account.name}</Link>}
                      {task.deal && <span>{task.account ? ' · ' : ''}{task.deal.title}</span>}
                    </div>
                  )}
                  <div className="flex items-center gap-2 text-[12.5px] text-ink-2">
                    {assignee ? (
                      <>
                        <Avatar name={assignee} size={24} />
                        <span className="truncate">{assignee}</span>
                      </>
                    ) : (
                      <span className="text-muted">Nepřiřazeno</span>
                    )}
                    {updateDueOn && !done ? (
                      <DueField task={task} overdue={overdue} onChange={handleDueChange} />
                    ) : task.due_on && (
                      <span className={`ml-auto whitespace-nowrap font-semibold tabular-nums ${overdue ? 'text-neg' : ''}`}>
                        {overdue ? 'Po termínu · ' : ''}{formatDate(task.due_on)}
                      </span>
                    )}
                  </div>
                  {!done && (
                    <StatusSegment current={task.status} title={task.title} onChange={(s) => handleStatusChange(task, s)} />
                  )}
                </article>
              )
            })}
          </section>
        )
      })}
    </div>
  )
}

// Termín otevřeného úkolu jako pole s datem. Prázdné pole = bez termínu.
// Po neúspěchu se vrátí původní hodnota (uncontrolled pole se po obnovení
// stránky přemapuje přes `key`).
function DueField({ task, overdue, onChange }: { task: Task; overdue: boolean; onChange: (task: Task, dueOn: string | null) => Promise<boolean> }) {
  return (
    <label className="ml-auto flex items-center gap-1.5 whitespace-nowrap">
      {overdue && <span className="font-semibold text-neg">Po termínu</span>}
      <input
        key={task.due_on ?? ''}
        type="date"
        defaultValue={task.due_on ?? ''}
        aria-label={`Termín úkolu: ${task.title}`}
        onChange={async (e) => {
          const el = e.currentTarget
          const v = el.value
          // Rozepsané datum (Firefox/Safari) nemá hodnotu jako prázdné pole; mazání = prázdno i validní.
          if (v && !/^\d{4}-\d{2}-\d{2}$/.test(v)) return
          const ok = await onChange(task, v || null)
          if (!ok) el.value = task.due_on ?? ''
        }}
        className="!min-h-0 !w-auto !py-1 !text-[12.5px] font-semibold tabular-nums"
      />
    </label>
  )
}

// Dokončení zaškrtnutím: kulaté políčko vpravo nahoře (cíl 44 × 44 px).
// U hotového úkolu stejné políčko vrátí úkol mezi otevřené (K udělání).
function DoneToggle({ done, title, onToggle }: { done: boolean; title: string; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-pressed={done}
      aria-label={done ? `Vrátit mezi otevřené: ${title}` : `Označit jako hotové: ${title}`}
      title={done ? 'Vrátit mezi otevřené' : 'Označit jako hotové'}
      className="group/chk -mr-2 -mt-2 inline-grid h-11 w-11 shrink-0 place-items-center rounded-full"
    >
      <span className={`chk ${done ? 'done' : 'group-hover/chk:border-[color:var(--c-pos)] group-hover/chk:text-[color:var(--c-pos)]'}`} aria-hidden="true">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M20 6 9 17l-5-5" />
        </svg>
      </span>
    </button>
  )
}

// Stav otevřeného úkolu jako segment (K udělání / Dělá se / Blokováno);
// hotovo je zaškrtnutí nahoře. Funguje myší, klávesnicí i na dotyku.
const OPEN_STATES = COLUMNS.filter((c) => c.key !== 'done')

function StatusSegment({ current, title, onChange }: { current: TaskStatus; title: string; onChange: (s: TaskStatus) => void }) {
  return (
    <div role="group" aria-label={`Stav úkolu ${title}`} className="seg flex w-full flex-wrap gap-y-0.5">
      {OPEN_STATES.map((o) => (
        <button
          key={o.key}
          type="button"
          aria-pressed={current === o.key}
          onClick={() => onChange(o.key)}
          className="seg-item flex-auto justify-center whitespace-nowrap !px-2 !text-[12px] aria-pressed:bg-surface aria-pressed:text-ink aria-pressed:shadow-e1"
        >
          {o.label}
        </button>
      ))}
    </div>
  )
}
