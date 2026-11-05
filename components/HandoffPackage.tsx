'use client'
// Předávací balíček obchod → realizace (kap. 6, migrace 0054). Formulář pro
// pět položek, které žijí přímo na dodávce, a kontrolní seznam všech deseti
// (validateHandoff). „Předat do realizace" projde jen s úplným balíčkem —
// server to ověřuje znovu (completeHandoff), tlačítko je jen nápověda.
import { WorkNotice } from '@/components/WorkUi'
import { FeaturePending } from '@/components/ui/FeaturePending'
import { CARD, CARD_PAD } from '@/components/ui/Card'
import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import { FormField } from '@/components/FormField'
import { SubmitButton } from '@/components/SubmitButton'
import { buttonClass } from '@/components/ui/Button'
import { HandoffChecklistCard, type HandoffChecklistItem } from '@/components/HandoffChecklistCard'
import { completeHandoff, saveHandoff } from '@/domain/delivery/actions/milestones'
import type { HandoffRow } from '@/domain/delivery/queries/milestones'

export type { HandoffChecklistItem }
type ContactOption = { id: number; full_name: string }
type DealOption = { id: number; title: string; stageLabel: string }


function CompleteButton({ disabled }: { disabled: boolean }) {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={disabled || pending}
      aria-busy={pending}
      className={buttonClass('primary')}
    >
      {pending ? 'Předávám…' : 'Předat do realizace'}
    </button>
  )
}

export function HandoffPackage({
  accountId,
  engagementId,
  state,
  handoff,
  checklist,
  contacts,
  deals,
  dealId,
  handoffByName,
}: {
  accountId: number
  engagementId: number
  checklist: HandoffChecklistItem[]
  contacts: ContactOption[]
  deals: DealOption[]
  dealId: number | null
  handoffByName?: string | null
} & (
  | { state: 'missing_migration'; handoff?: undefined }
  | { state: 'error'; handoff?: undefined }
  | { state: 'ok'; handoff: HandoffRow }
)) {
  const [saveState, saveAction] = useActionState(saveHandoff.bind(null, accountId, engagementId), null)
  const [doneState, doneAction] = useActionState(completeHandoff.bind(null, accountId, engagementId), null)

  if (state === 'missing_migration') {
    return (
      <FeaturePending card variant="compact" migration="0054">
        Pak tu půjde vyplnit cíl, rozsah, sponzora, finanční rámec a rizika a předat dodávku do realizace.
      </FeaturePending>
    )
  }
  if (state === 'error') {
    return <WorkNotice title="Předávací balíček se nepodařilo načíst">Zkus to prosím později.</WorkNotice>
  }

  const complete = checklist.every((i) => i.ok)
  const risks = handoff.risks ?? []
  return (
    <div className="flex flex-col gap-4">
      <HandoffChecklistCard
        items={checklist}
        showHints
        completedLabel={
          handoff.handoff_completed_at
            ? `Předáno do realizace ${handoff.handoff_completed_at.slice(0, 10)}${handoffByName ? ` · ${handoffByName}` : ''}`
            : null
        }
        action={
          !handoff.handoff_completed_at && (
            <form action={doneAction} className="flex flex-wrap items-center gap-3 pt-1">
              <CompleteButton disabled={!complete} />
              {!complete && <span className="text-[13px] text-white/85">Předat jde, až bude balíček úplný.</span>}
              {doneState?.error && <p role="alert" className="text-sm m-0 rounded-lg bg-white px-3 py-1.5 text-neg">{doneState.error}</p>}
            </form>
          )
        }
      />

      <form action={saveAction} className={`${CARD} ${CARD_PAD} grid gap-3 md:grid-cols-2`}>
        <div className="md:col-span-2">
          <FormField label="Cíl" error={saveState?.fieldErrors?.goal}>
            <textarea name="goal" rows={2} maxLength={2000} defaultValue={handoff.goal ?? ''} className="w-full" />
          </FormField>
        </div>
        <div className="md:col-span-2">
          <FormField label="Rozsah" error={saveState?.fieldErrors?.scope} hint="Co je a co není součástí dodávky.">
            <textarea name="scope" rows={3} maxLength={4000} defaultValue={handoff.scope ?? ''} className="w-full" />
          </FormField>
        </div>
        <div className="md:col-span-2">
          <FormField label="Schválená nabídka (obchod)" error={saveState?.fieldErrors?.deal_id} hint="Obchod musí být ve fázi Vyhráno.">
            <select name="deal_id" defaultValue={dealId ?? ''} className="w-full">
              <option value="">—</option>
              {deals.map((d) => (
                <option key={d.id} value={d.id}>{d.title} ({d.stageLabel})</option>
              ))}
            </select>
          </FormField>
        </div>
        <FormField label="Klientský sponzor" error={saveState?.fieldErrors?.client_sponsor_contact_id}>
          <select
            name="client_sponsor_contact_id"
            defaultValue={handoff.client_sponsor_contact_id ?? ''}
            className="w-full"
          >
            <option value="">—</option>
            {contacts.map((c) => (
              <option key={c.id} value={c.id}>{c.full_name}</option>
            ))}
          </select>
        </FormField>
        <FormField label="Finanční rámec" error={saveState?.fieldErrors?.financial_frame} hint="Rozpočet, způsob fakturace.">
          <input name="financial_frame" maxLength={2000} defaultValue={handoff.financial_frame ?? ''} className="w-full" />
        </FormField>
        <div className="md:col-span-2">
          <FormField label="Nevyřešená rizika" error={saveState?.fieldErrors?.risks_text} hint="Jedno riziko na řádek.">
            <textarea name="risks_text" rows={3} defaultValue={risks.join('\n')} className="w-full" />
          </FormField>
          <label className="mt-2 inline-flex items-center gap-2 text-sm text-muted">
            <input type="checkbox" name="no_risks" defaultChecked={handoff.risks !== null && risks.length === 0} />
            Žádná nevyřešená rizika
          </label>
        </div>
        <div className="md:col-span-2 flex items-center gap-3">
          <SubmitButton>Uložit balíček</SubmitButton>
          {saveState?.success && <p role="status" className="text-sm text-muted">Uloženo.</p>}
          {saveState?.error && <p role="alert" className="text-neg text-sm">{saveState.error}</p>}
        </div>
      </form>
    </div>
  )
}
