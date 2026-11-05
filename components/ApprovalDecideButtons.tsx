'use client'
import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'
import Link from 'next/link'
import type { ActionResult } from '@/lib/actionResult'
import { SnoozeMenu } from '@/components/DecisionSnooze'
import { buttonClass, type ButtonVariant } from '@/components/ui/Button'

type Action = (prev: unknown, formData: FormData) => Promise<ActionResult>

function Btn({ children, variant, ariaLabel }: { children: string; variant: ButtonVariant; ariaLabel: string }) {
  const { pending } = useFormStatus()
  return (
    <button type="submit" disabled={pending} aria-busy={pending} aria-label={ariaLabel} className={buttonClass(variant)}>
      {pending ? 'Ukládám…' : children}
    </button>
  )
}

// Schválit / Upravit / Odložit / Zamítnout s volitelnou poznámkou. Server
// akce znovu ověří čtyři oči, stav, expiraci i roli — tlačítka jsou jen
// pohodlí, ne hranice. „Upravit" otevře případ nebo obchod (tam se dá návrh
// změnit), „Odložit" se od 0084 ukládá na žádost (vidí ho všichni) a toast
// nabídne Zpět. Zamítnutí je nevratné, proto se potvrzuje; schválení je
// hlavní akce karty a co udělá, říká karta nad tlačítky. Po rozhodnutí
// typované žádosti databáze hned provede další krok; výsledek je v historii.
export function ApprovalDecideButtons({
  action,
  requestId,
  label,
  caseHref,
  editLabel = 'Upravit',
  snoozeAction,
  typed = false,
}: {
  action: Action
  requestId: number
  label: string
  caseHref?: string | null
  editLabel?: string
  snoozeAction?: Action | null
  typed?: boolean
}) {
  const [state, formAction] = useActionState(action, null)
  const [note, setNote] = useState('')
  const [confirmReject, setConfirmReject] = useState(false)
  if (state?.success) {
    return (
      <span role="status" className="text-callout font-semibold text-pos">
        {typed ? 'Rozhodnuto. Výsledek provedení je v historii rozhodnutí.' : 'Rozhodnuto.'}
      </span>
    )
  }
  return (
    <div className="flex w-full flex-col gap-3">
      <input
        value={note}
        onChange={(e) => setNote(e.target.value)}
        maxLength={2000}
        placeholder="Poznámka (volitelně)"
        aria-label={`Poznámka k rozhodnutí — ${label}`}
      />
      {confirmReject ? (
        <form action={formAction} className="flex flex-wrap items-center gap-2 rounded-tile bg-[color:var(--c-neg-soft)] p-3">
          <input type="hidden" name="request_id" value={requestId} />
          <input type="hidden" name="approve" value="0" />
          <input type="hidden" name="note" value={note} />
          <span className="min-w-0 flex-1 basis-48 text-callout text-ink">Zamítnutí nejde vzít zpět. Žádost se uzavře.</span>
          <Btn variant="danger" ariaLabel={`Ano, zamítnout — ${label}`}>Ano, zamítnout</Btn>
          <button type="button" className={buttonClass('quiet')} onClick={() => setConfirmReject(false)}>Nechat</button>
        </form>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <form action={formAction}>
            <input type="hidden" name="request_id" value={requestId} />
            <input type="hidden" name="approve" value="1" />
            <input type="hidden" name="note" value={note} />
            <Btn variant="secondary" ariaLabel={`Schválit — ${label}`}>Schválit</Btn>
          </form>
          {caseHref && (
            <Link href={caseHref} aria-label={`${editLabel === 'Upravit' ? 'Upravit v případu' : editLabel} — ${label}`} className={buttonClass('outline')}>
              {editLabel}
            </Link>
          )}
          {snoozeAction && <SnoozeMenu label={label} requestId={requestId} action={snoozeAction} />}
          <button
            type="button"
            aria-label={`Zamítnout — ${label}`}
            className={buttonClass('quiet', 'md', 'text-neg hover:text-neg')}
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
