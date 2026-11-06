import Link from 'next/link'
import { LogoHorizontalArt, LogoStackedArt } from './LogoArt'
import { cx } from './cx'

/**
 * Logo Mummies & Daddies (koncept „sticker pills“): malinová pilulka MUMMIES, modrá DADDIES,
 * mezi nimi mince s ručně psaným ampersandem. Inline SVG (křivky, žádné písmo za běhu).
 *   tone="dark"  = na krémovém / světlém podkladu (ink obrys a stín),
 *   tone="light" = na tmavém podkladu (krémový obrys a stín, patička).
 *   variant="stacked" = dvouřádková verze (patička, velké plochy).
 * Výška: 22–27 px v mobilním headeru (aby se vešlo CTA „Nabídka“ a menu při 360 px), 36–40 px na desktopu.
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
        <LogoStackedArt onDark={onDark} className="h-auto w-[15rem] sm:w-[17rem]" />
      ) : (
        <LogoHorizontalArt onDark={onDark} className="h-[1.375rem] w-auto min-[380px]:h-[1.6875rem] sm:h-9 2xl:h-10" />
      )}
    </Link>
  )
}
