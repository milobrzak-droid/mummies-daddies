import type { ReactNode } from 'react'
import { cx } from './cx'

/**
 * Štítek (pill). Tóny pastelů pro kategorie („Svatby“, „od 15 osob“),
 * provisional = provizorní obsah, accent = malinový (JEN u ceny/akce).
 */
export type BadgeTone = 'blush' | 'sage' | 'vanilla' | 'pistachio' | 'paper' | 'outline' | 'provisional' | 'accent'

const TONE: Record<BadgeTone, string> = {
  blush: 'bg-blush text-cocoa',
  sage: 'bg-sage text-cocoa',
  vanilla: 'bg-vanilla text-cocoa',
  pistachio: 'bg-pistachio text-cocoa',
  paper: 'bg-paper text-cocoa ring-1 ring-inset ring-hairline',
  outline: 'bg-transparent text-cocoa ring-1 ring-inset ring-cocoa/40',
  provisional: 'bg-paper/90 text-cocoa border border-dashed border-cocoa/50',
  accent: 'bg-raspberry-ink text-paper',
}

export function Badge({ tone = 'paper', size = 'md', className, children }: { tone?: BadgeTone; size?: 'sm' | 'md'; className?: string; children: ReactNode }) {
  return (
    <span
      className={cx(
        'inline-flex items-center gap-1.5 rounded-pill font-copy font-semibold leading-none',
        size === 'sm' ? 'px-2.5 py-1 text-[0.75rem]' : 'px-3 py-1.5 text-[0.8125rem]',
        TONE[tone],
        className,
      )}
    >
      {children}
    </span>
  )
}
