'use client'

import { useRouter } from 'next/navigation'
import { type FormEvent, useEffect, useRef, useState } from 'react'
import { DealsIcon } from '@/components/DealsVisuals'
import { buttonClass } from '@/components/ui/Button'
import { useUndoToast } from '@/components/ui/Toast'
import type { ActionResult } from '@/lib/actionResult'

// Další krok na detailu obchodu (plán vlny 2): hlavní akce „Domluvit další
// krok“ otevře úpravu přímo tady, bez přechodu na /edit. Uložení volá stejnou
// serverovou akci jako tabule (updateDealNextStep); když předtím nějaký krok
// byl, toast nabídne Zpět s předchozí hodnotou.

export const PLAN_NEXT_STEP_EVENT = 'deals:plan-next-step'
export const NEXT_STEP_ANCHOR = 'dalsi-krok'

const tomorrow = () => {
  const date = new Date()
  date.setDate(date.getDate() + 1)
  const offset = date.getTimezoneOffset()
  return new Date(date.getTime() - offset * 60_000).toISOString().slice(0, 10)
}

/** Hlavní akce v hlavičce: otevře úpravu dalšího kroku na stránce. */
export function DealsNextStepButton() {
  return (
    <a
      href={`#${NEXT_STEP_ANCHOR}`}
      className={buttonClass('primary')}
      onClick={(event) => {
        event.preventDefault()
        window.dispatchEvent(new Event(PLAN_NEXT_STEP_EVENT))
        document.getElementById(NEXT_STEP_ANCHOR)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }}
    >
      Domluvit další krok
    </a>
  )
}

export function DealsNextStep({
  dealId, nextStep, nextStepDue, dueLabel, followUp, notes, overdue, missing, canEdit = true, updateNextStep,
}: {
  dealId: number
  nextStep: string | null
  nextStepDue: string | null
  /** Termín naformátovaný na serveru (pražský den). */
  dueLabel: string
  /** Stav termínu (V termínu, Po termínu 3 d…) – slovem, barva jen pomáhá. */
  followUp: { label: string; tone: 'pos' | 'warn' | 'neg' | 'neutral' }
  /** Připomenuto / eskalováno – doplňková metadata pod termínem. */
  notes?: string
  overdue: boolean
  missing: boolean
  /** Upravit smí jen obchodní role (serverová akce má stejnou bránu). */
  canEdit?: boolean
  updateNextStep: (dealId: number, nextStep: string, dueOn: string) => Promise<ActionResult>
}) {
  const router = useRouter()
  const toast = useUndoToast()
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!canEdit) return
    const open = () => setEditing(true)
    window.addEventListener(PLAN_NEXT_STEP_EVENT, open)
    if (window.location.hash === `#${NEXT_STEP_ANCHOR}`) open()
    return () => window.removeEventListener(PLAN_NEXT_STEP_EVENT, open)
  }, [canEdit])
  useEffect(() => { if (editing) inputRef.current?.focus() }, [editing])

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (saving) return
    const data = new FormData(event.currentTarget)
    const step = String(data.get('next_step') ?? '').trim()
    const due = String(data.get('next_step_due') ?? '')
    setSaving(true)
    setError('')
    const result = await updateNextStep(dealId, step, due)
    setSaving(false)
    if (!result.success) {
      setError(result.error ?? 'Další krok se nepodařilo uložit. Zkus to znovu.')
      return
    }
    setEditing(false)
    router.refresh()
    const previous = nextStep?.trim() && nextStepDue ? { step: nextStep, due: nextStepDue } : null
    toast.show({
      message: 'Další krok je uložený.',
      undo: previous
        ? async () => {
          const back = await updateNextStep(dealId, previous.step, previous.due)
          if (!back.success) throw new Error(back.error ?? 'undo failed')
          router.refresh()
        }
        : undefined,
    })
  }

  const tone = {
    pos: 'bg-[color:var(--c-pos-soft)] text-pos',
    warn: 'bg-[color:var(--c-warn-soft)] text-[color:var(--c-warn)]',
    neg: 'bg-[color:var(--c-neg-soft)] text-neg',
    neutral: 'bg-[color:var(--c-soft)] text-muted',
  }[followUp.tone]

  return (
    <section
      id={NEXT_STEP_ANCHOR}
      aria-labelledby="dalsi-krok-h"
      className={`mb-6 scroll-mt-24 rounded-card border p-5 shadow-card sm:p-6 ${missing && !editing ? 'border-dashed border-[color:var(--c-accent)] bg-[color:var(--c-accent-soft)]' : 'border-border bg-surface'}`}
    >
      <div className="flex flex-wrap items-start gap-4">
        <span aria-hidden="true" className={`grid h-11 w-11 shrink-0 place-items-center rounded-full ${missing ? 'bg-surface text-[color:var(--c-accent-text)]' : 'bg-[color:var(--c-info-soft)] text-ink'}`}>
          <DealsIcon name="calendar" size={20} />
        </span>
        <div className="min-w-0 grow basis-64">
          <h2 id="dalsi-krok-h" className={`eyebrow m-0 ${missing ? '!text-[color:var(--c-accent-text)]' : ''}`}>Další krok</h2>
          {editing ? (
            <form onSubmit={(event) => void save(event)} className="mt-2 grid gap-2 sm:grid-cols-[minmax(0,1fr)_180px_auto_auto] sm:items-center">
              <input ref={inputRef} name="next_step" defaultValue={nextStep ?? ''} placeholder="Co se má stát? Např. Poslat nabídku v2" aria-label="Další krok" required maxLength={500} />
              <input name="next_step_due" type="date" defaultValue={nextStepDue ?? tomorrow()} aria-label="Termín dalšího kroku" required />
              <button type="submit" disabled={saving} aria-busy={saving} className={buttonClass('secondary')}>{saving ? 'Ukládám…' : 'Uložit krok'}</button>
              <button type="button" onClick={() => { setEditing(false); setError('') }} className={buttonClass('quiet')}>Zrušit</button>
              {error && <p role="alert" className="m-0 text-callout text-neg sm:col-span-4">{error}</p>}
            </form>
          ) : missing ? (
            <>
              <p className="m-0 mt-1 font-heading text-title2 font-bold">Domluv konkrétní další krok a termín</p>
              <p className="m-0 mt-1 text-callout text-muted">Obchod bez dalšího kroku se snadno ztratí. Stačí jedna věta a den.</p>
            </>
          ) : nextStep ? (
            <>
              <p className="m-0 mt-1 font-heading text-title2 font-bold">{nextStep}</p>
              <p className={`m-0 mt-1 text-callout ${overdue ? 'text-neg' : 'text-muted'}`}>
                Termín: {dueLabel}{notes ? ` · ${notes}` : ''}
              </p>
            </>
          ) : (
            <p className="m-0 mt-1 text-callout text-muted">Zatím bez dalšího kroku.</p>
          )}
        </div>
        {!editing && nextStep && !missing && (
          <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-footnote font-semibold ${tone}`}>{followUp.label}</span>
        )}
        {!editing && canEdit && (
          <button type="button" onClick={() => setEditing(true)} className={buttonClass('outline', 'sm')}>
            {nextStep ? 'Upravit krok' : 'Doplnit krok'}
          </button>
        )}
      </div>
    </section>
  )
}
