'use client'
import { useActionState, useEffect, useRef } from 'react'
import { FormField } from '@/components/FormField'
import { SubmitButton } from '@/components/SubmitButton'
import { TEAM_ROLES } from '@/lib/domain'
import type { ActionResult } from '@/lib/actionResult'

type Action = (prev: unknown, formData: FormData) => Promise<ActionResult>

export function AddParticipantForm({ action }: { action: Action }) {
  const [state, formAction] = useActionState(action, null)
  const ref = useRef<HTMLFormElement>(null)
  useEffect(() => { if (state?.success) ref.current?.reset() }, [state])
  const fe = state?.fieldErrors ?? {}
  return (
    <form ref={ref} action={formAction} className="grid gap-4 sm:grid-cols-2">
      {state?.error && <p role="alert" className="m-0 text-callout text-neg sm:col-span-2">{state.error}</p>}
      <FormField label="E-mail" error={fe.email}>
        <input name="email" type="email" required />
      </FormField>
      <FormField label="Jméno" error={fe.full_name}>
        <input name="full_name" required />
      </FormField>
      <FormField label="Heslo" error={fe.password}>
        <input name="password" type="password" minLength={8} required />
      </FormField>
      <FormField label="Role" error={fe.role}>
        <select name="role" defaultValue="" required>
          <option value="" disabled>Vyber roli…</option>
          {TEAM_ROLES.map((r) => (
            <option key={r.key} value={r.key}>{r.label}</option>
          ))}
        </select>
      </FormField>
      <p className="m-0 text-footnote text-muted sm:col-span-2">
        Byznys a sales pipeline vidí Vedení a Obchodník. Projekťák, lektor a partner vidí jen Projekty.
      </p>
      <FormField label="Admin" error={fe.is_admin}>
        <input name="is_admin" type="checkbox" />
      </FormField>
      <div className="sm:col-span-2"><SubmitButton>Přidat účastníka</SubmitButton></div>
    </form>
  )
}
