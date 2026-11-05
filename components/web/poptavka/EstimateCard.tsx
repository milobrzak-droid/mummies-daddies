import type { PriceEstimate } from '@/lib/web/api'
import { formatCzk, formatNumber, plural } from '@/lib/web/format'
import { UI_TEXT, fillText } from '@/lib/web/poptavka/ui-text'
import { PriceTag } from '../PriceTag'
import { cx } from '../cx'

/**
 * Orientační cena z estimatePrice (jen rozpětí, jasně „orientačně“).
 * Bez odhadu (konzultace, „ještě nevím“) se nevykreslí. Bez stavu → server i klient.
 */
export function EstimateCard({ estimate, guests, live = false, className }: { estimate: PriceEstimate | null; guests?: number | null; live?: boolean; className?: string }) {
  if (!estimate) return null
  const n = estimate.total ? (guests ?? null) : null
  return (
    <div
      className={cx('rounded-soft bg-vanilla p-5 ring-1 ring-inset ring-cocoa/5 sm:p-6', className)}
      {...(live ? { role: 'status', 'aria-live': 'polite' as const } : {})}
    >
      <p className="font-copy text-eyebrow uppercase text-cocoa-soft">{UI_TEXT.estimateTitle}</p>
      <p className="mt-2">
        <PriceTag amount={estimate.od} to={estimate.do} unit="os" size="lg" />
      </p>
      {estimate.total && n ? (
        <p className="mt-2 font-copy text-small font-semibold text-cocoa">
          {fillText(UI_TEXT.estimateTotal, {
            n: formatNumber(n),
            osob: plural(n, ['osobu', 'osoby', 'osob']),
            od: formatNumber(estimate.total.od),
            do: formatCzk(estimate.total.do),
          })}
        </p>
      ) : null}
      <p className="md-pretty mt-3 font-copy text-small text-cocoa-soft">{UI_TEXT.estimateNote}</p>
    </div>
  )
}
