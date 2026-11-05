'use client'
import Link from 'next/link'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { useUndoToast } from '@/components/ui/Toast'

// Úkoly na dnes v kartě „Co dnes udělat": dokončení zaškrtnutím přímo
// v kartě (docs/PROVOZ.md §11). Provede se hned, toast nabídne Zpět,
// které zavolá tutéž serverovou akci s původním stavem. Bez akce (role nebo
// test) se místo zaškrtávátka ukáže jen odkaz na Úkoly.

export type TodayTaskRow = { id: number; title: string; sub: string; status: string }

const short = (t: string) => (t.length > 40 ? `${t.slice(0, 39)}…` : t)

function Check({ done }: { done: boolean }) {
  return (
    <span aria-hidden="true" className={`chk ${done ? 'done' : ''}`}>
      <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="m5 12 5 5 9-10" /></svg>
    </span>
  )
}

export function TodayTaskChecklist({
  tasks, complete,
}: {
  tasks: TodayTaskRow[]
  /** Serverová akce updateTaskStatus (id, stav). */
  complete?: (id: number, status: string) => Promise<void>
}) {
  const router = useRouter()
  const toast = useUndoToast()
  const [done, setDone] = useState<ReadonlySet<number>>(() => new Set())
  const [busy, setBusy] = useState<number | null>(null)

  const mark = (id: number, on: boolean) => setDone((prev) => {
    const next = new Set(prev)
    if (on) next.add(id)
    else next.delete(id)
    return next
  })

  async function finish(task: TodayTaskRow) {
    if (!complete || busy !== null || done.has(task.id)) return
    setBusy(task.id)
    mark(task.id, true)
    try {
      await complete(task.id, 'done')
    } catch {
      mark(task.id, false)
      toast.show({ message: 'Úkol se nepodařilo dokončit. Zkus to znovu.' })
      return
    } finally {
      setBusy(null)
    }
    router.refresh()
    toast.show({
      message: `Úkol „${short(task.title)}“ je hotový.`,
      undo: async () => {
        await complete(task.id, task.status === 'done' ? 'todo' : task.status)
        mark(task.id, false)
        router.refresh()
      },
    })
  }

  return (
    <ul className="m-0 flex list-none flex-col p-0" aria-label="Úkoly na dnes">
      {tasks.map((task) => {
        const isDone = done.has(task.id)
        return (
          <li key={task.id} className="flex min-h-[44px] items-center gap-2 border-b border-[color:var(--c-line-2)] py-1 last:border-b-0">
            {complete ? (
              <button
                type="button"
                role="checkbox"
                aria-checked={isDone}
                aria-label={`Hotovo: ${task.title}`}
                disabled={isDone || busy === task.id}
                onClick={() => finish(task)}
                className="-ml-2.5 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full disabled:cursor-default"
              >
                <Check done={isDone} />
              </button>
            ) : null}
            <span className="min-w-0 flex-1">
              <Link
                href="/cockpit/tasks"
                className={`block truncate text-headline leading-tight no-underline hover:underline ${isDone ? 'text-muted line-through' : 'text-ink hover:text-ink'}`}
              >
                {task.title}
              </Link>
              <span className="block truncate text-footnote text-muted">{task.sub}</span>
            </span>
          </li>
        )
      })}
    </ul>
  )
}
