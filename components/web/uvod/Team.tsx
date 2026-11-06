import type { Photo } from '@/lib/web/photos'
import { Button } from '../Button'
import { Container } from '../Container'
import { PhotoFrame } from '../PhotoFrame'
import { PlaceholderText } from '../PlaceholderText'
import { AccentTitle } from '../AccentTitle'

/**
 * Tým (docs §6, sekce 13): modrá plocha, fotka jako rovná „samolepka“ (lidé se nenaklánějí),
 * dvě věty příběhu, podpis Antonem v malině a odkaz na O nás.
 */
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
    <section id={id} aria-labelledby={`${id}-title`} className="border-t-2 border-cocoa bg-daddy-tint py-section">
      <Container width="wide" className="grid items-center gap-12 md:grid-cols-2 lg:gap-20">
        <div className="mx-auto w-full max-w-md md:max-w-[34rem]">
          <PhotoFrame photo={photo} aspect="portrait" sticker sizes="(min-width: 1280px) 540px, (min-width: 768px) 45vw, 92vw" tone="blush" className="shadow-hard-lg" />
        </div>
        <div className="max-w-xl">
          <h2 id={`${id}-title`} className="md-caps text-h2 text-cocoa">
            <AccentTitle title={heading} accent="my" />
          </h2>
          {body ? (
            <p className="md-pretty mt-6 text-lead text-cocoa">
              <PlaceholderText text={body} />
            </p>
          ) : null}
          {signature ? <p className="md-caps mt-8 -rotate-2 text-h2 text-raspberry">{signature}</p> : null}
          {cta ? (
            <p className="mt-8">
              <Button href={cta.href} variant="white" arrow>
                {cta.label}
              </Button>
            </p>
          ) : null}
        </div>
      </Container>
    </section>
  )
}
