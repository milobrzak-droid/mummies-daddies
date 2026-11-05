import { PlaceholderText } from '../PlaceholderText'
import { cx } from '../cx'

export interface Fact {
  label: string
  value: string
}

/** Shrnutí akce jako seznam definic (Typ akce, Místo, Formát, Hosté, Datum). */
export function FactList({ facts, className }: { facts: readonly Fact[]; className?: string }) {
  if (!facts.length) return null
  return (
    <dl className={cx('divide-y divide-hairline border-y border-hairline', className)}>
      {facts.map((f) => (
        <div key={f.label} className="grid gap-1 py-4 sm:grid-cols-[9rem_1fr] sm:gap-6">
          <dt className="font-copy text-eyebrow uppercase text-cocoa-soft">{f.label}</dt>
          <dd className="md-pretty text-copy font-medium text-cocoa">
            <PlaceholderText text={f.value} />
          </dd>
        </div>
      ))}
    </dl>
  )
}
