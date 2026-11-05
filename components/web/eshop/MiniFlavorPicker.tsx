'use client'

import { fill } from '@/lib/web/eshop/catalog'
import { MINI_PIECES, type MiniFlavor } from '@/lib/web/options'
import { cx } from '../cx'
import { ChoiceGroup, describedBy } from './fields'
import { Stepper } from './Stepper'

/**
 * Výběr 10 mini cheesecaků: u každé příchuti počet kusů, nahoře živé počítadlo
 * „Vyberte 10 příchutí. Zbývá vybrat {n}.“ (aria-live). Příchutě se mohou opakovat.
 */
export function MiniFlavorPicker({
  id,
  legend,
  hint,
  flavors,
  counts,
  onChange,
  remainingTemplate,
  error,
}: {
  id: string
  legend: string
  hint?: string | null
  flavors: { value: MiniFlavor; label: string }[]
  counts: Record<MiniFlavor, number>
  onChange: (counts: Record<MiniFlavor, number>) => void
  /** "Vyberte 10 příchutí. Zbývá vybrat {n}." */
  remainingTemplate: string
  error?: string | null
}) {
  const total = flavors.reduce((n, f) => n + (counts[f.value] ?? 0), 0)
  const remaining = Math.max(0, MINI_PIECES - total)
  const status = `${id}-zbyva`
  return (
    <ChoiceGroup id={id} legend={legend} hint={hint} error={error}>
      <p id={status} aria-live="polite" className={cx('mb-4 font-copy text-small font-semibold', remaining === 0 ? 'text-success' : 'text-cocoa')}>
        {fill(remainingTemplate, { n: remaining })}
      </p>
      <ul role="list" className="grid gap-3 sm:grid-cols-2">
        {flavors.map((f) => {
          const inputId = `${id}-${f.value}`
          const value = counts[f.value] ?? 0
          return (
            <li key={f.value} className="flex items-center justify-between gap-3 rounded-soft bg-paper px-4 py-2 ring-1 ring-inset ring-cocoa/15">
              <label htmlFor={inputId} className="font-copy text-copy font-semibold text-cocoa">
                {f.label}
              </label>
              <Stepper
                id={inputId}
                value={value}
                min={0}
                max={value + remaining}
                describedBy={[status, describedBy(id, hint, error)].filter(Boolean).join(' ')}
                onChange={(n) => onChange({ ...counts, [f.value]: n })}
              />
            </li>
          )
        })}
      </ul>
    </ChoiceGroup>
  )
}
