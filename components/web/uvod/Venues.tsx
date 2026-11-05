import type { Photo } from '@/lib/web/photos'
import { Button } from '../Button'
import { PhotoFrame } from '../PhotoFrame'
import { PlaceholderText } from '../PlaceholderText'
import { Section } from '../Section'

export interface VenueCard {
  name: string
  photo: Photo | null
}

/**
 * Užší pás „Nemáte místo?“: 3 partnerské prostory. Karty nejsou odkazy
 * (detail prostorů je jen na /prostory) → jedno CTA pro celý pás.
 */
export function Venues({
  heading,
  lead,
  venues,
  cta,
  id = 'prostory',
}: {
  heading: string
  lead?: string | null
  venues: VenueCard[]
  cta?: { label: string; href: string } | null
  id?: string
}) {
  return (
    <Section id={id} tone="paper" spacing="sm" labelledBy={`${id}-title`}>
      <div className="grid gap-8 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)] lg:items-center lg:gap-14">
        <div>
          <h2 id={`${id}-title`} className="md-caps text-h2 text-cocoa">
            {heading}
          </h2>
          {lead ? (
            <p className="md-pretty mt-4 text-lead text-cocoa-soft">
              <PlaceholderText text={lead} />
            </p>
          ) : null}
          {cta ? (
            <p className="mt-6">
              <Button href={cta.href} variant="ghost">
                {cta.label}
              </Button>
            </p>
          ) : null}
        </div>
        <ul role="list" className="grid gap-4 sm:grid-cols-3">
          {venues.map((v, i) => (
            <li key={v.name}>
              <figure>
                <PhotoFrame photo={v.photo} aspect="tall" className="max-sm:aspect-[3/2]" sizes="(min-width: 1024px) 260px, (min-width: 640px) 31vw, 92vw" tone={(['sage', 'blush', 'vanilla'] as const)[i % 3]} />
                <figcaption className="mt-3 font-copy text-small font-semibold text-cocoa">{v.name}</figcaption>
              </figure>
            </li>
          ))}
        </ul>
      </div>
    </Section>
  )
}
