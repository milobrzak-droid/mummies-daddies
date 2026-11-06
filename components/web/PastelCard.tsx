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
 * Karta v rámu (web v2 „FrameCell“, stejný jazyk jako buňky na úvodu): papírová karta s 2.5px
 * ink obrysem a tvrdým stínem; fotka přes celou šířku nahoře (bez vnitřního rámu), oddělená
 * linkou; tón (blush = Mummy, sage = Daddy, vanilla = máslová) je jen pruh nahoře / pod fotkou.
 * Na hover se karta zvedne (stín 6px). Pod fotkou titulek verzálkami, popis a `meta`
 * (PriceTag, Badge…). S `href` je klikací celá karta (roztažený odkaz na titulku).
 * Bez fotky (`photo` vynechat) NEBO s chybějící fotkou (zástupce) = textová karta s barevným
 * pruhem: ikona zástupce se nikdy neukazuje přes celou kartu vedle skutečných fotek.
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
  photoClassName,
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
  /** Doplňkové třídy rámu fotky (např. jiný poměr stran na mobilu: "max-sm:aspect-[3/2]"). */
  photoClassName?: string
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
  const hasPhoto = !!photo && !photo.placeholder && !!photo.src
  return (
    <article
      className={cx(
        'group relative flex h-full flex-col overflow-hidden border-[2.5px] border-cocoa bg-paper shadow-hard',
        href &&
          'motion-safe:transition-[transform,box-shadow] motion-safe:duration-quick hover:shadow-lift focus-within:shadow-lift motion-safe:hover:-translate-x-0.5 motion-safe:hover:-translate-y-0.5',
        className,
      )}
    >
      {hasPhoto ? (
        <PhotoFrame photo={photo} aspect={aspect} rounded={false} className={cx('border-b-[2.5px] border-cocoa', photoClassName)} sizes={sizes} tone={tone} zoomOnHover={!!href} />
      ) : (
        <span aria-hidden="true" className={cx('block h-3 border-b-[2.5px] border-cocoa', TONE_BG[tone])} />
      )}
      <div className="flex flex-1 flex-col px-5 pb-5 pt-5 sm:px-6 sm:pb-6">
        {eyebrow ? (
          <p className="mb-2 font-copy text-eyebrow uppercase text-cocoa">
            <PlaceholderText text={eyebrow} />
          </p>
        ) : null}
        <H className="md-caps text-h3 text-cocoa">
          {href ? (
            <Link href={href} className="outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:outline focus-visible:after:outline-[3px] focus-visible:after:outline-offset-4 focus-visible:after:outline-daddy-ink">
              {title}
            </Link>
          ) : (
            title
          )}
        </H>
        {description ? (
          <p className="md-pretty mt-3 text-copy text-cocoa-soft first-letter:uppercase">
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
                <span className="grid h-11 w-11 place-items-center rounded-pill border-2 border-cocoa bg-paper text-cocoa transition-colors duration-quick group-hover:bg-raspberry-ink group-hover:text-cream">
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
