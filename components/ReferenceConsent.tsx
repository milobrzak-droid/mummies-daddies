'use client'
// Souhlas klienta s referencí — jen doložený (kap. 6, 0061). Bez dokladu
// a data nejde kartu schválit (CHECK reference_card_consent_check).
import { useActionState } from 'react'
import { FormField } from '@/components/FormField'
import { SubmitButton } from '@/components/SubmitButton'
import { Chip } from '@/components/Chip'
import { recordReferenceConsent, withdrawReferenceConsent } from '@/domain/delivery/actions/impact'
import { referenceConsentOk } from '@/domain/delivery/impact'
import type { ReferenceCard } from '@/lib/types'

export function ReferenceConsent({
  accountId, engagementId, card, documents, today,
}: {
  accountId: number
  engagementId: number
  card: ReferenceCard
  documents: { id: number; title: string }[]
  today: string
}) {
  const [state, formAction] = useActionState(recordReferenceConsent.bind(null, accountId, engagementId, card.id), null)
  const [wState, withdrawAction] = useActionState(withdrawReferenceConsent.bind(null, accountId, engagementId, card.id), null)
  const fe = state?.fieldErrors ?? {}
  const title = card.headline ?? `Karta #${card.id}`

  if (card.approved_public) {
    return (
      <div className="bg-surface rounded-card shadow-card p-5 flex flex-wrap items-center gap-3">
        <span className="font-heading text-[16px] font-bold text-ink">{title}</span>
        {referenceConsentOk(card) ? (
          <Chip tone="pos">
            Souhlas doložen{card.consent_at ? ` ${new Date(card.consent_at).toLocaleDateString('cs-CZ')}` : ''}
          </Chip>
        ) : (
          <Chip tone="warn">Souhlas bez dokladu</Chip>
        )}
        <form action={withdrawAction}>
          <SubmitButton variant="soft">Stáhnout souhlas</SubmitButton>
        </form>
        {wState?.error && <p role="alert" className="text-neg text-sm">{wState.error}</p>}
      </div>
    )
  }

  const prefix = `consent-${card.id}`
  return (
    <form action={formAction} className="bg-surface rounded-card shadow-card p-5 grid gap-x-4 gap-y-4 md:grid-cols-2" aria-labelledby={`${prefix}-title`}>
      <p id={`${prefix}-title`} className="md:col-span-2 m-0 flex flex-wrap items-center gap-2">
        <span className="font-heading text-[16px] font-bold text-ink">{title}</span>
        <Chip tone="neutral">Bez souhlasu — nepoužívat</Chip>
      </p>
      <FormField label="Datum souhlasu" error={fe.consent_on}>
        <input name="consent_on" type="date" required max={today} defaultValue={today} className="w-full" />
      </FormField>
      <FormField label="Doklad souhlasu (dokument dodávky)" error={fe.document_id}>
        <select name="document_id" defaultValue="" className="w-full">
          <option value="">Nový odkaz níže</option>
          {documents.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}
        </select>
      </FormField>
      <FormField label="Název nového dokladu" error={fe.new_title}>
        <input name="new_title" maxLength={200} className="w-full" />
      </FormField>
      <FormField label="Odkaz na SharePoint" error={fe.new_url}>
        <input name="new_url" type="url" placeholder="https://mummiesdaddies.sharepoint.com/…" className="w-full" />
      </FormField>
      <div className="md:col-span-2 flex items-center gap-3">
        <SubmitButton variant="coral">Doložit souhlas a schválit</SubmitButton>
        {state?.error && <p role="alert" className="text-neg text-sm">{state.error}</p>}
      </div>
    </form>
  )
}
