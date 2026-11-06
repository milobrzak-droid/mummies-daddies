import Image from 'next/image'
import type { CSSProperties } from 'react'
import type { Photo } from '@/lib/web/photos'
import { cx } from '../cx'

/**
 * Levitující „talíř“: skutečná fotka cateringového jídla v kruhové masce s 2.5px ink obrysem
 * a tvrdým stínem (obdoba kruhových výřezů z reference). Slouží tam, kde jídlo nemá čistý
 * výřez bez pozadí (jednohubky, talíř od šéfkuchaře). Dekorace: aria-hidden, prázdný alt.
 */
export function FloatingPlate({
  photo,
  rotate = 0,
  delay = 0,
  sizes,
  className,
}: {
  photo: Photo | null
  rotate?: number
  delay?: number
  sizes: string
  className?: string
}) {
  if (!photo?.src || photo.placeholder) return null
  const s = { '--r': `${rotate}deg`, animationDelay: `${delay}s` } as CSSProperties
  return (
    <span style={s} aria-hidden="true" className={cx('md-float pointer-events-none block select-none', className)}>
      <span className="relative block aspect-square overflow-hidden rounded-full border-[2.5px] border-cocoa bg-raspberry-tint shadow-hard-md">
        <Image
          src={photo.src}
          {...(photo.blur ? { placeholder: 'blur' as const, blurDataURL: photo.blur } : {})}
          alt=""
          fill
          sizes={sizes}
          loading="lazy"
          className="object-cover"
          style={photo.position ? { objectPosition: photo.position } : undefined}
        />
      </span>
    </span>
  )
}
