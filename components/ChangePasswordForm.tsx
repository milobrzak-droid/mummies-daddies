'use client'
import { useActionState } from 'react'
import { FormField } from '@/components/FormField'
import { SubmitButton } from '@/components/SubmitButton'
import { updateMyPassword } from '@/lib/actions/security'

export function ChangePasswordForm() {
  const [state, formAction] = useActionState(updateMyPassword, null)
  return (
    <form action={formAction} className="space-y-3 max-w-md">
      <FormField label="Nové heslo">
        <input name="password" type="password" required minLength={8} autoComplete="new-password" />
      </FormField>
      <FormField label="Nové heslo znovu">
        <input name="confirm" type="password" required minLength={8} autoComplete="new-password" />
      </FormField>
      {state?.error && <p role="alert" className="text-neg text-sm">{state.error}</p>}
      {state?.success && <p role="status" className="text-pos text-sm">Heslo bylo změněno.</p>}
      <SubmitButton variant="coral">Uložit heslo</SubmitButton>
    </form>
  )
}
