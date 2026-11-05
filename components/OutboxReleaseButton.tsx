'use client'
import { useActionState, useId } from 'react'
import { useFormStatus } from 'react-dom'
import { buttonClass } from '@/components/ui/Button'
import type { ActionResult } from '@/lib/actionResult'

// Tlačítko „Uvolnit" u zprávy odchozí fronty agenta (/cockpit/agent).
// Volá releaseOutboxMessage (P3, RPC agent_outbox_release): zpráva se vrátí
// do fronty a odešle ji až další běh úlohy agent-outbox — brány, stop
// pravidla a limity platí dál. U nejisté zprávy (needs_attention) musí
// člověk výslovně potvrdit, že v Odeslané poště není (jinak by mohla odejít
// dvakrát). Oprávnění (obchodní role, AAL2) hlídá SQL.

function Submit() {
  const { pending } = useFormStatus()
  return (
    <button type="submit" disabled={pending} aria-busy={pending} className={buttonClass('secondary', 'sm')}>
      {pending ? 'Uvolňuji…' : 'Uvolnit'}
    </button>
  )
}

export function OutboxReleaseButton({
  outboxId,
  status,
  action,
}: {
  outboxId: number
  status: string
  action: (prev: unknown, formData: FormData) => Promise<ActionResult>
}) {
  const [state, formAction] = useActionState<ActionResult | null, FormData>(action, null)
  const id = useId()
  const uncertain = status === 'needs_attention'
  if (state?.success) return <p role="status" className="m-0 text-footnote text-muted">Vráceno do fronty — odejde při dalším běhu.</p>
  return (
    <form action={formAction} className="flex flex-col items-start gap-1">
      <input type="hidden" name="outboxId" value={outboxId} />
      {uncertain && (
        <label htmlFor={`${id}-c`} className="flex items-center gap-1 text-footnote">
          <input id={`${id}-c`} type="checkbox" name="confirmNotSent" value="true" required />
          V Odeslané poště není
        </label>
      )}
      <Submit />
      {state && !state.success && <p role="alert" className="m-0 text-footnote text-neg">{state.error}</p>}
    </form>
  )
}
