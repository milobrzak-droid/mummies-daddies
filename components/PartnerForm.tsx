'use client'
import { useActionState } from 'react'
import { FormField } from '@/components/FormField'
import { SubmitButton } from '@/components/SubmitButton'
import type { ActionResult } from '@/lib/actionResult'
import type { Partner } from '@/lib/types'
import { PARTNER_ROLES } from '@/lib/domain'

type Action = (prev: unknown, formData: FormData) => Promise<ActionResult>

export function PartnerForm({ action, initial, partners = [] }:
  { action: Action; initial?: Partner; partners?: Partner[] }) {
  const [state, formAction] = useActionState(action, null)
  const fe = state?.fieldErrors ?? {}
  const roles = initial?.roles ?? []
  return (
    <form action={formAction} className="space-y-4">
      {state?.error && <p role="alert" className="text-neg text-sm rounded-btn bg-[color:var(--c-neg-soft)] px-4 py-3 m-0">{state.error}</p>}
      <FormField label="Název" error={fe.name}>
        <input name="name" defaultValue={initial?.name ?? ''} required />
      </FormField>
      <FormField label="Sektor (telekomunikace / poradenství / infrastruktura…)" error={fe.kind}>
        <input name="kind" defaultValue={initial?.kind ?? ''} />
      </FormField>
      <FormField label="Role (může jich mít víc)">
        <div className="flex flex-wrap gap-2 pt-1">
          {PARTNER_ROLES.map((r) => (
            <label key={r.key} className="inline-flex items-center gap-2 rounded-full border border-border bg-surface px-4 py-2 text-sm font-semibold text-ink min-h-[44px] md:min-h-0 cursor-pointer has-[:checked]:bg-[color:var(--c-navy)] has-[:checked]:border-[color:var(--c-navy)] has-[:checked]:text-white">
              <input type="checkbox" name="roles" value={r.key} defaultChecked={roles.includes(r.key)}
                     className="!w-[18px] !h-[18px] shrink-0 accent-[color:var(--c-accent)]" />
              {r.label}
            </label>
          ))}
        </div>
      </FormField>
      <FormField label="Přes koho (dodavatele získáváme přes distributora)" error={fe.via_partner_id}>
        <select name="via_partner_id" defaultValue={initial?.via_partner_id ?? ''}>
          <option value="">—</option>
          {partners.filter((p) => p.id !== initial?.id).map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </FormField>
      <div className="pt-1"><SubmitButton variant="coral">Uložit partnera</SubmitButton></div>
    </form>
  )
}
