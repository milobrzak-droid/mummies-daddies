import { PlaceholderText } from '../PlaceholderText'
import { Section } from '../Section'
import { SectionHeading } from '../SectionHeading'
import { PILLAR_ICONS } from './icons'

export interface Pillar {
  title: string
  text: string
}

/** Pás „Proč Mummies & Daddies“: 4 pilíře s ikonou na krémovém podkladu. */
export function WhyUs({ heading, lead, pillars, id = 'proc-my' }: { heading: string; lead?: string | null; pillars: Pillar[]; id?: string }) {
  return (
    <Section id={id} tone="cream" labelledBy={`${id}-title`}>
      <SectionHeading id={`${id}-title`} title={heading} lead={lead} align="center" />
      <ul role="list" className="grid gap-x-8 gap-y-10 sm:grid-cols-2 lg:grid-cols-4">
        {pillars.map((p, i) => {
          const Icon = PILLAR_ICONS[i % PILLAR_ICONS.length]
          return (
            <li key={p.title} className="flex flex-col items-start border-t border-hairline pt-6">
              <span className="mb-5 grid h-14 w-14 place-items-center rounded-pill bg-blush text-cocoa">
                <Icon size={30} />
              </span>
              <h3 className="md-caps text-h3 text-cocoa">{p.title}</h3>
              <p className="md-pretty mt-3 text-copy text-cocoa-soft">
                <PlaceholderText text={p.text} />
              </p>
            </li>
          )
        })}
      </ul>
    </Section>
  )
}
