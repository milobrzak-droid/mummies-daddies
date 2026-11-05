'use client'
import { useActionState, useState } from 'react'
import Link from 'next/link'
import { FormField } from '@/components/FormField'
import { formatPersonName } from '@/lib/format'
import { SubmitButton } from '@/components/SubmitButton'
import { DEAL_KINDS, dealStageLabel } from '@/lib/domain'
import { INVENTORY_REASON_LABELS } from '@/domain/crm/inventoryReasons'
import type { InventoryDeal } from '@/domain/crm/queries/inventory'
import type { ActionResult } from '@/lib/actionResult'

type Action = (dealId: number, accountId: number, prev: unknown, formData: FormData) => Promise<ActionResult>

// Jeden řádek /inventura: fakta o obchodu (klient, název, fáze, vlastník)
// + co chybí + inline formulář, který zapisuje JEN těch šest polí, co
// domain/crm/actions/inventory.ts dovolí (viz komentář tam). Akce zapíše jen
// pole, která tu jsou vykreslená — skrytá (rozhodování mimo fázi, deal_kind
// bez 0052) se nepřepíšou na null.
export function InventoryRow({ deal, action, columns0052Available }: {
  deal: InventoryDeal
  action: Action
  columns0052Available: boolean
}) {
  const boundAction = action.bind(null, deal.id, deal.account_id)
  const [state, formAction] = useActionState(boundAction, null)
  const [dealKind, setDealKind] = useState(deal.deal_kind ?? '')
  const [decisionMaker, setDecisionMaker] = useState(deal.decision_maker ?? '')
  const [decisionDue, setDecisionDue] = useState(deal.decision_due ?? '')
  const [nextStep, setNextStep] = useState(deal.next_step ?? '')
  const [nextStepDue, setNextStepDue] = useState(deal.next_step_due ?? '')
  const [noStepReason, setNoStepReason] = useState(deal.no_next_step_reason ?? '')
  // Po úspěšném uložení řádek ze seznamu zmizí (revalidatePath přenačte
  // stránku), ale krátce předtím ukážeme potvrzení místo formuláře.
  const justSaved = state?.success === true
  const fe = state?.fieldErrors ?? {}

  const showDecisionFields = columns0052Available && deal.stage === 'rozhodovani'

  return (
    <li className="bg-surface shadow-card rounded-card p-5 space-y-3 list-none">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <Link href={`/cockpit/clients/${deal.account_id}/deals/${deal.id}`} className="underline font-medium">
            {deal.account?.name ?? 'Bez klienta'} — {deal.title}
          </Link>
          <p className="text-xs text-muted mt-0.5">
            {dealStageLabel(deal.stage)} · {deal.owner ? formatPersonName(deal.owner.full_name, deal.owner.email) : 'bez vlastníka'}
          </p>
        </div>
        <ul className="flex flex-wrap gap-1.5 justify-end list-none p-0 m-0">
          {deal.reasons.map((r) => <li key={r} className="rounded-full bg-[color:var(--p-red)] px-2.5 py-0.5 text-xs font-semibold text-[color:var(--t-red)]">{INVENTORY_REASON_LABELS[r]}</li>)}
        </ul>
      </div>

      {justSaved ? (
        <p role="status" className="text-sm text-pos">Uloženo.</p>
      ) : (
        <form action={formAction} className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          {state?.error && <p role="alert" className="text-neg text-sm sm:col-span-3">{state.error}</p>}
          {columns0052Available && (
            <FormField label="Typ obchodu" error={fe.deal_kind}>
              <select name="deal_kind" value={dealKind} onChange={(e) => setDealKind(e.target.value)}>
                <option value="">— nevybráno —</option>
                {DEAL_KINDS.map((k) => <option key={k.key} value={k.key}>{k.label}</option>)}
              </select>
            </FormField>
          )}
          {showDecisionFields && (
            <>
              <FormField label="Kdo rozhoduje" error={fe.decision_maker}>
                <input
                  name="decision_maker" value={decisionMaker}
                  onChange={(e) => setDecisionMaker(e.target.value)} maxLength={200}
                />
              </FormField>
              <FormField label="Termín rozhodnutí" error={fe.decision_due}>
                <input
                  name="decision_due" type="date" value={decisionDue ?? ''}
                  onChange={(e) => setDecisionDue(e.target.value)}
                />
              </FormField>
            </>
          )}
          <FormField label="Další krok" error={fe.next_step}>
            <input name="next_step" value={nextStep} onChange={(e) => setNextStep(e.target.value)} maxLength={500} />
          </FormField>
          <FormField label="Termín kroku" error={fe.next_step_due}>
            <input
              name="next_step_due" type="date" value={nextStepDue ?? ''}
              onChange={(e) => setNextStepDue(e.target.value)}
            />
          </FormField>
          <FormField label="Proč žádný další krok není?" error={fe.no_next_step_reason}>
            <input
              name="no_next_step_reason" value={noStepReason}
              onChange={(e) => setNoStepReason(e.target.value)} maxLength={500}
            />
          </FormField>
          <div className="sm:col-span-3">
            <SubmitButton aria-label={`Uložit — ${deal.title}`}>Uložit</SubmitButton>
          </div>
        </form>
      )}
    </li>
  )
}
