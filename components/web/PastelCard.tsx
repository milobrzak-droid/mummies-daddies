import Link from 'next/link'
import type { ReactNode } from 'react'
import type { Photo } from '@/lib/web/photos'
import type { SurfaceTone } from '@/lib/web/tokens'
import { IconArrowRight } from './icons'
import { PhotoFrame, type PhotoAspect } from './PhotoFrame'
import { PlaceholderText } from './PlaceholderText'
import { cx } from './cx'
import { TONE_BG } from './tones'

/**
 * Pastelová karta (srdce mřížky typů akcí, produktů, referencí).
 * Fotka v pastelovém rámu, pod ní titulek verzálkami, popis a `meta` (PriceTag,
 * Badge…). S `href` je klikací celá karta (roztažený odkaz na titulku), bez
 * vnořených odkazů. Bez fotky (`photo` vynechat) = textová karta (pilíře, kroky).
 *
 * Střídání tónů v mřížce: tone={toneAt(i)} z lib/web/tokens.
 */
export function PastelCard({
  title,
  description,
  href,
  photo,
  tone = 'blush',
  aspect = 'portrait',
  sizes = '(min-width: 1280px) 400px, (min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw',
  eyebrow,
  meta,
  linkLabel,
  headingLevel: H = 'h3',
  className,
  children,
}: {
  title: string
  description?: string | null
  href?: string
  photo?: Photo | null
  tone?: SurfaceTone
  aspect?: PhotoAspect
  sizes?: string
  eyebrow?: string | null
  /** Pod popisem: cena, minimum osob, štítky. */
  meta?: ReactNode
  /** Text výzvy dole (např. „Zobrazit menu“); s href výchozí šipka bez textu. */
  linkLabel?: string
  headingLevel?: 'h2' | 'h3' | 'h4'
  className?: string
  children?: ReactNode
}) {
  return (
    <article
      className={cx(
        'group relative flex h-full flex-col rounded-frame p-3 sm:p-4',
        TONE_BG[tone],
        href && 'transition-shadow duration-base ease-md-out hover:shadow-lift focus-within:shadow-lift',
        className,
      )}
    >
      {photo !== undefined ? (
        <PhotoFrame photo={photo} aspect={aspect} sizes={sizes} tone={tone} zoomOnHover={!!href} />
      ) : null}
      <div className={cx('flex flex-1 flex-col px-2 pb-3 sm:px-3', photo !== undefined ? 'pt-5' : 'pt-4')}>
        {eyebrow ? (
          <p className="mb-2 font-copy text-eyebrow uppercase text-cocoa-soft">
            <PlaceholderText text={eyebrow} />
          </p>
        ) : null}
        <H className="md-caps text-h3 text-cocoa">
          {href ? (
            <Link href={href} className="outline-none after:absolute after:inset-0 after:rounded-frame after:content-[''] focus-visible:after:outline focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-raspberry-ink">
              {title}
            </Link>
          ) : (
            title
          )}
        </H>
        {description ? (
          <p className="md-pretty mt-3 text-copy text-cocoa-soft">
            <PlaceholderText text={description} />
          </p>
        ) : null}
        {children}
        {meta || href ? (
          <div className="mt-auto flex items-end justify-between gap-4 pt-5">
            <div className="min-w-0">{meta}</div>
            {href ? (
              <span aria-hidden="true" className="inline-flex shrink-0 items-center gap-2 font-copy text-small font-semibold text-cocoa">
                {linkLabel}
                <span className="grid h-10 w-10 place-items-center rounded-pill bg-paper text-cocoa transition-colors duration-quick group-hover:bg-raspberry-ink group-hover:text-paper">
                  <IconArrowRight size={18} />
                </span>
              </span>
            ) : null}
          </div>
        ) : null}
      </div>
    </article>
  )
}
