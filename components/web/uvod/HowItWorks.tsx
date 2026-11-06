import { Button } from '../Button'
import { IconArrowRight } from '../icons'
import { PlaceholderText } from '../PlaceholderText'
import { SectionBand } from '../v2/SectionBand'

export interface Step {
  title: string
  text: string
}

/**
 * „Jak to funguje“ (docs §6, sekce 10): 4 orámované buňky s obřími Anton čísly v malině
 * a šipkami mezi nimi (od lg), na mobilu svislá osa. Číslování dává <ol>; číslice jsou
 * jen vizuální (aria-hidden).
 */
export function HowItWorks({
  heading,
  lead,
  steps,
  cta,
  id = 'jak-to-funguje',
}: {
  heading: string
  lead?: string | null
  steps: Step[]
  cta?: { label: string; href: string } | null
  id?: string
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="bg-cream">
      <SectionBand
        id={`${id}-title`}
        title={heading}
        accent="funguje"
        lead={lead}
        tone="cream"
        action={cta ? <Button href={cta.href} variant="primary" size="lg" arrow>{cta.label}</Button> : undefined}
      />
      <div className="mx-auto max-w-web-wide">
        <ol role="list" className="md-grid border-y-0 lg:grid-cols-4 min-[90rem]:border-x-2 min-[90rem]:border-cocoa">
          {steps.map((s, i) => (
            <li key={s.title} className="relative grid grid-cols-[4.5rem_minmax(0,1fr)] gap-4 px-gutter py-7 lg:block lg:p-8 xl:p-10">
              <span aria-hidden="true" className="md-caps block text-[4.5rem] leading-[1.12] text-raspberry lg:text-[6.5rem]">
                {i + 1}
              </span>
              <div className="lg:mt-4">
                <h3 className="md-caps text-h3 text-cocoa">{s.title}</h3>
                <p className="md-pretty mt-3 text-copy text-cocoa-soft first-letter:uppercase">
                  <PlaceholderText text={s.text} />
                </p>
              </div>
              {i < steps.length - 1 ? (
                <span aria-hidden="true" className="absolute -right-[1.4rem] top-12 z-10 hidden h-11 w-11 place-items-center rounded-pill border-2 border-cocoa bg-butter text-cocoa lg:grid">
                  <IconArrowRight size={20} />
                </span>
              ) : null}
            </li>
          ))}
        </ol>
      </div>
    </section>
  )
}
