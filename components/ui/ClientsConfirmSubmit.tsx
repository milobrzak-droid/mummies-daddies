'use client'
import { useEffect, useRef, useState } from 'react'
import { useFormStatus } from 'react-dom'
import { buttonClass } from '@/components/ui/Button'

// Nevratná akce ve formuláři (smazat, odebrat vazbu) s potvrzením na místě
// (docs/PROVOZ.md §11 „Zpět místo Opravdu?“: potvrzení jen u nevratné
// akce a říká, co přesně se stane). První klik jen ukáže otázku a tlačítko,
// které formulář teprve odešle; „Nechat být“ vrátí původní stav. Fokus jde
// na potvrzovací tlačítko a po zrušení zpět na spouštěč.
export function ClientsConfirmSubmit({ label, confirmLabel, question, ariaLabel, size = 'sm', pendingLabel = 'Mažu…' }: {
  /** Text spouštěče („Odebrat“, „Smazat kontakt“). */
  label: string
  /** Text potvrzovacího tlačítka – co přesně se stane („Odebrat vazbu“). */
  confirmLabel: string
  /** Jedna věta s důsledkem („Vazba se smaže a nejde vrátit.“). */
  question: string
  ariaLabel?: string
  size?: 'sm' | 'md'
  /** Text během odesílání (výchozí „Mažu…“). */
  pendingLabel?: string
}) {
  const [asking, setAsking] = useState(false)
  const confirmRef = useRef<HTMLButtonElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const wasAsking = useRef(false)

  useEffect(() => {
    if (asking) confirmRef.current?.focus()
    else if (wasAsking.current) triggerRef.current?.focus()
    wasAsking.current = asking
  }, [asking])

  if (!asking) {
    return (
      <button
        ref={triggerRef}
        type="button"
        aria-label={ariaLabel}
        onClick={() => setAsking(true)}
        className={buttonClass('danger', size)}
      >
        {label}
      </button>
    )
  }
  return (
    <span role="group" aria-label={ariaLabel ?? label} className="inline-flex flex-wrap items-center gap-2">
      <span className="text-callout text-ink">{question}</span>
      <ConfirmButton ref={confirmRef} size={size} pendingLabel={pendingLabel}>{confirmLabel}</ConfirmButton>
      <button type="button" onClick={() => setAsking(false)} className={buttonClass('quiet', size)}>Nechat být</button>
    </span>
  )
}

function ConfirmButton({ children, size, pendingLabel, ref }: {
  children: string; size: 'sm' | 'md'; pendingLabel: string; ref: React.Ref<HTMLButtonElement>
}) {
  const { pending } = useFormStatus()
  return (
    <button ref={ref} type="submit" disabled={pending} aria-busy={pending} className={buttonClass('danger', size)}>
      {pending ? pendingLabel : children}
    </button>
  )
}
