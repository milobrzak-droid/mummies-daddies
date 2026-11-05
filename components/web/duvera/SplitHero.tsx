import type { ReactNode } from 'react'
import type { Photo } from '@/lib/web/photos'
import type { SurfaceTone } from '@/lib/web/tokens'
import { Breadcrumbs, type BreadcrumbItem } from '../Breadcrumbs'
import { Container } from '../Container'
import { PhotoFrame } from '../PhotoFrame'
import { PlaceholderText } from '../PlaceholderText'
import { cx } from '../cx'
import { TONE_BG } from '../tones'

/**
 * Úvod podstránky s fotkou NA VÝŠKU (portrét kuchaře, týmu): text vlevo,
 * fotka 3:4 vpravo; na mobilu text a pod ním fotka. Titulek je <h1>.
 * (Sdílený <Hero> roztahuje fotku na celou šířku, což portrét ořízne.)
 */
export function SplitHero({
  title,
  lead,
  eyebrow,
  photo,
  breadcrumbs,
  tone = 'blush',
  id = 'hero-title',
  children,
}: {
  title: string
  lead?: string | null
  eyebrow?: string | null
  photo: Photo | null
  breadcrumbs?: BreadcrumbItem[]
  tone?: SurfaceTone
  id?: string
  children?: ReactNode
}) {
  return (
    <section aria-labelledby={id} className={cx('overflow-hidden', TONE_BG[tone])}>
      <Container className="grid gap-10 py-10 sm:py-14 md:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] md:items-center md:gap-12 md:py-20 lg:gap-20">
        <div className="motion-safe:animate-lift">
          {breadcrumbs?.length ? <Breadcrumbs items={breadcrumbs} className="mb-6" /> : null}
          {eyebrow ? (
            <p className="mb-5 font-copy text-eyebrow uppercase text-cocoa-soft">
              <PlaceholderText text={eyebrow} />
            </p>
          ) : null}
          <h1 id={id} className="md-caps text-h1 text-cocoa">
            {title}
          </h1>
          {lead ? (
            <p className="md-pretty mt-6 max-w-[38rem] text-lead text-cocoa">
              <PlaceholderText text={lead} />
            </p>
          ) : null}
          {children ? <div className="mt-8">{children}</div> : null}
        </div>
        <PhotoFrame
          photo={photo}
          aspect="tall"
          preload
          quality={85}
          tone={tone}
          sizes="(min-width: 1280px) 480px, (min-width: 768px) 40vw, 100vw"
          className="motion-safe:animate-fade"
        />
      </Container>
    </section>
  )
}
