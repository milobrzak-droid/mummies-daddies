import Link from 'next/link'
import { LogoHorizontalArt, LogoStackedArt } from './LogoArt'
import { cx } from './cx'

/**
 * Logo Mummies & Daddies (koncept „sticker pills“): malinová pilulka MUMMIES, modrá DADDIES,
 * mezi nimi mince s ručně psaným ampersandem. Inline SVG (křivky, žádné písmo za běhu).
 *   tone="dark"  = na krémovém / světlém podkladu (ink obrys a stín),
 *   tone="light" = na tmavém podkladu (krémový obrys a stín, patička).
 *   variant="stacked" = dvouřádková verze (patička, velké plochy).
 * Výška se řídí třídou (h-8 = 32 px v mobilním headeru, h-10 = 40 px na desktopu).
 */
export function Logo({
  tone = 'dark',
  variant = 'horizontal',
  className,
  onClick,
}: {
  tone?: 'dark' | 'light'
  variant?: 'horizontal' | 'stacked'
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
        <LogoStackedArt onDark={onDark} className="h-auto w-[13.75rem] sm:w-[15.5rem]" />
      ) : (
        <LogoHorizontalArt onDark={onDark} className="h-8 w-auto sm:h-9 xl:h-10" />
      )}
    </Link>
  )
}
