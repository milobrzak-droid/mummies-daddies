import Link from 'next/link'
import type { ReactNode } from 'react'

// Karta design systému (docs/PROVOZ.md §5): bílý povrch, hrana 1 px,
// stín úrovně 1, zaoblení 22 px. Hlavička: nadpis (Title 2), jedna věta
// kontextu, vpravo štítek a kulatá šipka „otevřít celý seznam“.
export const CARD = 'rounded-card border border-border bg-surface shadow-card'
export const CARD_PAD = 'p-5 sm:p-6'

export function Card({
  title, sub, badge, href, hrefLabel, actions, children, className = '', as: Tag = 'section', id, headingLevel = 2,
}: {
  title?: string
  sub?: ReactNode
  badge?: ReactNode
  href?: string
  hrefLabel?: string
  /** Akce v hlavičce (tlačítko, přepínač) – nejvýš jedna nebo dvě. */
  actions?: ReactNode
  children: ReactNode
  className?: string
  as?: 'section' | 'div' | 'article'
  id?: string
  headingLevel?: 2 | 3
}) {
  const H = headingLevel === 3 ? 'h3' : 'h2'
  return (
    <Tag id={id} className={`${CARD} ${CARD_PAD} ${className}`}>
      {title && (
        <div className="mb-4 flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <H className="m-0 font-heading text-title2 font-bold">{title}</H>
            {sub && <p className="m-0 mt-0.5 text-callout text-muted">{sub}</p>}
          </div>
          {badge}
          {actions}
          {href && <CardLink href={href} label={hrefLabel ?? title} />}
        </div>
      )}
      {children}
    </Tag>
  )
}

/** Kulatá šipka ↗ v hlavičce karty: otevře celý seznam (cíl 44 × 44 px). */
export function CardLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      aria-label={label}
      title={label}
      className="-mr-1.5 -mt-1.5 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[color:var(--c-slate)] no-underline transition-colors duration-fast hover:bg-[color:var(--c-soft)] hover:text-ink"
    >
      <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M7 17 17 7M8 7h9v9" /></svg>
    </Link>
  )
}
