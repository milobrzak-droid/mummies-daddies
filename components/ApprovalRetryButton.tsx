'use client'
// „Zkusit znovu" u provedení, které selhalo (migrace 0084). Server akce
// zavolá retry_approval_execution; opakování nic nezdvojí (jeden výsledek na
// žádost), smí žadatel, schvalovatel nebo vedení — hranici drží SQL.
import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import type { ActionResult } from '@/lib/actionResult'
import { buttonClass } from '@/components/ui/Button'

type Action = (prev: unknown, formData: FormData) => Promise<ActionResult>

function Submit({ label }: { label: string }) {
  const { pending } = useFormStatus()
  return (
    <button type="submit" disabled={pending} aria-busy={pending} aria-label={`Zkusit provést znovu — ${label}`} className={buttonClass('outline', 'sm')}>
      {pending ? 'Zkouším…' : 'Zkusit znovu'}
    </button>
  )
}

export function ApprovalRetryButton({ action, requestId, label }: { action: Action; requestId: number; label: string }) {
  const [state, formAction] = useActionState(action, null)
  if (state?.success) return <span role="status" className="text-footnote font-semibold text-pos">Provedeno.</span>
  return (
    <form action={formAction} className="flex flex-wrap items-center gap-2">
      <input type="hidden" name="request_id" value={requestId} />
      <Submit label={label} />
      {state?.error && <span role="alert" className="text-footnote text-neg">{state.error}</span>}
    </form>
  )
}
