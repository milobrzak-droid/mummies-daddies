'use client'
import { useActionState } from 'react'
import { FormField } from '@/components/FormField'
import { SubmitButton } from '@/components/SubmitButton'
import type { ActionResult } from '@/lib/actionResult'

type Action = (prev: unknown, formData: FormData) => Promise<ActionResult>

export function MfaCodeForm({ action, submitLabel }: { action: Action; submitLabel: string }) {
  const [state, formAction] = useActionState(action, null)
  return (
    <form action={formAction} className="space-y-4">
      <FormField label="Kód z aplikace" error={state?.error}>
        <input
          name="code"
          type="text"
          inputMode="numeric"
          pattern="\d{6}"
          maxLength={6}
          autoComplete="one-time-code"
          required
          autoFocus
          className="!rounded-tile text-center font-mono text-[22px] tabular-nums tracking-[0.4em]"
        />
      </FormField>
      <SubmitButton variant="coral" pendingLabel="Ověřuji…">{submitLabel}</SubmitButton>
    </form>
  )
}
