'use client'
import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'
import type { ActionResult } from '@/lib/actionResult'
import { buttonClass, type ButtonVariant } from '@/components/ui/Button'

type Action = (prev: unknown, formData: FormData) => Promise<ActionResult>

function Btn({ children, variant, ariaLabel }: { children: string; variant: ButtonVariant; ariaLabel: string }) {
  const { pending } = useFormStatus()
  return (
    <button type="submit" disabled={pending} aria-busy={pending} aria-label={ariaLabel} className={buttonClass(variant, 'sm')}>
      {pending ? 'Ukládám…' : children}
    </button>
  )
}

// Přijmout / Zamítnout návrh případu. Přijetí založí případ a přesměruje na
// jeho detail; poznámka se ukládá jen u zamítnutí. Zamítnutí je nevratné,
// proto se potvrzuje. Server akce ověří AAL2 a stav návrhu znovu — tlačítka
// jsou jen pohodlí, ne hranice.
export function ProposalDecideButtons({ action, proposalId, label }: { action: Action; proposalId: number; label: string }) {
  const [state, formAction] = useActionState(action, null)
  const [note, setNote] = useState('')
  const [confirmReject, setConfirmReject] = useState(false)
  if (state?.success) return <span role="status" className="text-callout font-semibold text-muted">Zamítnuto.</span>
  return (
    <div className="flex min-w-[12rem] flex-col gap-2">
      {confirmReject ? (
        <form action={formAction} className="flex flex-col gap-2">
          <input type="hidden" name="proposal_id" value={proposalId} />
          <input type="hidden" name="accept" value="0" />
          <input
            name="note"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            maxLength={2000}
            placeholder="Důvod zamítnutí (volitelně)"
            aria-label={`Důvod zamítnutí — ${label}`}
          />
          <div className="flex flex-wrap items-center gap-2">
            <Btn variant="danger" ariaLabel={`Ano, zamítnout návrh — ${label}`}>Ano, zamítnout</Btn>
            <button type="button" className={buttonClass('quiet', 'sm')} onClick={() => setConfirmReject(false)}>Nechat</button>
          </div>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          <form action={formAction}>
            <input type="hidden" name="proposal_id" value={proposalId} />
            <input type="hidden" name="accept" value="1" />
            <input type="hidden" name="note" value="" />
            <Btn variant="secondary" ariaLabel={`Přijmout návrh — ${label}`}>Přijmout</Btn>
          </form>
          <button
            type="button"
            aria-label={`Zamítnout návrh — ${label}`}
            className={buttonClass('quiet', 'sm', 'text-neg hover:text-neg')}
            onClick={() => setConfirmReject(true)}
          >
            Zamítnout
          </button>
        </div>
      )}
      {state?.error && <p role="alert" className="m-0 text-callout text-neg">{state.error}</p>}
    </div>
  )
}
