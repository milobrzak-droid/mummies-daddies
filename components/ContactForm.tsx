'use client'
import { useActionState, useEffect, useRef } from 'react'
import { FormField } from '@/components/FormField'
import { SubmitButton } from '@/components/SubmitButton'
import type { ActionResult } from '@/lib/actionResult'
import type { Contact } from '@/lib/types'
import { DO_NOT_CONTACT_LABEL } from '@/domain/crm/outreachContacts'
import { DO_NOT_CONTACT_REASON_MAX } from '@/lib/domain'

type Action = (prev: unknown, formData: FormData) => Promise<ActionResult>
export function ContactForm({ action, initial, submitLabel, optOutInfo, onSaved, submitVariant = 'coral' }: {
  action: Action
  initial?: Contact
  submitLabel?: string
  /** Kdo a kdy nesouhlas zapsal (doplňuje databáze, 0087) — jen u úpravy. */
  optOutInfo?: string
  /** Po úspěšném uložení (např. zavřít panel úpravy na místě a ukázat toast). */
  onSaved?: () => void
  /** `default` (grafit), když je na obrazovce už jiná hlavní akce (koral jen jednou). */
  submitVariant?: 'coral' | 'default'
}) {
  const [state, formAction] = useActionState(action, null)
  const ref = useRef<HTMLFormElement>(null)
  // Po úpravě se formulář nevyprazdňuje — jinak by uživateli po uložení
  // zmizely hodnoty, které právě opravil.
  useEffect(() => { if (state?.success && !initial) ref.current?.reset() }, [state, initial])
  const savedRef = useRef(onSaved)
  useEffect(() => { savedRef.current = onSaved })
  useEffect(() => { if (state?.success) savedRef.current?.() }, [state])
  const fe = state?.fieldErrors ?? {}
  return (
    <form ref={ref} action={formAction} className="space-y-4">
      {state?.error && <p role="alert" className="text-neg text-sm rounded-btn bg-[color:var(--c-neg-soft)] px-4 py-3 m-0">{state.error}</p>}
      <FormField label="Jméno" error={fe.full_name}><input name="full_name" required defaultValue={initial?.full_name ?? ''} /></FormField>
      <FormField label="Role" error={fe.role}><input name="role" defaultValue={initial?.role ?? ''} /></FormField>
      <FormField label="E-mail" error={fe.email}><input name="email" type="email" defaultValue={initial?.email ?? ''} /></FormField>
      <FormField label="Telefon" error={fe.phone}><input name="phone" type="tel" defaultValue={initial?.phone ?? ''} /></FormField>
      <FormField label="Poznámka" error={fe.notes}><textarea name="notes" rows={2} defaultValue={initial?.notes ?? ''} /></FormField>
      <FormField label="Champion" checkbox><input name="is_champion" type="checkbox" defaultChecked={initial?.is_champion ?? false} /></FormField>
      {/* Nesouhlas s oslovením (0087): takový člověk se nenabízí k oslovení
          (fronta Oslovování, seznamy k oslovení, konektor v Cowork). Pole
          „Odkud / proč" je vidět jen se zaškrtnutím (CSS :has v globals.css, bez
          stavu — reset formuláře ho schová sám); nezaškrtnutý důvod server zahodí. */}
      <div className="optout-group space-y-4">
        <FormField label={DO_NOT_CONTACT_LABEL} checkbox error={fe.do_not_contact}>
          <input name="do_not_contact" type="checkbox" className="optout-toggle" defaultChecked={initial?.do_not_contact === true} />
        </FormField>
        <div className="optout-reason">
          <FormField
            label="Odkud / proč"
            error={fe.do_not_contact_reason}
            hint={optOutInfo ?? 'Krátce, např. „odpověděl na e-mail, ať mu nepíšeme“. Kdo a kdy nesouhlas zapsal, se uloží samo.'}
          >
            <input
              name="do_not_contact_reason"
              maxLength={DO_NOT_CONTACT_REASON_MAX}
              defaultValue={initial?.do_not_contact_reason ?? ''}
            />
          </FormField>
        </div>
      </div>
      <div className="pt-1"><SubmitButton variant={submitVariant}>{submitLabel ?? 'Přidat kontakt'}</SubmitButton></div>
    </form>
  )
}
