'use client'
import { useActionState, useEffect, useRef } from 'react'
import { FormField } from '@/components/FormField'
import { SubmitButton } from '@/components/SubmitButton'
import type { ActionResult } from '@/lib/actionResult'

type Action = (prev: unknown, formData: FormData) => Promise<ActionResult>

// Alias domény/názvu (kapitola 4 plánu přestavby, migrace 0033) — firma
// vídaná pod jinou e-mailovou doménou (koupená značka, dceřinka s vlastní
// doménou), ať to na kartě klienta nevypadá jako nový, neznámý kontakt.
export function CompanyAliasForm({ action }: { action: Action }) {
  const [state, formAction] = useActionState(action, null)
  const ref = useRef<HTMLFormElement>(null)
  useEffect(() => { if (state?.success) ref.current?.reset() }, [state])
  const fe = state?.fieldErrors ?? {}
  return (
    <form ref={ref} action={formAction} className="flex flex-wrap items-end gap-x-3 gap-y-3">
      {state?.error && <p role="alert" className="text-neg text-sm basis-full m-0">{state.error}</p>}
      <FormField label="Doména" error={fe.alias_domain}>
        <input name="alias_domain" placeholder="acquired-brand.cz" className="w-44" />
      </FormField>
      <FormField label="Název">
        <input name="alias_name" placeholder="Dřívější název" className="w-44" />
      </FormField>
      <SubmitButton variant="soft">Přidat alias</SubmitButton>
    </form>
  )
}
