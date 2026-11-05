'use client'
import { useActionState, useEffect, useRef } from 'react'
import { FormField } from '@/components/FormField'
import { SubmitButton } from '@/components/SubmitButton'
import type { ActionResult } from '@/lib/actionResult'
import type { Subscription } from '@/lib/types'

type Action = (prev: unknown, formData: FormData) => Promise<ActionResult>

// Kompaktní varianta pro stránku klienta — účet je předvyplněný skrytým
// polem, formulář se ptá jen na to, co je pro založení předplatného potřeba
// (stejný vzor jako TaskQuickForm).
export function SubscriptionForm({ action, accountId, initial, submitLabel }: {
  action: Action
  accountId: number
  initial?: Subscription
  submitLabel?: string
}) {
  const [state, formAction] = useActionState(action, null)
  const ref = useRef<HTMLFormElement>(null)
  // Při úpravě se formulář nevyprazdňuje — jinak by po uložení zmizely
  // hodnoty, které uživatel právě opravil.
  useEffect(() => { if (state?.success && !initial) ref.current?.reset() }, [state, initial])
  const fe = state?.fieldErrors ?? {}

  return (
    <form ref={ref} action={formAction} className="space-y-3 bg-surface border border-border rounded-card shadow-card p-5 sm:p-6">
      {state?.error && <p role="alert" className="text-neg text-sm">{state.error}</p>}
      <input type="hidden" name="account_id" value={accountId} />
      <FormField label="Produkt" error={fe.product}>
        <input name="product" required placeholder="Pravidelný catering do kanceláře" defaultValue={initial?.product ?? ''} />
      </FormField>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <FormField label="Licencí" error={fe.seats}>
          <input name="seats" type="number" min={0} defaultValue={initial?.seats ?? 1} />
        </FormField>
        <FormField label="Měsíční platba (Kč)" error={fe.mrr}>
          <input name="mrr" type="number" min={0} step="0.01" required defaultValue={initial?.mrr != null ? String(initial.mrr) : ''} />
        </FormField>
        <FormField label="Obnova" error={fe.renewal_date}>
          <input name="renewal_date" type="date" defaultValue={initial?.renewal_date ?? ''} />
        </FormField>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <FormField label="Začátek" error={fe.started_on}>
          <input name="started_on" type="date" defaultValue={initial?.started_on ?? ''} />
        </FormField>
        <FormField label="Riziko odchodu" error={fe.churn_risk}>
          <select name="churn_risk" defaultValue={initial?.churn_risk ?? 'low'}>
            <option value="low">Nízké</option>
            <option value="medium">Střední</option>
            <option value="high">Vysoké</option>
          </select>
        </FormField>
        <FormField label="Zdraví klienta (0–100)" error={fe.health_score}>
          <input name="health_score" type="number" min={0} max={100} defaultValue={initial?.health_score ?? ''} />
        </FormField>
      </div>
      <FormField label="MS dotace" hint="Např. „6 měsíců zdarma“ akce." error={fe.is_ms_subsidized}>
        <input name="is_ms_subsidized" type="checkbox" defaultChecked={initial?.is_ms_subsidized ?? false} />
      </FormField>
      {initial && (
        <FormField label="Ukončeno" hint="Prázdné = předplatné běží. Vyplněné datum ho vyřadí z běžících měsíčních plateb.">
          <input name="ended_on" type="date" defaultValue={initial.ended_on ?? ''} />
        </FormField>
      )}
      <SubmitButton variant="coral">{submitLabel ?? 'Přidat předplatné'}</SubmitButton>
    </form>
  )
}
