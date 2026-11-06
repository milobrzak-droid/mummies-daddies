import type { ReactNode } from 'react'
import { cx } from './cx'

/**
 * Štítek (pilulka s 2px ink obrysem, jako plovoucí štítky reference). Tóny: blush = růžová
 * (Mummy), sage = modrá (Daddy), vanilla = máslová, provisional = provizorní obsah,
 * accent = malinový (JEN u ceny/akce).
 */
export type BadgeTone = 'blush' | 'sage' | 'vanilla' | 'pistachio' | 'paper' | 'outline' | 'provisional' | 'accent'

const TONE: Record<BadgeTone, string> = {
  blush: 'border-2 border-cocoa bg-raspberry-tint text-cocoa',
  sage: 'border-2 border-cocoa bg-daddy-tint text-cocoa',
  vanilla: 'border-2 border-cocoa bg-butter text-cocoa',
  pistachio: 'border-2 border-cocoa bg-pistachio text-cocoa',
  paper: 'border-2 border-cocoa bg-paper text-cocoa',
  outline: 'border-2 border-cocoa bg-transparent text-cocoa',
  provisional: 'bg-paper/90 text-cocoa border-2 border-dashed border-cocoa/60',
  accent: 'border-2 border-cocoa bg-raspberry-ink text-cream',
}

export function Badge({ tone = 'paper', size = 'md', className, children }: { tone?: BadgeTone; size?: 'sm' | 'md'; className?: string; children: ReactNode }) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 rounded-pill font-copy font-bold leading-none',
        size === 'sm' ? 'px-2.5 py-1 text-[0.75rem]' : 'px-3 py-1.5 text-[0.8125rem]',
        TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}
