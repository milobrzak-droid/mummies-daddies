'use client'
import { useActionState, useEffect, useRef, useState } from 'react'
import { FormField } from '@/components/FormField'
import { SubmitButton } from '@/components/SubmitButton'
import { AccountPicker, type AccountOption } from '@/components/AccountPicker'
import { addTargetListItem } from '@/domain/crm/actions/targetLists'
import { findContactOptionsForAccount } from '@/domain/crm/actions/accountPicker'

type Props = { listId: number }

// Firma se hledá (AccountPicker) a kontakty se dotáhnou až pro zvolenou
// firmu — dřív stránka posílala všechny firmy i všechny kontakty.
export function TargetListItemForm({ listId }: Props) {
  const [state, formAction] = useActionState(addTargetListItem, null)
  const ref = useRef<HTMLFormElement>(null)
  const [accountId, setAccountId] = useState('')
  const [accountContacts, setAccountContacts] = useState<{ id: number; full_name: string }[]>([])
  const contactRequest = useRef(0)
  useEffect(() => { if (state?.success) ref.current?.reset() }, [state])

  function onPickAccount(option: AccountOption | null) {
    setAccountId(option ? String(option.id) : '')
    const mine = ++contactRequest.current
    setAccountContacts([])
    if (!option) return
    findContactOptionsForAccount(option.id)
      .then((res) => {
        if (mine === contactRequest.current) setAccountContacts(res.ok ? res.options : [])
      })
      .catch(() => { /* bez kontaktu jde firma přidat i tak */ })
  }

  return (
    <form ref={ref} action={formAction} className="grid gap-3 rounded-card border border-border bg-surface p-5 shadow-card md:grid-cols-2">
      <input type="hidden" name="list_id" value={listId} />
      <FormField label="Firma" error={state?.fieldErrors?.account_id}>
        <AccountPicker name="account_id" required onChange={onPickAccount} />
      </FormField>
      <FormField label="Koho oslovit" error={state?.fieldErrors?.contact_id}>
        <select name="contact_id" className="w-full" disabled={!accountId}>
          <option value="">— zatím nevíme —</option>
          {accountContacts.map((c) => <option key={c.id} value={c.id}>{c.full_name}</option>)}
        </select>
      </FormField>
      <div className="md:col-span-2">
        <FormField label="Důvod (proč právě tahle firma)" error={state?.fieldErrors?.reason}>
          <textarea name="reason" required maxLength={2000} rows={2} className="w-full" />
        </FormField>
      </div>
      <FormField label="Další krok" error={state?.fieldErrors?.next_step}>
        <input name="next_step" maxLength={500} className="w-full" />
      </FormField>
      <FormField label="Termín dalšího kroku" error={state?.fieldErrors?.next_step_due}>
        <input type="date" name="next_step_due" className="w-full" />
      </FormField>
      <div className="md:col-span-2 flex items-center gap-3">
        <SubmitButton variant="coral">Přidat firmu</SubmitButton>
        {state?.error && <p role="alert" className="m-0 text-callout text-neg">{state.error}</p>}
      </div>
    </form>
  )
}
