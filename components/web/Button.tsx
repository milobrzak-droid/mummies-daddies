import Link from 'next/link'
import type { ComponentPropsWithoutRef, ReactNode } from 'react'
import { IconArrowRight } from './icons'
import { cx } from './cx'

/**
 * Oválné (pill) tlačítko / odkaz.
 *   primary  – malinové, bílý text (hlavní CTA mimo fotku). Kontrast 5,3 : 1.
 *   white    – bílý ovál s kakaovým textem (CTA na fotce / pastelu, jako v referenci).
 *   outline  – kakaový obrys (sekundární akce).
 *   ghost    – textový odkaz s šipkou (sekundární odkaz „Prohlédnout menu a ceny“).
 * S `href` vykreslí <Link> (interní) / <a> (tel:, mailto:, https:), jinak <button>.
 */
export type ButtonVariant = 'primary' | 'white' | 'outline' | 'ghost'
export type ButtonSize = 'sm' | 'md' | 'lg'

const BASE =
  'inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-pill font-copy font-semibold tracking-[0.01em] ' +
  'transition-[background-color,color,box-shadow,transform] duration-quick ease-md-out motion-safe:active:scale-[0.98] ' +
  'disabled:cursor-not-allowed disabled:opacity-60'

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'bg-raspberry-ink text-paper shadow-[0_10px_24px_-14px_rgba(168,42,81,0.8)] hover:bg-raspberry-deep',
  white: 'bg-paper text-cocoa ring-1 ring-cocoa/10 shadow-[0_10px_28px_-16px_rgba(59,36,24,0.55)] hover:bg-raspberry-ink hover:text-paper hover:ring-transparent',
  outline: 'bg-transparent text-cocoa ring-1 ring-inset ring-cocoa/70 hover:bg-cocoa hover:text-cream',
  ghost: 'bg-transparent text-cocoa underline decoration-raspberry decoration-1 underline-offset-[0.3em] hover:decoration-2 hover:text-raspberry-ink',
}

const SIZE: Record<ButtonSize, string> = {
  sm: 'min-h-10 px-4 text-small',
  md: 'min-h-12 px-6 text-copy',
  lg: 'min-h-14 px-8 text-[1.0625rem]',
}
const GHOST_SIZE: Record<ButtonSize, string> = { sm: 'min-h-10 text-small', md: 'min-h-12 text-copy', lg: 'min-h-12 text-[1.0625rem]' }

type Common = {
  variant?: ButtonVariant
  size?: ButtonSize
  /** Šipka za textem (u ghost výchozí). */
  arrow?: boolean
  icon?: ReactNode
  fullWidth?: boolean
  className?: string
  children: ReactNode
}

type AsLink = Common & { href: string } & Omit<ComponentPropsWithoutRef<'a'>, 'href' | 'className' | 'children'>
type AsButton = Common & { href?: undefined } & Omit<ComponentPropsWithoutRef<'button'>, 'className' | 'children'>

export function buttonClasses({ variant = 'primary', size = 'md', fullWidth, className }: Pick<Common, 'variant' | 'size' | 'fullWidth' | 'className'> = {}) {
  return cx(BASE, VARIANT[variant], variant === 'ghost' ? GHOST_SIZE[size] : SIZE[size], fullWidth && 'w-full', className)
}

export function Button(props: AsLink | AsButton) {
  const { variant = 'primary', size = 'md', arrow, icon, fullWidth, className, children, ...rest } = props
  const cls = buttonClasses({ variant, size, fullWidth, className })
  const showArrow = arrow ?? variant === 'ghost'
  const inner = (
    <>
      {icon}
      <span>{children}</span>
      {showArrow ? <IconArrowRight size={18} className="motion-safe:transition-transform motion-safe:group-hover:translate-x-0.5" /> : null}
    </>
  )
  if ('href' in rest && typeof rest.href === 'string') {
    const { href, ...a } = rest as AsLink
    const external = /^(https?:|tel:|mailto:)/.test(href)
    if (external) {
      const blank = href.startsWith('http')
      return (
        <a href={href} className={cx('group', cls)} {...(blank ? { target: '_blank', rel: 'noopener noreferrer' } : {})} {...a}>
          {inner}
        </a>
      )
    }
    return (
      <Link href={href} className={cx('group', cls)} {...a}>
        {inner}
      </Link>
    )
  }
  const { type = 'button', ...b } = rest as AsButton
  return (
    <button type={type} className={cx('group', cls)} {...b}>
      {inner}
    </button>
  )
}
