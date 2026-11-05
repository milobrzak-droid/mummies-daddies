import Link from 'next/link'
import { cx } from './cx'

/**
 * Slovní značka „Mummies & Daddies“ (serif verzálky). Logo v grafice od klienta
 * zatím nemáme – až dorazí, vymění se jen obsah této komponenty.
 */
export function Logo({ tone = 'dark', className, onClick }: { tone?: 'dark' | 'light'; className?: string; onClick?: () => void }) {
  return (
    <Link
      href="/"
      onClick={onClick}
      aria-label="Mummies & Daddies – úvod"
      className={cx(
        'inline-flex min-h-11 shrink-0 items-center whitespace-nowrap font-display text-[0.9375rem] font-semibold uppercase leading-none tracking-[0.05em] min-[400px]:text-[1.0625rem] sm:text-[1.375rem] sm:tracking-[0.08em] lg:text-[1.5rem]',
        tone === 'dark' ? 'text-cocoa' : 'text-cream md-focus-on-dark',
        className,
      )}
    >
      <span>Mummies</span>
      <span className={cx('mx-1 font-display italic sm:mx-1.5 normal-case tracking-normal', tone === 'dark' ? 'text-cocoa-soft' : 'text-cream/80')} aria-hidden="true">&amp;</span>
      <span>Daddies</span>
    </Link>
  )
}
