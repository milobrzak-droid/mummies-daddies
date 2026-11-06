import { PlaceholderText } from '../PlaceholderText'
import { PriceTag } from '../PriceTag'
import { cx } from '../cx'

/**
 * Seznam „pojem — hodnota“ (doprava a ceny, parametry produktu) jako <dl>.
 * Ceny v malinové (PriceTag), zástupci [DOPLNÍ KLIENT] jako čárkovaný štítek.
 */
export function TermList({
  items,
  className,
}: {
  items: { term: string; value: string; isPrice?: boolean }[]
  className?: string
}) {
  return (
    <dl className={cx('divide-y divide-cocoa/10 border-y border-cocoa/10', className)}>
      {items.map((it) => (
        <div key={it.term} className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 py-3">
          <dt className="font-copy text-copy font-bold text-cocoa">{it.term}</dt>
          <dd className="text-right font-copy text-copy text-cocoa-soft">
            {it.isPrice ? <PriceTag text={it.value} size="md" /> : <PlaceholderText text={it.value} />}
          </dd>
        </div>
      ))}
    </dl>
  )
}
