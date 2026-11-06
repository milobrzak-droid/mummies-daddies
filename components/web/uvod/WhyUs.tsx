import { PlaceholderText } from '../PlaceholderText'
import { SectionBand } from '../v2/SectionBand'
import { PILLAR_ICONS } from './icons'

export interface Pillar {
  title: string
  text: string
}

/** „Proč my“ (docs §6, sekce 7): růžový pruh + 4 buňky s ikonou v kruhu, dělené 2px linkami. */
export function WhyUs({ heading, lead, pillars, id = 'proc-my' }: { heading: string; lead?: string | null; pillars: Pillar[]; id?: string }) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="bg-cream">
      <SectionBand id={`${id}-title`} title={heading} lead={lead} tone="rasp" accent="Daddies" accentTone="blue" />
      <div className="mx-auto max-w-web-wide">
        <ul role="list" className="md-grid border-y-0 sm:grid-cols-2 lg:grid-cols-4 min-[90rem]:border-x-2 min-[90rem]:border-cocoa">
          {pillars.map((p, i) => {
            const Icon = PILLAR_ICONS[i % PILLAR_ICONS.length]
            return (
              <li key={p.title} className="grid grid-cols-[3.5rem_minmax(0,1fr)] gap-4 px-gutter py-8 sm:block sm:p-8 xl:p-10">
                <span className={`grid h-14 w-14 place-items-center rounded-pill border-2 border-cocoa text-cocoa shadow-hard-sm sm:mb-6 ${i % 2 ? 'bg-daddy-tint' : 'bg-raspberry-tint'}`}>
                  <Icon size={28} />
                </span>
                <div>
                  <h3 className="md-caps text-h3 text-cocoa">{p.title}</h3>
                  <p className="md-pretty mt-3 text-copy text-cocoa-soft">
                    <PlaceholderText text={p.text} />
                  </p>
                </div>
              </li>
            )
          })}
        </ul>
      </div>
    </section>
  )
}
