'use client'
import { useFormStatus } from 'react-dom'
import { buttonClass } from '@/components/ui/Button'

// Odesílací tlačítko formuláře (docs/PROVOZ.md §1, §9).
// variant: výchozí = grafit (sekundární); `coral` = hlavní akce obrazovky
// (nejvýš jedna); `soft` = druhotná akce v řádku (obrys); `quiet` = jen text;
// `danger` = nevratná nebo rušivá akce (zrušit klíč, deaktivovat).
// Při odesílání je neaktivní a místo textu ukáže „Ukládám…“ s tečkou.
const VARIANT = {
  default: buttonClass('secondary'),
  coral: buttonClass('primary'),
  soft: buttonClass('outline'),
  quiet: buttonClass('quiet'),
  danger: buttonClass('danger'),
} as const

export function SubmitButton({ children, 'aria-label': ariaLabel, variant = 'default', size = 'md', pendingLabel = 'Ukládám…' }:
  {
    children: React.ReactNode
    'aria-label'?: string
    variant?: keyof typeof VARIANT
    size?: 'sm' | 'md'
    /** Text během odesílání (výchozí „Ukládám…“). */
    pendingLabel?: string
  }) {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      aria-label={ariaLabel}
      aria-busy={pending}
      className={`${VARIANT[variant]}${size === 'sm' ? ' btn-sm' : ''}`}
    >
      {pending && <span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-current motion-safe:animate-pulse" />}
      {pending ? pendingLabel : children}
    </button>
  )
}
