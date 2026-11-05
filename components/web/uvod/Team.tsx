import type { Photo } from '@/lib/web/photos'
import { Button } from '../Button'
import { PhotoFrame } from '../PhotoFrame'
import { PlaceholderText } from '../PlaceholderText'
import { Section } from '../Section'

/** Tým: fotka z kuchyně, dvě věty příběhu, podpis a odkaz na O nás. */
export function Team({
  heading,
  body,
  signature,
  photo,
  cta,
  id = 'tym',
}: {
  heading: string
  body?: string | null
  signature?: string | null
  photo: Photo | null
  cta?: { label: string; href: string } | null
  id?: string
}) {
  return (
    <Section id={id} tone="paper" labelledBy={`${id}-title`}>
      <div className="grid items-center gap-10 md:grid-cols-2 lg:gap-20">
        <div className="mx-auto w-full max-w-md md:max-w-none">
          <PhotoFrame photo={photo} aspect="portrait" sizes="(min-width: 1280px) 560px, (min-width: 768px) 45vw, 92vw" tone="blush" />
        </div>
        <div className="max-w-xl">
          <h2 id={`${id}-title`} className="md-caps text-h2 text-cocoa">
            {heading}
          </h2>
          {body ? (
            <p className="md-pretty mt-6 text-lead text-cocoa">
              <PlaceholderText text={body} />
            </p>
          ) : null}
          {signature ? <p className="mt-8 font-display text-h3 italic text-cocoa">{signature}</p> : null}
          {cta ? (
            <p className="mt-8">
              <Button href={cta.href} variant="ghost">
                {cta.label}
              </Button>
            </p>
          ) : null}
        </div>
      </div>
    </Section>
  )
}
