import type { Photo } from '@/lib/web/photos'
import type { SurfaceTone } from '@/lib/web/tokens'
import { Breadcrumbs, type BreadcrumbItem } from '../Breadcrumbs'
import { Button } from '../Button'
import { Container } from '../Container'
import { Hero, type HeroCta } from '../Hero'
import { PhotoFrame } from '../PhotoFrame'
import { PlaceholderText } from '../PlaceholderText'
import { cx } from '../cx'
import { TONE_BG } from '../tones'
import { aspectFor } from './blocks'

/**
 * Hero stránek cateringu. Široká fotka na šířku (≥ 1600 px, poměr ≥ 1,4) jde do
 * sdíleného <Hero> přes celou šířku. Fotka na výšku nebo s malým rozlišením
 * (výběr fotek to u nich přímo předepisuje: „split: fotka vpravo 4:5“) jde do
 * dělené varianty: text vlevo na pastelu, fotka vpravo v rámu – bez rozmazání
 * a bez ořezu jídla.
 */
export function isWidePhoto(photo: Photo | null | undefined): boolean {
  return !!photo && !photo.placeholder && !!photo.src && (photo.width ?? 0) >= 1600 && (photo.width ?? 0) / (photo.height ?? 1) >= 1.4
}

export function CateringHero({
  title,
  lead,
  photo,
  primaryCta,
  secondaryCta,
  breadcrumbs,
  tone,
  id = 'hero-title',
}: {
  title: string
  lead?: string | null
  photo: Photo
  primaryCta?: HeroCta | null
  secondaryCta?: HeroCta | null
  breadcrumbs: BreadcrumbItem[]
  tone: SurfaceTone
  id?: string
}) {
  if (isWidePhoto(photo)) {
    return (
      <Hero
        title={title}
        lead={lead}
        photo={photo}
        primaryCta={primaryCta}
        secondaryCta={secondaryCta}
        breadcrumbs={breadcrumbs}
        tone={tone}
        size="page"
        id={id}
      />
    )
  }
  const aspect = aspectFor(photo, 'portrait')
  return (
    <section aria-labelledby={id} className={cx('relative isolate overflow-hidden', TONE_BG[tone])}>
      <Container
        className="grid items-center gap-10 pb-20 pt-8 sm:pt-12 md:grid-cols-[1.1fr_1fr] md:gap-12 md:pb-24 md:pt-16 lg:gap-20"
      >
        <div className="max-w-xl motion-safe:animate-lift">
          <Breadcrumbs items={breadcrumbs} className="mb-6" />
          <h1 id={id} className="md-caps text-h1 text-cocoa">
            {title}
          </h1>
          {lead ? (
            <p className="md-pretty mt-6 max-w-[34rem] text-lead text-cocoa">
              <PlaceholderText text={lead} />
            </p>
          ) : null}
          {primaryCta || secondaryCta ? (
            <div className="mt-8 flex flex-col items-start gap-4 sm:flex-row sm:items-center sm:gap-6">
              {primaryCta ? (
                <Button href={primaryCta.href} variant="white" size="lg">
                  {primaryCta.label}
                </Button>
              ) : null}
              {secondaryCta ? (
                <Button href={secondaryCta.href} variant="ghost">
                  {secondaryCta.label}
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
        <PhotoFrame
          photo={photo}
          aspect={aspect}
          sizes="(min-width: 1440px) 660px, (min-width: 768px) 46vw, 100vw"
          preload
          quality={85}
          tone={tone}
          className={cx('w-full shadow-float', aspect === 'portrait' && 'mx-auto max-w-[34rem] md:mr-0')}
        />
      </Container>
    </section>
  )
}
