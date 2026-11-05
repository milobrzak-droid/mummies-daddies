import { Button } from '../Button'
import { PlaceholderText } from '../PlaceholderText'
import { Section } from '../Section'
import { SectionHeading } from '../SectionHeading'

export interface Step {
  title: string
  text: string
}

/**
 * „Jak to funguje“: 4 kroky na vodorovné ose (od lg), na mobilu svisle.
 * Číslování dává <ol>; velké číslice jsou jen vizuální (aria-hidden).
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
    <Section id={id} tone="vanilla" soft labelledBy={`${id}-title`}>
      <SectionHeading
        id={`${id}-title`}
        title={heading}
        lead={lead}
        action={cta ? <Button href={cta.href} variant="primary" size="lg" arrow>{cta.label}</Button> : undefined}
      />
      <ol role="list" className="relative grid gap-8 lg:grid-cols-4 lg:gap-8">
        <span aria-hidden="true" className="absolute bottom-6 left-7 top-6 w-px bg-cocoa/20 lg:bottom-auto lg:left-7 lg:right-7 lg:top-7 lg:h-px lg:w-auto" />
        {steps.map((s, i) => (
          <li key={s.title} className="relative grid grid-cols-[3.5rem_1fr] gap-5 lg:block">
            <span
              aria-hidden="true"
              className="relative grid h-14 w-14 place-items-center rounded-pill bg-paper font-display text-[1.75rem] font-semibold leading-none text-cocoa ring-1 ring-cocoa/10"
            >
              {i + 1}
            </span>
            <div className="lg:mt-6 lg:pr-4">
              <h3 className="md-caps text-h3 text-cocoa">{s.title}</h3>
              <p className="md-pretty mt-3 text-copy text-cocoa-soft">
                <PlaceholderText text={s.text} />
              </p>
            </div>
          </li>
        ))}
      </ol>
    </Section>
  )
}
