import Link from 'next/link'
import type { ComponentPropsWithoutRef, ReactNode } from 'react'
import { IconArrowRight } from './icons'
import { cx } from './cx'

/**
 * Pilulkové tlačítko / odkaz v neo-brutalist stylu reference: 2.5px ink obrys,
 * tvrdý offset stín 4px, na hover se zvedne (stín 6px), na stisk „zamáčkne“ do stínu.
 *   primary   – malina (rasp-ink), krémový text: hlavní akce („Chci nabídku“). 5,3 : 1.
 *   secondary – modrá Daddy (blue-ink), krémový text: druhá plná akce. 6,6 : 1.
 *   white     – papírová pilulka s ink textem (CTA na fotce / tintu). Hover = máslová.
 *   outline   – krémová pilulka s ink textem (sekundární akce). Hover = máslová.
 *   ghost     – textový odkaz s malinovým podtržením a šipkou.
 * S `href` vykreslí <Link> (interní) / <a> (tel:, mailto:, https:), jinak <button>.
 */
export type ButtonVariant = 'primary' | 'secondary' | 'white' | 'outline' | 'ghost'
export type ButtonSize = 'sm' | 'md' | 'lg'

// Na mobilu se dlouhé CTA („Nabídka pro firmu do 1 pracovního dne“) zalomí; text-center
// a balance drží oba řádky vystředěné a podobně dlouhé.
const BASE =
  'inline-flex max-w-full items-center justify-center gap-2 whitespace-nowrap max-sm:whitespace-normal text-center [text-wrap:balance] rounded-pill font-copy font-bold leading-tight ' +
  'disabled:cursor-not-allowed disabled:border-cocoa/40 disabled:bg-[#E6DACB] disabled:text-cocoa-soft disabled:shadow-none disabled:transform-none'

const SOLID = 'md-press border-[2.5px] border-cocoa shadow-hard max-sm:py-2'

const VARIANT: Record<ButtonVariant, string> = {
  primary: `${SOLID} bg-raspberry-ink text-cream hover:bg-raspberry-deep`,
  secondary: `${SOLID} bg-daddy-ink text-cream hover:bg-daddy-deep`,
  white: `${SOLID} bg-paper text-cocoa hover:bg-butter`,
  outline: `${SOLID} bg-cream text-cocoa hover:bg-butter`,
  ghost:
    'bg-transparent text-cocoa underline decoration-raspberry decoration-2 underline-offset-[0.3em] transition-[text-decoration-color,text-decoration-thickness] duration-quick hover:decoration-raspberry-ink hover:decoration-[3px]',
}

const SIZE: Record<ButtonSize, string> = {
  sm: 'min-h-11 px-4 text-small',
  md: 'min-h-12 px-6 text-copy',
  lg: 'min-h-[3.25rem] px-7 text-[1.0625rem]',
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
  const arrowIcon = <IconArrowRight size={18} className="shrink-0 motion-safe:transition-transform motion-safe:group-hover:translate-x-1" />
  // Textový odkaz (ghost) se na mobilu může zalomit: šipka je pak v řádku za posledním slovem
  // (nezlomitelná mezera), ne osamocená u pravého okraje.
  const inner =
    variant === 'ghost' && showArrow ? (
      <>
        {icon}
        <span>
          {children}
          {/* U+2060 (word joiner) brání zalomení před šipkou; inline-block šipka nedědí podtržení. */}
          <span className="whitespace-nowrap">
            {'\u2060'}
            <span className="ml-2 inline-block align-[-0.2em]">{arrowIcon}</span>
          </span>
        </span>
      </>
    ) : (
      <>
        {icon}
        <span>{children}</span>
        {showArrow ? arrowIcon : null}
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
