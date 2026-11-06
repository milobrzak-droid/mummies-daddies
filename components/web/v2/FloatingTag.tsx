import type { CSSProperties, ReactNode } from 'react'
import { PlaceholderText } from '../PlaceholderText'
import { cx } from '../cx'

/**
 * Plovoucí štítek (docs/web-v2-design.md §5.4): pilulka s 2px ink obrysem a tvrdým stínem,
 * mírně natočená, levituje (vypne se při prefers-reduced-motion). Text JEN z faktů.
 * Pozici řeší rodič (absolute / flex-wrap na mobilu).
 */
export type FloatingTagTone = 'paper' | 'vanilla' | 'blush' | 'sage'

const TONE: Record<FloatingTagTone, string> = {
  paper: 'bg-paper',
  vanilla: 'bg-butter',
  blush: 'bg-raspberry-tint',
  sage: 'bg-daddy-tint',
}

export function FloatingTag({
  tone = 'paper',
  rotate = 0,
  delay = 0,
  float = true,
  dot,
  className,
  children,
}: {
  tone?: FloatingTagTone
  /** Natočení ve stupních (−6 až +6). */
  rotate?: number
  /** Zpoždění levitace v sekundách (záporné = start uprostřed cyklu). */
  delay?: number
  float?: boolean
  /** Barevná tečka řady (Mummy malina / Daddy modrá). */
  dot?: 'raspberry' | 'blue'
  className?: string
  children: ReactNode
}) {
  const style = { '--r': `${rotate}deg`, animationDelay: `${delay}s` } as CSSProperties
  return (
    <span
      style={style}
      className={cx(
        'inline-flex max-w-[18rem] items-center sm:max-w-none sm:whitespace-nowrap gap-2 rounded-pill border-2 border-cocoa px-3.5 py-2 font-copy text-[0.875rem] font-bold leading-tight text-cocoa shadow-hard-sm',
        float ? 'md-float' : '[transform:rotate(var(--r))]',
        TONE[tone],
        className,
      )}
    >
      {dot ? <span aria-hidden="true" className={cx('h-2.5 w-2.5 shrink-0 rounded-pill border-2 border-cocoa', dot === 'blue' ? 'bg-daddy' : 'bg-raspberry')} /> : null}
      <span>{typeof children === 'string' ? <PlaceholderText text={children} /> : children}</span>
    </span>
  )
}
