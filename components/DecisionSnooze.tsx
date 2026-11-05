'use client'
// Odložení žádosti „na později" — od migrace 0084 na serveru: uloží se na
// žádost (approval_request.snoozed_until), vidí ho všichni a odložit nebo
// vrátit smí jen ten, kdo o žádosti může rozhodnout (SQL snooze_approval to
// hlídá). Nic se tím nerozhoduje: žádost dál čeká, platnost běží a po
// uplynutí odložení se sama vrátí mezi čekající. Odložení je vratné, proto
// se provede hned a toast nabídne Zpět (tatáž akce s volbou „vratit").
import { useActionState, useRef, useState, useTransition } from 'react'
import { useFormStatus } from 'react-dom'
import { useRouter } from 'next/navigation'
import type { ActionResult } from '@/lib/actionResult'
import { buttonClass } from '@/components/ui/Button'
import { useUndoToast } from '@/components/ui/Toast'

type Action = (prev: unknown, formData: FormData) => Promise<ActionResult>
type Choice = 'zitra' | 'tyden' | 'vratit'

const fmt = (iso: string) => new Date(iso).toLocaleDateString('cs-CZ', { day: 'numeric', month: 'numeric' })

function snoozeForm(requestId: number, choice: Choice): FormData {
  const fd = new FormData()
  fd.set('request_id', String(requestId))
  fd.set('choice', choice)
  return fd
}

/** Nabídka „Odložit do…": do zítřka nebo na týden. Uloží se na server, toast nabídne Zpět. */
export function SnoozeMenu({ label, requestId, action }: { label: string; requestId: number; action: Action }) {
  const ref = useRef<HTMLDetailsElement>(null)
  const router = useRouter()
  const toast = useUndoToast()
  const [error, setError] = useState<string | null>(null)
  const [pending, startTransition] = useTransition()

  function snooze(choice: 'zitra' | 'tyden') {
    setError(null)
    startTransition(async () => {
      const res = await action(null, snoozeForm(requestId, choice))
      if (!res.success) {
        setError(res.error ?? 'Odložení se nepovedlo. Zkus to znovu.')
        return
      }
      ref.current?.removeAttribute('open')
      router.refresh()
      toast.show({
        message: `Odloženo ${choice === 'zitra' ? 'do zítřka' : 'na týden'}. Žádost dál čeká.`,
        undo: async () => {
          const back = await action(null, snoozeForm(requestId, 'vratit'))
          if (!back.success) throw new Error(back.error)
          router.refresh()
        },
      })
    })
  }

  const choice = (c: 'zitra' | 'tyden', text: string) => (
    <button
      type="button"
      disabled={pending}
      onClick={() => snooze(c)}
      className="min-h-[44px] rounded-btn px-3 text-left text-body hover:bg-[color:var(--c-soft)] disabled:opacity-60"
    >
      {text}
    </button>
  )

  return (
    <details ref={ref} className="relative">
      <summary aria-label={`Odložit — ${label}`} className={buttonClass('outline', 'md', 'cursor-pointer list-none [&::-webkit-details-marker]:hidden')}>
        {pending ? 'Odkládám…' : 'Odložit do…'}
      </summary>
      <div className="absolute left-0 z-10 mt-2 flex min-w-[13rem] flex-col gap-1 rounded-tile border border-border bg-surface p-2 shadow-e2">
        {choice('zitra', 'Do zítřka')}
        {choice('tyden', 'Na týden')}
        <p className="m-0 px-3 pb-1 text-footnote text-muted">Uvidí to všichni. Žádost dál čeká a platnost běží.</p>
        {error && <p role="alert" className="m-0 px-3 pb-1 text-footnote text-neg">{error}</p>}
      </div>
    </details>
  )
}

function ReturnButton({ label }: { label: string }) {
  const { pending } = useFormStatus()
  return (
    <button type="submit" disabled={pending} aria-busy={pending} aria-label={`Vrátit mezi čekající — ${label}`} className={buttonClass('outline', 'sm')}>
      {pending ? 'Vracím…' : 'Vrátit'}
    </button>
  )
}

/** Odložená žádost jako jeden klidný řádek; „Vrátit" jen pro toho, kdo smí rozhodnout. */
export function SnoozedRow({
  title,
  until,
  byName,
  requestId,
  action,
}: {
  title: string
  until: string
  byName: string | null
  requestId: number
  action: Action | null
}) {
  const [state, formAction] = useActionState<ActionResult | null, FormData>(
    action ?? (async () => ({ success: false })),
    null,
  )
  return (
    <div className="flex flex-wrap items-center gap-3 rounded-card border border-dashed border-border bg-surface/60 px-5 py-3 text-body">
      <span aria-hidden="true" className="grid h-8 w-8 flex-none place-items-center rounded-full bg-[color:var(--c-soft)] text-muted">
        <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></svg>
      </span>
      <span className="min-w-0 flex-1 text-muted">
        Odloženo do {fmt(until)}{byName ? ` (odložil(a) ${byName})` : ''}: <span className="font-semibold text-ink">{title}</span>
      </span>
      {action && (
        <form action={formAction} className="flex items-center gap-2">
          <input type="hidden" name="request_id" value={requestId} />
          <input type="hidden" name="choice" value="vratit" />
          <ReturnButton label={title} />
        </form>
      )}
      {state?.error && <p role="alert" className="m-0 w-full text-footnote text-neg">{state.error}</p>}
    </div>
  )
}
