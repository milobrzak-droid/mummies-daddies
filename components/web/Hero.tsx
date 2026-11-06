import type { ReactNode } from 'react'
import type { Photo } from '@/lib/web/photos'
import type { SurfaceTone } from '@/lib/web/tokens'
import { AccentTitle, type AccentTone } from './AccentTitle'
import { Breadcrumbs, type BreadcrumbItem } from './Breadcrumbs'
import { Button } from './Button'
import { Container } from './Container'
import { PhotoFrame, type PhotoAspect } from './PhotoFrame'
import { PlaceholderText } from './PlaceholderText'
import { FloatingTag } from './v2/FloatingTag'
import { cx } from './cx'
import { TONE_BG } from './tones'

/**
 * Hero podstránky (web v2, docs/web-v2-design.md §7.2): text vlevo (drobečky, štítek, obří
 * Anton titulek s jedním malinovým slovem, perex, pilulková CTA), vpravo fotka jako
 * „samolepka“ (2.5px obrys, tvrdý stín, jídlo natočené −2°) a volitelně plovoucí štítky
 * s fakty. Na mobilu text nahoře, fotka pod ním.
 * Fotka se načítá přednostně (LCP). Chybějící fotka → tint zástupce, layout zůstává.
 * Titulek je <h1> (jeden na stránku). Úvodní stránka má vlastní HomeHero (components/web/v2).
 */
export interface HeroCta {
  label: string
  href: string
}

/** Poměr stran podle fotky: na šířku 4:3, na výšku 4:5 (žádný ořez jídla). */
export function heroAspect(photo: Photo | null | undefined): PhotoAspect {
  if (!photo?.width || !photo.height) return 'portrait'
  return photo.width / photo.height >= 1.15 ? 'landscape' : photo.width / photo.height >= 0.9 ? 'square' : 'portrait'
}

export function Hero({
  title,
  lead,
  eyebrow,
  photo,
  primaryCta,
  secondaryCta,
  trust,
  breadcrumbs,
  tone = 'blush',
  size = 'home',
  id = 'hero-title',
  accent,
  accentTone,
  tilt = true,
  tags,
  children,
}: {
  title: string
  lead?: string | null
  eyebrow?: string | null
  photo: Photo | null
  /** Zachováno kvůli API v1 (art direction); v2 používá jednu fotku-samolepku. */
  mobilePhoto?: Photo | null
  primaryCta?: HeroCta | null
  secondaryCta?: HeroCta | null
  /** Mikrodůvěra pod tlačítky (může obsahovat [DOPLNÍ KLIENT]). */
  trust?: string | null
  breadcrumbs?: BreadcrumbItem[]
  tone?: SurfaceTone
  /** home = větší titulek, page = podstránka. */
  size?: 'home' | 'page'
  id?: string
  /** Akcentové slovo titulku (výchozí auto), false = bez akcentu. */
  accent?: string | false
  accentTone?: AccentTone
  /** Natočit fotku (jen jídlo; lidé a architektura se nenaklánějí). */
  tilt?: boolean
  /** Plovoucí štítky s FAKTY (max. 3), např. minimum osob. */
  tags?: string[]
  /** Obsah pod tlačítky (např. štítky, rychlý start v hero). */
  children?: ReactNode
}) {
  const aspect = heroAspect(photo)
  const floating = (tags ?? []).filter(Boolean).slice(0, 3)
  return (
    <section aria-labelledby={id} className={cx('relative isolate overflow-x-clip', TONE_BG[tone])}>
      <Container width="wide" className="grid items-center gap-10 pb-14 pt-8 sm:pt-12 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] lg:gap-14 lg:pb-20 lg:pt-14 xl:gap-20">
        <div className="min-w-0 motion-safe:animate-lift">
          {breadcrumbs?.length ? <Breadcrumbs items={breadcrumbs} className="mb-6" /> : null}
          {eyebrow ? (
            <p className="mb-5 inline-flex items-center gap-2 rounded-pill border-2 border-cocoa bg-paper px-3.5 py-1.5 font-copy text-eyebrow uppercase text-cocoa shadow-hard-sm">
              <span aria-hidden="true" className="h-2 w-2 rounded-pill bg-raspberry" />
              <PlaceholderText text={eyebrow} />
            </p>
          ) : null}
          <h1 id={id} className={cx('md-caps text-cocoa', size === 'home' ? 'text-hero' : 'text-h1')}>
            <AccentTitle title={title} accent={accent} tone={accentTone} />
          </h1>
          {lead ? (
            <p className="md-pretty mt-6 max-w-[36rem] text-lead text-cocoa">
              <PlaceholderText text={lead} />
            </p>
          ) : null}
          {primaryCta || secondaryCta ? (
            <div className="mt-8 flex flex-col items-stretch gap-4 sm:flex-row sm:flex-wrap sm:items-center sm:gap-5">
              {primaryCta ? (
                <Button href={primaryCta.href} variant="primary" size="lg" arrow>
                  {primaryCta.label}
                </Button>
              ) : null}
              {secondaryCta ? (
                <Button href={secondaryCta.href} variant="outline" size="lg">
                  {secondaryCta.label}
                </Button>
              ) : null}
            </div>
          ) : null}
          {trust ? (
            <p className="mt-6 max-w-[36rem] text-small font-medium text-cocoa-soft">
              <PlaceholderText text={trust} />
            </p>
          ) : null}
          {children ? <div className="mt-8">{children}</div> : null}
        </div>

        <div className={cx('relative mx-auto w-full', aspect === 'portrait' ? 'max-w-[30rem]' : 'max-w-[40rem]', floating.length > 0 && 'pb-6 lg:pb-0')}>
          <div className={cx(tilt && 'motion-safe:-rotate-2')}>
            <PhotoFrame photo={photo} aspect={aspect} sticker preload quality={85} tone={tone} sizes="(min-width: 1440px) 620px, (min-width: 1024px) 44vw, 92vw" />
          </div>
          {floating.length ? (
            <ul role="list" className="mt-5 flex flex-wrap gap-2 lg:mt-0 lg:block">
              {floating.map((t, i) => (
                <li key={t} className={cx('lg:absolute', TAG_POS[i])}>
                  <FloatingTag tone={(['vanilla', 'paper', 'sage'] as const)[i]} rotate={[-5, 4, -3][i]} delay={i * -1.7}>
                    {t}
                  </FloatingTag>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </Container>
    </section>
  )
}

const TAG_POS = ['lg:-left-8 lg:top-8', 'lg:-right-6 lg:top-1/2', 'lg:bottom-6 lg:left-6']
