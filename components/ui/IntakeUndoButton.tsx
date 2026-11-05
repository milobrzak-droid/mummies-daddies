'use client'
import { useActionState } from 'react'
import type { UndoResult } from '@/domain/crm/autoIntakeUndo'
import { buttonClass } from '@/components/ui/Button'

// „Není poptávka": nejdřív Zpět — smaže, co Cockpit založil z e-mailu (i to,
// co k tomu později přidal sám), a doménu si zapamatuje. Když u klienta už
// je lidská práce, server nic nesmaže, řekne proč a tady se místo prvního
// tlačítka objeví „Uzavřít jako Není poptávka" (obchod do Prohráno s důvodem,
// úkol hotovo, firma odložená; nic se nemaže). Výsledek se ukáže hned pod
// tlačítkem (jako ReminderButton).
export function IntakeUndoButton({
  action, dismiss, label, doneHref, doneLabel,
}: {
  action: () => Promise<UndoResult>
  dismiss: () => Promise<UndoResult>
  /** Název firmy do popisku tlačítka pro čtečku. */
  label: string
  /** Kam po vrácení (např. z karty klienta, který právě zmizel). */
  doneHref?: string
  doneLabel?: string
}) {
  const [state, formAction, pending] = useActionState<UndoResult | null>(async () => action(), null)
  const [closed, closeAction, closing] = useActionState<UndoResult | null>(async () => dismiss(), null)
  if (state?.success) {
    return (
      <p role="status" className="m-0 text-[13px] text-muted">
        {state.note}
        {doneHref && (
          <>
            {' '}
            <a href={doneHref} className="inline-flex min-h-[44px] items-center font-semibold text-ink underline">{doneLabel ?? 'Pokračovat'}</a>
          </>
        )}
      </p>
    )
  }
  if (closed?.success) {
    return <p role="status" className="m-0 text-[13px] text-muted">{closed.note}</p>
  }
  const offerClose = state?.canDismiss === true
  return (
    <div className="flex flex-col items-start gap-1.5">
      {!offerClose && (
        <form action={formAction}>
          <button
            type="submit"
            disabled={pending}
            aria-busy={pending}
            aria-label={`Není poptávka, vrátit zpět: ${label}`}
            className={buttonClass('outline', 'sm')}
          >
            {pending ? 'Vracím…' : 'Není poptávka'}
          </button>
        </form>
      )}
      {/* Odmítnuté vrácení není porucha: klidné vysvětlení a druhá cesta. */}
      {state?.error && (offerClose
        ? <p role="status" className="m-0 max-w-prose text-[13px] text-[color:#3A424E]">{state.error}</p>
        : <p role="alert" className="m-0 text-[13px] text-neg">{state.error}</p>)}
      {offerClose && (
        <form action={closeAction}>
          <button
            type="submit"
            disabled={closing}
            aria-busy={closing}
            aria-label={`Uzavřít jako Není poptávka: ${label}`}
            className={buttonClass('outline', 'sm')}
          >
            {closing ? 'Uzavírám…' : 'Uzavřít jako Není poptávka'}
          </button>
        </form>
      )}
      {closed?.error && <p role="alert" className="m-0 text-[13px] text-neg">{closed.error}</p>}
    </div>
  )
}
