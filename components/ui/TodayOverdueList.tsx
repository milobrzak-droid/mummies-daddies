'use client'
import Link from 'next/link'
import { useState, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import type { ActionResult } from '@/lib/actionResult'
import { useUndoToast } from '@/components/ui/Toast'
import { buttonClass } from '@/components/ui/Button'

// Řádky karty „Po termínu" s úpravou na místě (docs/PROVOZ.md §11):
// další krok obchodu i termín úkolu jdou posunout na zítra nebo na příští
// týden, úkol jde navíc odškrtnout jako hotový. Provede se hned a toast nabídne Zpět, které zavolá
// tutéž serverovou akci s předchozí hodnotou (pravidla na serveru se nemění).
// Bez akcí (role, test) jsou řádky jen odkazem.

export type OverdueRow = {
  key: string
  href: string
  title: string
  sub: string
  late: string
  severe: boolean
  kind: 'deal' | 'task'
  /** Obchod: id, text dalšího kroku a původní termín (posun je jen s vyplněným krokem). */
  dealId?: number
  nextStep?: string | null
  due?: string | null
  /** Úkol: id, stav před dokončením a původní termín (`due`) pro Zpět. */
  taskId?: number
  taskStatus?: string
}

export type PostponeAction = (dealId: number, nextStep: string, dueOn: string) => Promise<ActionResult>
export type PostponeTaskAction = (taskId: number, dueOn: string | null) => Promise<ActionResult>
export type CompleteTaskAction = (id: number, status: string) => Promise<void>

const shortDay = (d: string) => `${+d.slice(8, 10)}. ${+d.slice(5, 7)}.`
const short = (t: string) => (t.length > 40 ? `${t.slice(0, 39)}…` : t)

const ICON_PROPS = { 'aria-hidden': true, focusable: false, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' } as const
const ClockIcon = () => <svg {...ICON_PROPS} width={18} height={18}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
const StepIcon = () => <svg {...ICON_PROPS} width={18} height={18}><path d="M5 12h14M13 6l6 6-6 6" /></svg>

export function TodayOverdueList({
  items, targets, postpone, postponeTask, completeTask,
}: {
  items: OverdueRow[]
  /** Cílové dny posunu (postponeTargets ze serveru, ať se neliší od pražského dneška). */
  targets?: { tomorrow: string; nextWeek: string }
  postpone?: PostponeAction
  /** Posun termínu úkolu (updateTaskDueOn); Zpět vrací původní termín. */
  postponeTask?: PostponeTaskAction
  completeTask?: CompleteTaskAction
}) {
  const router = useRouter()
  const toast = useUndoToast()
  // Vyřešené řádky (posunuté / hotové) do překreslení stránky ukážou výsledek.
  const [resolved, setResolved] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState<string | null>(null)

  const settle = (key: string, note: string | null) => setResolved((prev) => {
    const next = { ...prev }
    if (note) next[key] = note
    else delete next[key]
    return next
  })

  async function move(item: OverdueRow, to: string) {
    if (busy) return
    // Jeden tvar pro obchod i úkol: `apply(day)` provede posun, Zpět zavolá
    // tutéž akci s původní hodnotou (u obchodu i s původním textem kroku).
    let apply: ((day: string | null) => Promise<ActionResult>) | null = null
    let previous: string | null = null
    let what = ''
    if (item.kind === 'deal') {
      if (!postpone || item.dealId == null || !item.nextStep || !item.due) return
      const { dealId, nextStep } = item
      apply = (day) => postpone(dealId, nextStep, day ?? '')
      previous = item.due
      what = 'Termín'
    } else {
      if (!postponeTask || item.taskId == null) return
      const { taskId } = item
      apply = (day) => postponeTask(taskId, day)
      previous = item.due ?? null
      what = 'Termín úkolu'
    }
    setBusy(item.key)
    const result = await apply(to).catch(() => ({ success: false, error: undefined } as ActionResult))
    setBusy(null)
    if (!result.success) {
      toast.show({ message: result.error ?? 'Termín se nepodařilo posunout. Zkus to znovu.' })
      return
    }
    settle(item.key, `Posunuto na ${shortDay(to)}`)
    router.refresh()
    toast.show({
      message: `${what} „${short(item.title)}“ je posunutý na ${shortDay(to)}.`,
      undo: async () => {
        const back = await apply(previous)
        if (!back.success) throw new Error(back.error ?? 'undo')
        settle(item.key, null)
        router.refresh()
      },
    })
  }

  async function finish(item: OverdueRow) {
    if (!completeTask || item.taskId == null || busy) return
    const { taskId } = item
    const previous = item.taskStatus && item.taskStatus !== 'done' ? item.taskStatus : 'todo'
    setBusy(item.key)
    try {
      await completeTask(taskId, 'done')
    } catch {
      toast.show({ message: 'Úkol se nepodařilo dokončit. Zkus to znovu.' })
      return
    } finally {
      setBusy(null)
    }
    settle(item.key, 'Hotovo')
    router.refresh()
    toast.show({
      message: `Úkol „${short(item.title)}“ je hotový.`,
      undo: async () => {
        await completeTask(taskId, previous)
        settle(item.key, null)
        router.refresh()
      },
    })
  }

  return (
    <ul className="m-0 list-none p-0">
      {items.map((o) => {
        const done = resolved[o.key]
        const canMoveDeal = !!postpone && o.kind === 'deal' && o.dealId != null && !!o.nextStep?.trim() && !!o.due
        const canMoveTask = !!postponeTask && o.kind === 'task' && o.taskId != null
        const canMove = !!targets && (canMoveDeal || canMoveTask)
        const canFinish = !!completeTask && o.kind === 'task' && o.taskId != null
        const pending = busy === o.key
        let actions: ReactNode = null
        if (done) {
          actions = <span className="text-footnote font-semibold text-pos">{done}</span>
        } else if (canMove || canFinish) {
          actions = (
            <>
              {canMove && targets && (
                <>
                  <span className="text-footnote text-muted">Posunout</span>
                  <button type="button" disabled={pending} onClick={() => move(o, targets.tomorrow)} aria-label={`Zítra: posunout „${o.title}“ na ${shortDay(targets.tomorrow)}`} className={buttonClass('outline', 'sm')}>
                    Zítra
                  </button>
                  <button type="button" disabled={pending} onClick={() => move(o, targets.nextWeek)} aria-label={`Příští týden: posunout „${o.title}“ na ${shortDay(targets.nextWeek)}`} className={buttonClass('outline', 'sm')}>
                    Příští týden
                  </button>
                </>
              )}
              {canFinish && (
                <button type="button" disabled={pending} onClick={() => finish(o)} aria-label={`Hotovo: ${o.title}`} className={buttonClass('outline', 'sm')}>
                  Hotovo
                </button>
              )}
            </>
          )
        }
        return (
          <li key={o.key} className="border-b border-[color:var(--c-line-2)] py-2 last:border-b-0">
            <Link href={o.href} className="flex min-h-[44px] items-center gap-3 text-ink no-underline hover:text-ink">
              <span aria-hidden="true" className={`grid h-[34px] w-[34px] shrink-0 place-items-center rounded-btn text-ink ${o.severe ? 'bg-[color:var(--p-pink)]' : 'bg-[color:var(--p-sun)]'}`}>
                {o.kind === 'task' ? <ClockIcon /> : <StepIcon />}
              </span>
              <span className="min-w-0 flex-1">
                <b className={`block truncate text-[14px] leading-tight ${done ? 'text-muted line-through' : ''}`}>{o.title}</b>
                <span className="block truncate text-footnote text-muted">{o.sub}</span>
              </span>
              <span className={`whitespace-nowrap text-footnote font-bold ${o.severe ? 'text-neg' : 'text-warn'}`}>{o.late}</span>
            </Link>
            {actions && <div className="flex flex-wrap items-center gap-2 pb-1 pl-[46px]">{actions}</div>}
          </li>
        )
      })}
    </ul>
  )
}
