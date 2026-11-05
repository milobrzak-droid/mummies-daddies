'use client'
import { useActionState, useEffect, useRef } from 'react'
import { FormField } from '@/components/FormField'
import { SubmitButton } from '@/components/SubmitButton'
import { AccountPicker } from '@/components/AccountPicker'
import type { ActionResult } from '@/lib/actionResult'

type Action = (prev: unknown, formData: FormData) => Promise<ActionResult>

// Mateřský/dceřiný vztah (kapitola 4, migrace 0033) — ptá se na směr vůči
// aktuální firmě, ne rovnou na parent/child; server action (addRelationship)
// si z toho dopočítá, která strana je parent_account_id a která child.
// Druhá firma se hledá (AccountPicker, bez aktuální firmy) — dřív detail
// klienta posílal do prohlížeče seznam všech firem.
export function CompanyRelationshipForm({ action, accountId }: { action: Action; accountId: number }) {
  const [state, formAction] = useActionState(action, null)
  const ref = useRef<HTMLFormElement>(null)
  useEffect(() => { if (state?.success) ref.current?.reset() }, [state])
  const fe = state?.fieldErrors ?? {}
  return (
    <form ref={ref} action={formAction} className="flex flex-wrap items-end gap-3">
      {state?.error && <p role="alert" className="text-neg text-sm basis-full m-0">{state.error}</p>}
      <FormField label="Vztah" error={fe.direction}>
        <select name="direction" defaultValue="parent_of">
          <option value="parent_of">Je mateřská pro</option>
          <option value="child_of">Je dceřiná od</option>
        </select>
      </FormField>
      <div className="min-w-[16rem] flex-1">
        <FormField label="Firma" error={fe.other_account_id}>
          <AccountPicker name="other_account_id" required excludeId={accountId} />
        </FormField>
      </div>
      <SubmitButton variant="soft">Přidat vztah</SubmitButton>
    </form>
  )
}
