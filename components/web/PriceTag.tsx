import { formatCzk } from '@/lib/web/format'
import { hasClientPlaceholder } from '@/lib/web/placeholders'
import { PlaceholderText } from './PlaceholderText'
import { cx } from './cx'

/**
 * Cena (malinová = akcent JEN pro ceny a CTA).
 *   <PriceTag amount={1290} />                         → 1 290 Kč
 *   <PriceTag amount={300} from unit="os" />           → od 300 Kč/os.
 *   <PriceTag text="Od [DOPLNÍ KLIENT] Kč/os." />      → text ze copy se zástupcem
 *   <PriceTag amount={300} from unit="os" minGuests={15} /> → od 300 Kč/os. · od 15 osob
 * Cenu nikdy nevymýšlej: když ji copy nemá, předej `text` se zástupcem.
 */
export function PriceTag({
  amount,
  to,
  from = false,
  unit,
  text,
  minGuests,
  size = 'md',
  className,
}: {
  amount?: number | null
  /** Horní hranice rozpětí (300–2 000 Kč). */
  to?: number | null
  from?: boolean
  unit?: 'os' | 'ks' | null
  text?: string | null
  minGuests?: number | null
  size?: 'sm' | 'md' | 'lg'
  className?: string
}) {
  const sizeCls = size === 'lg' ? 'text-[1.5rem] sm:text-[1.75rem]' : size === 'sm' ? 'text-small' : 'text-[1.0625rem]'
  const suffix = unit === 'os' ? '/os.' : unit === 'ks' ? '/ks' : ''
  let price: React.ReactNode = null
  if (typeof amount === 'number') {
    const range = typeof to === 'number' && to > amount ? `${formatCzk(amount).replace(/ Kč$/, '')}–${formatCzk(to)}` : formatCzk(amount)
    price = `${from ? 'od ' : ''}${range}${suffix}`
  } else if (text) {
    price = hasClientPlaceholder(text) ? <PlaceholderText text={text} /> : text
  }
  if (!price) return null
  return (
    <span className={cx('inline-flex flex-wrap items-baseline gap-x-2 font-copy', className)}>
      <span className={cx('font-bold tabular-nums text-raspberry-ink', sizeCls)}>{price}</span>
      {minGuests ? <span className="text-small text-cocoa-soft">· od {minGuests} osob</span> : null}
    </span>
  )
}
