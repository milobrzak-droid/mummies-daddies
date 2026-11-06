import type { Photo } from '@/lib/web/photos'
import { Button } from '../Button'
import { PhotoFrame } from '../PhotoFrame'
import { SectionBand } from '../v2/SectionBand'

export interface VenueCard {
  name: string
  photo: Photo | null
}

/**
 * Prostory (docs §6, sekce 12): 3 buňky s fotkami v ostrém ořezu (architektura se nenaklání)
 * a popiskem v pilulce. Karty nejsou odkazy (detail je jen na /prostory) → jedno CTA.
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
    <section id={id} aria-labelledby={`${id}-title`} className="bg-cream">
      <SectionBand
        id={`${id}-title`}
        title={heading}
        accent="statcích"
        lead={lead}
        tone="blue"
        action={cta ? <Button href={cta.href} variant="white" arrow>{cta.label}</Button> : undefined}
      />
      <div className="mx-auto max-w-web-wide">
        <ul role="list" className="md-grid border-y-0 sm:grid-cols-3 min-[90rem]:border-x-2 min-[90rem]:border-cocoa">
          {venues.map((v, i) => (
            <li key={v.name}>
              <figure className="relative">
                <PhotoFrame photo={v.photo} aspect="landscape" rounded={false} className="sm:aspect-[4/5] lg:aspect-[4/3]" sizes="(min-width: 1440px) 480px, (min-width: 640px) 33vw, 100vw" tone={i % 2 ? 'blush' : 'sage'} />
                <figcaption className="absolute bottom-4 left-4 right-4">
                  <span className="inline-flex rounded-pill border-2 border-cocoa bg-paper px-3.5 py-1.5 font-copy text-small font-bold text-cocoa shadow-hard-sm">{v.name}</span>
                </figcaption>
              </figure>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}
