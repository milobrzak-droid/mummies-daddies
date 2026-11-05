import type { Option } from '@/lib/web/options'
import { Container } from '../Container'
import { PlaceholderText } from '../PlaceholderText'
import { QuickStartForm, type QuickStartLabels } from './QuickStartForm'

/**
 * Karta rychlého startu, která překrývá spodní hranu hera (relative z-20 -mt-16).
 * Pod ní pokračuje bílá plocha s mřížkou typů akcí.
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
    <section aria-labelledby={id} className="relative z-20 -mt-16">
      {/* Horní 4 rem karty leží na heru, zbytek na bílé ploše mřížky. */}
      <div aria-hidden="true" className="absolute inset-x-0 bottom-0 top-16 bg-paper" />
      <Container className="relative">
        <div className="rounded-soft bg-paper p-5 shadow-float ring-1 ring-cocoa/5 sm:p-8 lg:p-10 motion-safe:animate-rise">
          <div className="mb-6 flex flex-col gap-2 lg:mb-8 lg:flex-row lg:items-end lg:justify-between lg:gap-10">
            <h2 id={id} className="md-caps text-h3 text-cocoa">
              {heading}
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
