import type { Option } from '@/lib/web/options'
import { AccentTitle } from '../AccentTitle'
import { Container } from '../Container'
import { PlaceholderText } from '../PlaceholderText'
import { QuickStartForm, type QuickStartLabels } from './QuickStartForm'

/**
 * Rychlý start (docs §5.12, kompaktní varianta): orámovaný papírový panel přes celou šířku
 * pod hero, Anton nadpis s malinovým slovem, pole Typ akce · Datum · Počet osob a CTA.
 */
export function QuickStartCard({
  heading,
  body,
  labels,
  options,
  source = '/',
  id = 'rychly-start-title',
}: {
  heading: string
  body?: string | null
  labels: QuickStartLabels
  options: readonly Option[]
  source?: string
  id?: string
}) {
  return (
    <section aria-labelledby={id} className="border-t-2 border-cocoa bg-raspberry-tint py-10 sm:py-14">
      <Container width="wide">
        <div className="border-2 border-cocoa bg-paper p-5 shadow-hard-lg sm:p-8 lg:p-10">
          <div className="mb-6 flex flex-col gap-2 lg:mb-8 lg:flex-row lg:items-end lg:justify-between lg:gap-10">
            <h2 id={id} className="md-caps text-h2 text-cocoa">
              <AccentTitle title={heading} accent="nabídku" />
            </h2>
            {body ? (
              <p className="md-pretty max-w-xl text-copy text-cocoa-soft lg:text-right">
                <PlaceholderText text={body} />
              </p>
            ) : null}
          </div>
          <QuickStartForm labels={labels} options={options} source={source} />
        </div>
      </Container>
    </section>
  )
}
