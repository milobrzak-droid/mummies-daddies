'use client'
import { useActionState } from 'react'
import { FormField } from '@/components/FormField'
import { SubmitButton } from '@/components/SubmitButton'
import type { ActionResult } from '@/lib/actionResult'
import type { Partner } from '@/lib/types'
type Action = (prev: unknown, formData: FormData) => Promise<ActionResult>
const PROGRAMS = ['dodavatel_napoju','pronajem_vybaveni','eventova_agentura','svatebni_agentura','pronajimatel_prostor','doporuceni','logistika']
export function DealPartnerForm({ action, partners }: { action: Action; partners: Partner[] }) {
  const [state, formAction] = useActionState(action, null)
  const fe = state?.fieldErrors ?? {}
  return (
    <form action={formAction}>
      {state?.error && <p role="alert">{state.error}</p>}
      <FormField label="Partner" error={fe.partner_id}>
        <select name="partner_id" required><option value="">—</option>{partners.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}</select>
      </FormField>
      <FormField label="Program" error={fe.program}>
        <select name="program">{PROGRAMS.map((v) => <option key={v}>{v}</option>)}</select>
      </FormField>
      <FormField label="Podíl partnera na obchodu (%)" error={fe.attribution_pct}><input name="attribution_pct" type="number" step="0.01" /></FormField>
      <FormField label="Přinesl poptávku"><input name="is_sourcing" type="checkbox" /></FormField>
      <FormField label="Cíl NNPSA" error={fe.nnpsa_target}><input name="nnpsa_target" type="number" /></FormField>
      <SubmitButton variant="soft">Přidat partnera k obchodu</SubmitButton>
    </form>
  )
}
