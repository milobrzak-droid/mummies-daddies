'use client'

import { IconPlus } from '../icons'
import { cx } from '../cx'
import { FIELD_CLASS } from './fields'

const IconMinus = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="round" aria-hidden="true" focusable="false">
    <path d="M5 12h14" />
  </svg>
)

const BTN =
  'grid h-11 w-11 shrink-0 place-items-center rounded-pill bg-paper text-cocoa ring-1 ring-inset ring-cocoa/20 ' +
  'transition-colors duration-quick hover:bg-cocoa hover:text-cream disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-paper disabled:hover:text-cocoa'

/**
 * Počet kusů: číselné pole s popiskem (přístupné z klávesnice šipkami) a tlačítky −/+
 * pro myš a dotyk. Tlačítka jsou mimo pořadí tabulátoru a skrytá čtečkám, aby se
 * stejná akce neohlašovala dvakrát – vše jde udělat přímo v poli.
 */
export function Stepper({
  id,
  value,
  onChange,
  min = 1,
  max = 99,
  describedBy,
  invalid,
  name,
  className,
}: {
  id: string
  value: number
  onChange: (value: number) => void
  min?: number
  max?: number
  describedBy?: string
  invalid?: boolean
  name?: string
  className?: string
}) {
  const set = (n: number) => onChange(Math.min(max, Math.max(min, Math.floor(Number.isFinite(n) ? n : min))))
  return (
    <div className={cx('flex items-center gap-2', className)}>
      <button type="button" tabIndex={-1} aria-hidden="true" className={BTN} disabled={value <= min} onClick={() => set(value - 1)}>
        <IconMinus />
      </button>
      <input
        id={id}
        name={name}
        type="number"
        inputMode="numeric"
        min={min}
        max={max}
        step={1}
        value={value}
        aria-describedby={describedBy}
        aria-invalid={invalid || undefined}
        onChange={(e) => {
          const n = e.currentTarget.valueAsNumber
          if (Number.isFinite(n)) set(n)
        }}
        className={cx(FIELD_CLASS, 'w-20 px-2 text-center tabular-nums [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none')}
      />
      <button type="button" tabIndex={-1} aria-hidden="true" className={BTN} disabled={value >= max} onClick={() => set(value + 1)}>
        <IconPlus size={18} />
      </button>
    </div>
  )
}
