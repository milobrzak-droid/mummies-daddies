import Image from 'next/image'
import type { CSSProperties } from 'react'
import { cutout, type CutoutSlug } from '@/lib/web/cutouts'
import { cx } from '../cx'

/**
 * Levitující výřez produktu bez pozadí (docs/web-v2-design.md §5.5, §8): WebP s alfou
 * z public/web/cutouts, s pevnými rozměry (žádný CLS), natočený (--r) a levitující
 * (md-float, vypnuto při reduced motion). Jen první výřez nad ohybem má preload (LCP),
 * ostatní se načítají líně.
 * Dekorativní výřez (decorative) má prázdný alt a aria-hidden – nenese informaci.
 */
export function FloatingCutout({
  slug,
  rotate = 0,
  delay = 0,
  sizes,
  preload = false,
  decorative = true,
  float = true,
  className,
  style,
}: {
  slug: CutoutSlug
  rotate?: number
  delay?: number
  sizes: string
  preload?: boolean
  decorative?: boolean
  float?: boolean
  className?: string
  style?: CSSProperties
}) {
  const c = cutout(slug)
  const s = { '--r': `${rotate}deg`, animationDelay: `${delay}s`, ...style } as CSSProperties
  return (
    <span style={s} className={cx('pointer-events-none block select-none', float ? 'md-float' : '[transform:rotate(var(--r))]', className)} aria-hidden={decorative || undefined}>
      <Image
        src={c.src}
        alt={decorative ? '' : c.alt}
        width={c.width}
        height={c.height}
        sizes={sizes}
        preload={preload}
        loading={preload ? undefined : 'lazy'}
        className="h-auto w-full drop-shadow-[6px_8px_0_rgba(43,24,16,0.22)]"
      />
    </span>
  )
}
