import Link from 'next/link'
import { COMPANY } from '@/lib/web/company'
import { IconChevronRight } from './icons'
import { cx } from './cx'

export interface BreadcrumbItem {
  label: string
  /** Bez href = aktuální stránka (poslední položka). */
  href?: string
}

/**
 * Drobečková navigace + JSON-LD BreadcrumbList (SEO).
 * Úvod přidej jako první položku: [{ label: 'Úvod', href: '/' }, { label: 'Catering', href: '/catering' }, { label: 'Svatby' }]
 */
export function Breadcrumbs({ items, jsonLd = true, className }: { items: BreadcrumbItem[]; jsonLd?: boolean; className?: string }) {
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: items.map((it, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: it.label,
      ...(it.href ? { item: `${COMPANY.siteUrl}${it.href === '/' ? '' : it.href}` } : {}),
    })),
  }
  return (
    <nav aria-label="Drobečková navigace" className={cx('font-copy text-small', className)}>
      <ol className="flex flex-wrap items-center gap-x-1.5 gap-y-0 text-cocoa-soft">
        {items.map((it, i) => {
          const last = i === items.length - 1
          return (
            <li key={`${it.label}-${i}`} className="inline-flex items-center gap-1.5">
              {it.href && !last ? (
                <Link href={it.href} className="inline-flex min-h-11 items-center underline-offset-4 hover:text-cocoa hover:underline">
                  {it.label}
                </Link>
              ) : (
                <span aria-current={last ? 'page' : undefined} className={cx(last && 'font-semibold text-cocoa')}>
                  {it.label}
                </span>
              )}
              {!last ? <IconChevronRight size={14} className="opacity-60" /> : null}
            </li>
          )
        })}
      </ol>
      {jsonLd ? <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(ld).replace(/</g, '\\u003c') }} /> : null}
    </nav>
  )
}
