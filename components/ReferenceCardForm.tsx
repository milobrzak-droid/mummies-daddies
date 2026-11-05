'use client'
import { useActionState } from 'react'
import { FormField } from '@/components/FormField'
import { SubmitButton } from '@/components/SubmitButton'
import type { ActionResult } from '@/lib/actionResult'
type Action = (prev: unknown, formData: FormData) => Promise<ActionResult>
export function ReferenceCardForm({ action }: { action: Action }) {
  const [state, formAction] = useActionState(action, null)
  const fe = state?.fieldErrors ?? {}
  return (
    <form action={formAction} className="space-y-4">
      {state?.error && <p role="alert" className="text-neg text-sm rounded-btn bg-[color:var(--c-neg-soft)] px-4 py-3 m-0">{state.error}</p>}
      <FormField label="Headline" error={fe.headline}><input name="headline" /></FormField>
      <FormField label="MS anchor" checkbox><input name="is_ms_anchor" type="checkbox" /></FormField>
      <p className="text-sm text-muted m-0">Souhlas klienta se doloží u karty po jejím založení.</p>
      <SubmitButton variant="coral">Vytvořit referenční kartu</SubmitButton>
    </form>
  )
}
