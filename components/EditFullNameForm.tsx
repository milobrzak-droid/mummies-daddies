'use client'
import { useActionState } from 'react'
import { FormField } from '@/components/FormField'
import { SubmitButton } from '@/components/SubmitButton'
import type { ActionResult } from '@/lib/actionResult'

type Action = (prev: unknown, formData: FormData) => Promise<ActionResult>

// Inline editace zobrazovaného jména — používá ji admin na /tym (pro
// kohokoli jiného) i každý sám na /nastaveni (pro sebe). Akce se binduje
// na volajícím místě (buď na userId, nebo rovnou na "sebe").
export function EditFullNameForm({ action, initialFullName, variant = 'coral' }:
  { action: Action; initialFullName: string; variant?: 'coral' | 'soft' }) {
  const [state, formAction] = useActionState(action, null)
  return (
    <form action={formAction} className="flex flex-wrap items-end gap-2">
      <FormField label="Jméno" error={state?.fieldErrors?.full_name}>
        <input name="full_name" defaultValue={initialFullName} maxLength={100} required className="w-full sm:w-56" />
      </FormField>
      <SubmitButton variant={variant}>Uložit jméno</SubmitButton>
      {state?.error && <p role="alert" className="text-neg text-sm">{state.error}</p>}
      {state?.success && <p className="text-pos text-sm">Uloženo.</p>}
    </form>
  )
}
