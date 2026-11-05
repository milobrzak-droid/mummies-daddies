import Image from 'next/image'
import type { ReactNode } from 'react'
import type { Photo } from '@/lib/web/photos'
import type { SurfaceTone } from '@/lib/web/tokens'
import { Badge } from './Badge'
import { IconPlate } from './icons'
import { cx } from './cx'
import { TONE_BG_DEEP } from './tones'

/**
 * Rámeček fotky s pevným poměrem stran (žádný posun layoutu) přes next/image `fill`.
 * Když fotka chybí (photo.placeholder / null), vykreslí pastelového zástupce
 * v tónu `tone` – stránka vypadá hotově i bez fotek.
 *
 * sizes je POVINNÉ (responzivní srcset): např. "(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw".
 * preload = jen pro fotku nad ohybem (LCP); jinak se načítá líně.
 */
export type PhotoAspect = 'portrait' | 'tall' | 'square' | 'landscape' | 'wide' | 'fill'

const ASPECT: Record<PhotoAspect, string> = {
  portrait: 'aspect-[4/5]',
  tall: 'aspect-[3/4]',
  square: 'aspect-square',
  landscape: 'aspect-[3/2]',
  wide: 'aspect-[16/9]',
  /** Vyplní rodiče (rodič musí mít position + rozměr). */
  fill: 'absolute inset-0',
}

export function PhotoFrame({
  photo,
  aspect = 'portrait',
  sizes,
  preload = false,
  quality = 75,
  tone = 'blush',
  zoomOnHover = false,
  showProvisional = false,
  placeholderLabel,
  rounded = true,
  className,
  imgClassName,
  children,
}: {
  photo: Photo | null | undefined
  aspect?: PhotoAspect
  sizes: string
  preload?: boolean
  quality?: 60 | 75 | 85
  /** Tón zástupce (sytější varianta pastelu). */
  tone?: SurfaceTone
  /** Jemné přiblížení při najetí na rodiče s třídou `group`. */
  zoomOnHover?: boolean
  /** Ukázat štítek „Provizorní fotka“ u provizorních fotek (interní náhledy). */
  showProvisional?: boolean
  /** Text v zástupci (výchozí žádný, jen ikona). */
  placeholderLabel?: string
  rounded?: boolean
  className?: string
  imgClassName?: string
  /** Překryv (štítky, gradient). */
  children?: ReactNode
}) {
  const frame = cx('relative overflow-hidden', ASPECT[aspect], rounded && 'rounded-frame', className)
  if (!photo || photo.placeholder || !photo.src) {
    return (
      <div role="img" aria-label={photo?.alt ?? placeholderLabel ?? 'Fotka bude doplněna'} className={cx(frame, TONE_BG_DEEP[tone], 'md-placeholder-pattern')}>
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-cocoa/45">
          <IconPlate size={44} />
          {placeholderLabel ? <span className="px-6 text-center font-copy text-small font-semibold text-cocoa">{placeholderLabel}</span> : null}
        </div>
        {children}
      </div>
    )
  }
  return (
    <div className={cx(frame, TONE_BG_DEEP[tone])}>
      <Image
        src={photo.src}
        alt={photo.alt}
        fill
        sizes={sizes}
        quality={quality}
        preload={preload}
        className={cx(
          'object-cover',
          zoomOnHover && 'motion-safe:transition-transform motion-safe:duration-slow motion-safe:ease-md-out motion-safe:group-hover:scale-[1.035]',
          imgClassName,
        )}
        style={photo.position ? { objectPosition: photo.position } : undefined}
      />
      {showProvisional && photo.provisional ? (
        <Badge tone="provisional" size="sm" className="absolute left-3 top-3">
          Provizorní fotka
        </Badge>
      ) : null}
      {children}
    </div>
  )
}
