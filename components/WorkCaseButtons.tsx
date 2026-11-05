'use client'
import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'
import type { ActionResult } from '@/lib/actionResult'
import { buttonClass, type ButtonVariant } from '@/components/ui/Button'

type Action = (prev: unknown, formData: FormData) => Promise<ActionResult>

export type WorkCaseButton = {
  label: string
  fields: Record<string, string | number>
  /** Hlavní akce řady (grafit; v hlavičce stránky s `coral` koralová). */
  primary?: boolean
  ariaLabel?: string
  /** Nevratná akce: první klik ukáže tuto větu a potvrzení (docs/PROVOZ.md §11). */
  confirm?: string
  /** Text potvrzovacího tlačítka (výchozí „Ano, pokračovat“). */
  confirmLabel?: string
}

function Btn({ label, variant, size, ariaLabel }: { label: string; variant: ButtonVariant; size: 'sm' | 'md'; ariaLabel?: string }) {
  const { pending } = useFormStatus()
  return (
    <button type="submit" disabled={pending} aria-busy={pending} aria-label={ariaLabel} className={buttonClass(variant, size)}>
      {pending ? 'Ukládám…' : label}
    </button>
  )
}

// Řada tlačítek, každé ve vlastním malém formuláři se skrytými poli (bez
// spoléhání na submitter v FormData). Chybu akce ukáže pod řadou. Tlačítko
// s `confirm` se odešle až po potvrzení (nevratné přechody: uzavřít, zrušit).
export function WorkCaseButtons({
  action,
  buttons,
  size = 'sm',
  coral = false,
}: {
  action: Action
  buttons: WorkCaseButton[]
  size?: 'sm' | 'md'
  /** Hlavní tlačítko je hlavní akcí obrazovky (koral, nejvýš jedno na stránce). */
  coral?: boolean
}) {
  const [state, formAction] = useActionState(action, null)
  const [asking, setAsking] = useState<string | null>(null)
  if (buttons.length === 0) return null
  const variantOf = (b: WorkCaseButton): ButtonVariant => (b.primary ? (coral ? 'primary' : 'secondary') : 'outline')
  const hidden = (b: WorkCaseButton) =>
    Object.entries(b.fields).map(([k, v]) => <input key={k} type="hidden" name={k} value={String(v)} />)
  const pending = buttons.find((b) => b.label === asking && b.confirm)
  return (
    <div className="flex flex-col gap-1.5">
      {pending ? (
        <form action={formAction} className="flex flex-wrap items-center gap-2 rounded-tile bg-[color:var(--c-soft)] p-3">
          {hidden(pending)}
          <span className="min-w-0 flex-1 basis-48 text-callout text-ink">{pending.confirm}</span>
          <Btn label={pending.confirmLabel ?? 'Ano, pokračovat'} variant={pending.primary ? 'secondary' : 'danger'} size={size} ariaLabel={pending.ariaLabel ? `Potvrdit: ${pending.ariaLabel}` : undefined} />
          <button type="button" className={buttonClass('quiet', size)} onClick={() => setAsking(null)}>Nechat</button>
        </form>
      ) : (
        <div className="flex flex-wrap gap-2">
          {buttons.map((b) =>
            b.confirm ? (
              <button
                key={b.label}
                type="button"
                aria-label={b.ariaLabel}
                className={buttonClass(variantOf(b), size)}
                onClick={() => setAsking(b.label)}
              >
                {b.label}
              </button>
            ) : (
              <form key={b.label} action={formAction}>
                {hidden(b)}
                <Btn label={b.label} variant={variantOf(b)} size={size} ariaLabel={b.ariaLabel} />
              </form>
            ),
          )}
        </div>
      )}
      {state?.error && <p role="alert" className="m-0 text-callout text-neg">{state.error}</p>}
    </div>
  )
}
