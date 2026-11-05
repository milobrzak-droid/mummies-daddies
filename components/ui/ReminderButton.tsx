'use client'
import { useActionState } from 'react'
import type { ReminderResult } from '@/domain/delivery/actions/waiting'
import { buttonClass } from '@/components/ui/Button'

// „Připomenout klientovi": založí úkol s návrhem e-mailu. Nic se neodesílá.
// Výsledek se ukáže hned pod tlačítkem (jako u SyncTasksButton), ať člověk
// ví, že se něco stalo; stránka se po úspěchu překreslí a tlačítko nahradí
// věta „Připomínka je založená".
export function ReminderButton({ action }: { action: () => Promise<ReminderResult> }) {
  const [state, formAction, pending] = useActionState<ReminderResult | null>(async () => action(), null)
  return (
    <div className="flex flex-col items-start gap-1.5">
      <form action={formAction}>
        <button
          type="submit"
          disabled={pending}
          aria-busy={pending}
          className={buttonClass('secondary', 'sm')}
        >
          {pending ? 'Zakládám úkol…' : 'Připomenout klientovi'}
        </button>
      </form>
      {state?.error && <p role="alert" className="m-0 text-callout text-neg">{state.error}</p>}
      {state?.success && state.note && <p role="status" className="m-0 text-callout text-muted">{state.note}</p>}
    </div>
  )
}
