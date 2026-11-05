import Link from 'next/link'
import type { ReactNode } from 'react'

// Záhlaví stránky – první část anatomie každé obrazovky (docs/PROVOZ.md §11):
// zpět (u detailu) → nadtitulek (sekce, Fira Mono) → nadpis (Display) → jedna
// věta kontextu; vpravo nejvýš jedna hlavní akce a 1–2 sekundární.
// Na mobilu jdou akce pod nadpis a zalamují se, nikdy nepřetékají.
export function PageHeader({
  title,
  eyebrow,
  subtitle,
  back,
  children,
}: {
  title: string
  eyebrow?: string
  subtitle?: ReactNode
  /** Zpětný odkaz na nadřazený seznam (detail, formulář): žádné slepé uličky. */
  back?: { href: string; label: string }
  /** kept for source-compat; no longer renders a decorative accent tail */
  accent?: string
  children?: ReactNode
}) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
      <div className="min-w-0 max-w-3xl">
        {back && (
          <Link
            href={back.href}
            className="-ml-1 mb-2 inline-flex min-h-[32px] items-center gap-1 rounded-full px-1 text-callout font-semibold text-muted no-underline hover:text-ink"
          >
            <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m15 18-6-6 6-6" /></svg>
            {back.label}
          </Link>
        )}
        {eyebrow && <p className="eyebrow mb-2">{eyebrow}</p>}
        <h1 className="m-0 font-heading text-[28px] leading-[1.08] md:text-display">{title}</h1>
        {subtitle && <p className="m-0 mt-2 max-w-2xl text-body text-muted">{subtitle}</p>}
      </div>
      {children && <div className="flex flex-wrap items-center gap-2 pb-0.5">{children}</div>}
    </header>
  )
}
