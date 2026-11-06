import Form from 'next/form'
import { INQUIRY_PATH } from '@/lib/web/inquiry-link'
import type { Option } from '@/lib/web/options'
import { buttonClasses } from '../Button'
import { IconArrowRight, IconChevronDown } from '../icons'
import { cx } from '../cx'

/**
 * Rychlý start poptávky: Typ akce / Datum / Počet osob → /poptavka?typ=…&datum=…&osob=…&zdroj=…
 * Obyčejný GET formulář (next/form = klientská navigace + prefetch, bez JS
 * funguje jako běžný <form>). Názvy polí = parametry z lib/web/inquiry-link
 * (parseInquiryParams), takže /poptavka i asistent dostanou předvyplněno.
 * Prázdná pole parseInquiryParams zahodí.
 */
export interface QuickStartLabels {
  eventType: string
  eventTypePlaceholder: string
  date: string
  guests: string
  guestsPlaceholder: string
  submit: string
}

const FIELD =
  'block min-h-[3.25rem] w-full rounded-soft border-2 border-cocoa bg-cream px-4 font-copy text-copy text-cocoa ' +
  'transition-[box-shadow,background-color] duration-quick ease-md-out placeholder:text-cocoa-soft hover:bg-paper focus:border-daddy-ink focus:bg-paper focus:shadow-[0_0_0_3px_#36568F] focus:outline-none'

const LABEL = 'mb-2 block font-copy text-small font-bold text-cocoa'

export function QuickStartForm({
  labels,
  options,
  source,
  idPrefix = 'rychly-start',
  layout = 'row',
  className,
}: {
  labels: QuickStartLabels
  /** Typy akcí (QUICK_START_EVENT_TYPES z lib/web/options). */
  options: readonly Option[]
  /** Stránka, odkud poptávka přišla (parametr zdroj), např. "/". */
  source: string
  idPrefix?: string
  /** row = pole vedle sebe od lg (karta pod hero), stack = pod sebou (užší panel). */
  layout?: 'row' | 'stack'
  className?: string
}) {
  const id = (k: string) => `${idPrefix}-${k}`
  const row = layout === 'row'
  return (
    <Form
      action={INQUIRY_PATH}
      className={cx(
        'grid gap-4',
        row ? 'sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_0.8fr_auto] lg:items-end' : 'sm:grid-cols-2',
        className,
      )}
    >
      <input type="hidden" name="zdroj" value={source} />
      <div className={cx(row ? 'sm:col-span-2 lg:col-span-1' : 'sm:col-span-2')}>
        <label htmlFor={id('typ')} className={LABEL}>
          {labels.eventType}
        </label>
        <div className="relative">
          <select id={id('typ')} name="typ" defaultValue="" className={cx(FIELD, 'appearance-none pr-11')}>
            <option value="" disabled>
              {labels.eventTypePlaceholder}
            </option>
            {options.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <IconChevronDown size={18} className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-cocoa" />
        </div>
      </div>
      <div>
        <label htmlFor={id('datum')} className={LABEL}>
          {labels.date} <span className="font-normal text-cocoa-soft">(stačí přibližně)</span>
        </label>
        <input id={id('datum')} name="datum" type="date" className={FIELD} />
      </div>
      <div>
        <label htmlFor={id('osob')} className={LABEL}>
          {labels.guests}
        </label>
        <input
          id={id('osob')}
          name="osob"
          type="number"
          inputMode="numeric"
          min={1}
          max={5000}
          step={1}
          placeholder={labels.guestsPlaceholder}
          className={FIELD}
        />
      </div>
      <div className={cx(row ? 'sm:col-span-2 lg:col-span-1' : 'sm:col-span-2')}>
        <button type="submit" className={buttonClasses({ variant: 'primary', size: 'lg', fullWidth: true, className: 'group' })}>
          <span>{labels.submit}</span>
          <IconArrowRight size={18} className="motion-safe:transition-transform motion-safe:group-hover:translate-x-0.5" />
        </button>
      </div>
    </Form>
  )
}
