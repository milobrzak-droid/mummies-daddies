'use client'
import { useActionState, useEffect, useRef } from 'react'
import { FormField } from '@/components/FormField'
import { SubmitButton } from '@/components/SubmitButton'
import type { ActionResult } from '@/lib/actionResult'

type Action = (prev: unknown, formData: FormData) => Promise<ActionResult>
type Member = { id: string; full_name: string }

// Kompaktní varianta TaskForm pro stránku klienta / dealu — klient (a
// případně deal) je předvyplněný skrytým polem, takže formulář se ptá jen
// na to, co uživatel na místě skutečně chce zadat.
export function TaskQuickForm({
  action, members, accountId, dealId,
}: { action: Action; members: Member[]; accountId: number; dealId?: number }) {
  const [state, formAction] = useActionState(action, null)
  const ref = useRef<HTMLFormElement>(null)
  useEffect(() => { if (state?.success) ref.current?.reset() }, [state])
  const fe = state?.fieldErrors ?? {}

  return (
    <form ref={ref} action={formAction} className="space-y-3 bg-surface shadow-card rounded-card p-5">
      {state?.error && <p role="alert" className="text-neg text-sm">{state.error}</p>}
      <input type="hidden" name="account_id" value={accountId} />
      {dealId && <input type="hidden" name="deal_id" value={dealId} />}
      <FormField label="Název" error={fe.title}>
        <input name="title" required />
      </FormField>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <FormField label="Termín" error={fe.due_on}>
          <input name="due_on" type="date" />
        </FormField>
        <FormField label="Priorita" error={fe.priority}>
          <select name="priority" defaultValue="normal">
            <option value="low">Nízká</option>
            <option value="normal">Normální</option>
            <option value="high">Vysoká</option>
          </select>
        </FormField>
        <FormField label="Zodpovědný" error={fe.assignee_id}>
          <select name="assignee_id" defaultValue="">
            <option value="">— nikdo —</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>{m.full_name}</option>
            ))}
          </select>
        </FormField>
      </div>
      <SubmitButton>Přidat úkol</SubmitButton>
    </form>
  )
}
