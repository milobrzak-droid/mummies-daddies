import Link from 'next/link'
import { LogoHorizontalArt, LogoStackedArt } from './LogoArt'
import { cx } from './cx'

/**
 * Logo Mummies & Daddies (koncept „sticker pills“): malinová pilulka MUMMIES, modrá DADDIES,
 * mezi nimi mince s ručně psaným ampersandem. Inline SVG (křivky, žádné písmo za běhu).
 *   tone="dark"  = na krémovém / světlém podkladu (ink obrys a stín),
 *   tone="light" = na tmavém podkladu (krémový obrys a stín, patička).
 *   variant="stacked" = dvouřádková verze (patička, velké plochy).
 * Výška: 22 px (18 px s košíkem) pod 380 px, 28 px do sm, 44–48 px na desktopu (aby se při 360 px vešel košík, CTA a menu).
 */
export function Logo({
  tone = 'dark',
  variant = 'horizontal',
  compact = false,
  className,
  onClick,
}: {
  tone?: 'dark' | 'light'
  variant?: 'horizontal' | 'stacked'
  /** Menší logo pod 380 px (když je v mobilní hlavičce i košík). */
  compact?: boolean
  className?: string
  onClick?: () => void
}) {
  const onDark = tone === 'light'
  return (
    <Link
      href="/"
      onClick={onClick}
      aria-label="Mummies & Daddies – úvod"
      className={cx('inline-flex min-h-11 shrink-0 items-center', onDark && 'md-focus-on-dark', className)}
    >
      {variant === 'stacked' ? (
        <LogoStackedArt onDark={onDark} className="h-auto w-[15rem] sm:w-[17rem]" />
      ) : (
        <LogoHorizontalArt
          onDark={onDark}
          className={cx('w-auto min-[380px]:h-[1.75rem] sm:h-9 xl:h-11 2xl:h-12', compact ? 'h-[1.125rem]' : 'h-[1.375rem]')}
        />
      )}
    </Link>
  )
}
