'use client'
import { useActionState, useEffect, useRef } from 'react'
import { FormField } from '@/components/FormField'
import { SubmitButton } from '@/components/SubmitButton'
import { createTargetList } from '@/domain/crm/actions/targetLists'

export function TargetListForm() {
  const [state, formAction] = useActionState(createTargetList, null)
  const ref = useRef<HTMLFormElement>(null)
  useEffect(() => { if (state?.success) ref.current?.reset() }, [state])
  return (
    <form ref={ref} action={formAction} className="grid gap-3 rounded-card border border-border bg-surface p-5 shadow-card md:grid-cols-2">
      <FormField label="Název seznamu" error={state?.fieldErrors?.name}>
        <input name="name" required maxLength={200} className="w-full" />
      </FormField>
      <FormField label="Segment" error={state?.fieldErrors?.segment}>
        <input name="segment" required maxLength={200} placeholder="např. výrobní firmy 50–250 lidí" className="w-full" />
      </FormField>
      <FormField label="Proč oslovit" error={state?.fieldErrors?.rationale}>
        <textarea name="rationale" required maxLength={4000} rows={3} className="w-full" />
      </FormField>
      <FormField label="Hypotéza hodnoty" error={state?.fieldErrors?.value_hypothesis}>
        <textarea name="value_hypothesis" maxLength={4000} rows={3} className="w-full" />
      </FormField>
      <div className="md:col-span-2 flex items-center gap-3">
        <SubmitButton variant="coral">Založit seznam</SubmitButton>
        {state?.error && <p role="alert" className="m-0 text-callout text-neg">{state.error}</p>}
      </div>
    </form>
  )
}
