import Link from 'next/link'
import type { ComponentProps, ReactNode } from 'react'

// Tlačítka design systému (docs/PROVOZ.md §1, §11): pilulka, výška 40 px
// (44 px na dotyku). `primary` (koral) je hlavní akce obrazovky – nejvýš jedna.
// `secondary` = grafit, `outline` = obrys, `quiet` = jen text, `danger` = nevratné.
// Třídy jsou napsané celé, ať je Tailwind/PostCSS najde ve zdrojácích.
export type ButtonVariant = 'primary' | 'secondary' | 'outline' | 'quiet' | 'danger'
export type ButtonSize = 'sm' | 'md' | 'lg'

const VARIANT: Record<ButtonVariant, string> = {
  primary: 'btn btn-primary',
  secondary: 'btn btn-secondary',
  outline: 'btn btn-outline',
  quiet: 'btn btn-quiet',
  danger: 'btn btn-danger',
}
const SIZE: Record<ButtonSize, string> = { sm: 'btn-sm', md: '', lg: 'btn-lg' }

export function buttonClass(variant: ButtonVariant = 'secondary', size: ButtonSize = 'md', extra = ''): string {
  return [VARIANT[variant], SIZE[size], extra].filter(Boolean).join(' ')
}

type Common = { variant?: ButtonVariant; size?: ButtonSize; icon?: ReactNode; children: ReactNode; className?: string }

/** Odkaz vzhledu tlačítka (navigace na formulář, „Otevřít…“). */
export function ButtonLink({ href, variant = 'outline', size = 'md', icon, children, className = '', ...rest }:
  Common & { href: string } & Omit<ComponentProps<typeof Link>, 'href' | 'className' | 'children'>) {
  return (
    <Link href={href} className={buttonClass(variant, size, className)} {...rest}>
      {icon && <span aria-hidden="true" className="-ml-0.5 inline-flex">{icon}</span>}
      {children}
    </Link>
  )
}

/** Běžné tlačítko (type="button", pokud není řečeno jinak). */
export function Button({ variant = 'outline', size = 'md', icon, children, className = '', type = 'button', ...rest }:
  Common & Omit<ComponentProps<'button'>, 'className' | 'children'>) {
  return (
    <button type={type} className={buttonClass(variant, size, className)} {...rest}>
      {icon && <span aria-hidden="true" className="-ml-0.5 inline-flex">{icon}</span>}
      {children}
    </button>
  )
}
