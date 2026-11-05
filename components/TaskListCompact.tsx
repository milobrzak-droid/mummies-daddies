import Link from 'next/link'
import { Avatar } from '@/components/Avatar'
import { CARD } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { WorkChk, WorkStatus, type WorkStatusTone } from '@/components/WorkUi'
import { formatDate } from '@/lib/format'
import type { Task, TaskPriority, TaskStatus } from '@/lib/types'

type Member = { id: string; full_name: string }

const PRIORITY_LABEL: Record<TaskPriority, string> = { high: 'Vysoká', normal: 'Normální', low: 'Nízká' }
const STATUS_LABEL: Record<TaskStatus, string> = {
  todo: 'K udělání', in_progress: 'Dělá se', blocked: 'Blokováno', done: 'Hotovo',
}
const STATUS_TONE: Record<TaskStatus, WorkStatusTone> = {
  todo: 'idle', in_progress: 'wait', blocked: 'fail', done: 'done',
}
// Barva proužku dlaždice = stav úkolu (ne důležitost), podle významu barev
// v docs/PROVOZ.md §4: bílá = zatím nic, modrá = probíhá,
// červená = blokováno, tyrkysová = hotovo.
const STATUS_TILE: Record<TaskStatus, string> = {
  todo: 'tile-pink', in_progress: 'tile-sky', blocked: 'tile-peach', done: 'tile-mint',
}

// Lokální YYYY-MM-DD (ne UTC) — due_on je datum bez času, takže porovnáváme
// kalendářní dny, aby úkol se „zítřejším" termínem večer nevypadal jako
// overdue kvůli časovému pásmu.
function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function TaskListCompact({
  tasks, doneCount, members, emptyText = 'Žádné otevřené úkoly.',
}: { tasks: Task[]; doneCount: number; members: Member[]; emptyText?: string }) {
  const t = today()

  function memberName(id: string | null): string | null {
    if (!id) return null
    return members.find((m) => m.id === id)?.full_name ?? null
  }

  return (
    <div className="space-y-3">
      {tasks.length === 0 ? (
        <div className={CARD}>
          <EmptyState compact tone="calm" title={emptyText.replace(/\.$/, '')}>Nový úkol přidáš formulářem Přidat úkol.</EmptyState>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {tasks.map((task) => {
            const overdue = !!task.due_on && task.due_on < t && task.status !== 'done'
            const assignee = memberName(task.assignee_id)
            return (
              <div key={task.id} className={`tile ${STATUS_TILE[task.status]} flex flex-col gap-2.5`}>
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="font-heading text-headline font-bold leading-tight">{task.title}</div>
                    {task.description && <div className="text-[13px] text-[color:#39414D] mt-1 line-clamp-2">{task.description}</div>}
                  </div>
                  <WorkChk done={task.status === 'done'} />
                </div>
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[12.5px] text-[color:#39414D]">
                  <WorkStatus tone={STATUS_TONE[task.status]}>{STATUS_LABEL[task.status]}</WorkStatus>
                  <span>Priorita: {PRIORITY_LABEL[task.priority]}</span>
                  {task.due_on && (
                    <span className={`font-semibold ${overdue ? 'text-neg' : ''}`}>
                      {overdue ? 'Po termínu · ' : 'Do '}{formatDate(task.due_on)}
                    </span>
                  )}
                  <span className="ml-auto inline-flex items-center gap-1.5">
                    {assignee ? (
                      <>
                        <Avatar name={assignee} size={22} />
                        <span>{assignee}</span>
                      </>
                    ) : (
                      <span>Nepřiřazeno</span>
                    )}
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      )}
      {doneCount > 0 && (
        <p className="m-0 text-footnote text-muted">
          A {doneCount} {doneCount === 1 ? 'hotový úkol' : doneCount < 5 ? 'hotové úkoly' : 'hotových úkolů'} na{' '}
          <Link href="/cockpit/tasks?view=team" className="underline underline-offset-2">tabuli úkolů</Link>.
        </p>
      )}
    </div>
  )
}
