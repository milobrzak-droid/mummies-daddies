import { getImageProps } from 'next/image'
import type { ReactNode } from 'react'
import type { Photo } from '@/lib/web/photos'
import type { SurfaceTone } from '@/lib/web/tokens'
import { Breadcrumbs, type BreadcrumbItem } from './Breadcrumbs'
import { Button } from './Button'
import { Container } from './Container'
import { PhotoFrame } from './PhotoFrame'
import { PlaceholderText } from './PlaceholderText'
import { cx } from './cx'
import { TONE_BG } from './tones'

/**
 * Hero: fotka přes celou šířku, text vlevo (jídlo je vpravo/dole jako v referenci).
 * - desktop (md+): fotka vyplní sekci, zleva ji překryje přechod v tónu `tone`,
 *   aby kakaový text měl kontrast AA i na rušné fotce;
 * - mobil: text nahoře na pastelu, pod ním fotka (mobilePhoto 4:5, jinak photo).
 * Fotka se načítá přednostně (LCP, fetchPriority=high) přes <picture> s art direction.
 * Chybějící fotka → pastelový zástupce, layout zůstává.
 * Titulek je <h1> (jeden na stránku).
 */
export interface HeroCta {
  label: string
  href: string
}

const GRADIENT: Record<SurfaceTone, string> = {
  blush: 'from-blush via-blush/85',
  sage: 'from-sage via-sage/85',
  vanilla: 'from-vanilla via-vanilla/85',
  pistachio: 'from-pistachio via-pistachio/85',
  cream: 'from-cream via-cream/85',
  paper: 'from-paper via-paper/85',
}
const FADE: Record<SurfaceTone, string> = {
  blush: 'from-blush', sage: 'from-sage', vanilla: 'from-vanilla', pistachio: 'from-pistachio', cream: 'from-cream', paper: 'from-paper',
}

function HeroPicture({ photo, mobilePhoto }: { photo: Photo; mobilePhoto?: Photo | null }) {
  const mobile = mobilePhoto && !mobilePhoto.placeholder && mobilePhoto.src ? mobilePhoto : photo
  const desktop = getImageProps({ src: photo.src!, alt: photo.alt, fill: true, sizes: '100vw', quality: 85 }).props
  const { srcSet: mobileSrcSet, ...img } = getImageProps({
    src: mobile.src!,
    alt: mobile === photo ? photo.alt : mobile.alt,
    fill: true,
    sizes: '100vw',
    quality: 75,
  }).props
  return (
    <picture>
      <source media="(min-width: 768px)" srcSet={desktop.srcSet} sizes="100vw" />
      <img
        {...img}
        srcSet={mobileSrcSet}
        alt={photo.alt}
        fetchPriority="high"
        loading="eager"
        decoding="async"
        className="h-full w-full object-cover"
        style={{ ...img.style, objectPosition: photo.position ?? '70% 60%' }}
      />
    </picture>
  )
}

export function Hero({
  title,
  lead,
  eyebrow,
  photo,
  mobilePhoto,
  primaryCta,
  secondaryCta,
  trust,
  breadcrumbs,
  tone = 'blush',
  size = 'home',
  id = 'hero-title',
  children,
}: {
  title: string
  lead?: string | null
  eyebrow?: string | null
  photo: Photo | null
  mobilePhoto?: Photo | null
  primaryCta?: HeroCta | null
  secondaryCta?: HeroCta | null
  /** Mikrodůvěra pod tlačítky (může obsahovat [DOPLNÍ KLIENT]). */
  trust?: string | null
  breadcrumbs?: BreadcrumbItem[]
  tone?: SurfaceTone
  /** home = cca 85 vh, page = podstránka (nižší). */
  size?: 'home' | 'page'
  id?: string
  /** Obsah pod tlačítky (např. štítky, rychlý start v hero). */
  children?: ReactNode
}) {
  const hasPhoto = !!photo && !photo.placeholder && !!photo.src
  return (
    <section aria-labelledby={id} className={cx('relative isolate flex flex-col overflow-hidden', TONE_BG[tone])}>
      <Container
        className={cx(
          'relative z-10 flex items-center',
          size === 'home' ? 'md:min-h-[min(85vh,880px)]' : 'md:min-h-[min(62vh,640px)]',
        )}
      >
        <div className={cx('max-w-xl py-10 sm:py-14 md:py-24 lg:max-w-2xl', 'motion-safe:animate-lift')}>
          {breadcrumbs?.length ? <Breadcrumbs items={breadcrumbs} className="mb-6" /> : null}
          {eyebrow ? (
            <p className="mb-5 font-copy text-eyebrow uppercase text-cocoa-soft">
              <PlaceholderText text={eyebrow} />
            </p>
          ) : null}
          <h1 id={id} className={cx('md-caps text-cocoa', size === 'home' ? 'text-hero' : 'text-h1')}>
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
                <Button href={secondaryCta.href} variant="ghost" size="md">
                  {secondaryCta.label}
                </Button>
              ) : null}
            </div>
          ) : null}
          {trust ? (
            <p className="mt-6 max-w-[34rem] text-small font-medium text-cocoa-soft">
              <PlaceholderText text={trust} />
            </p>
          ) : null}
          {children ? <div className="mt-8">{children}</div> : null}
        </div>
      </Container>

      <div className="relative aspect-[4/5] w-full sm:aspect-[16/10] md:absolute md:inset-0 md:aspect-auto">
        {hasPhoto ? (
          <HeroPicture photo={photo!} mobilePhoto={mobilePhoto} />
        ) : (
          <PhotoFrame photo={photo} aspect="fill" sizes="100vw" tone={tone} rounded={false} />
        )}
        <div aria-hidden="true" className={cx('pointer-events-none absolute inset-x-0 top-0 h-20 bg-gradient-to-b to-transparent md:hidden', FADE[tone])} />
        <div
          aria-hidden="true"
          className={cx('pointer-events-none absolute inset-0 hidden bg-gradient-to-r via-40% to-transparent to-75% md:block', GRADIENT[tone])}
        />
      </div>
    </section>
  )
}
