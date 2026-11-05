import type { ReactNode } from 'react'
import { PlaceholderText } from './PlaceholderText'
import { cx } from './cx'

/**
 * Nadpis sekce: nadtitulek (eyebrow), titulek verzálkami (serif, prostrkaný)
 * a perex. `action` = odkaz vpravo (desktop), např. „Všechny reference →“.
 */
export function SectionHeading({
  eyebrow,
  title,
  lead,
  as: Tag = 'h2',
  id,
  align = 'left',
  size,
  action,
  className,
}: {
  eyebrow?: string
  title: string
  lead?: string | null
  as?: 'h1' | 'h2' | 'h3'
  /** id nadpisu (pro aria-labelledby sekce). */
  id?: string
  align?: 'left' | 'center'
  /** Velikost titulku; výchozí podle úrovně (h1 → h1, h2 → h2, h3 → h3). */
  size?: 'hero' | 'h1' | 'h2' | 'h3'
  action?: ReactNode
  className?: string
}) {
  const s = size ?? Tag
  const titleSize = { hero: 'text-hero', h1: 'text-h1', h2: 'text-h2', h3: 'text-h3' }[s]
  const center = align === 'center'
  return (
    <div className={cx('mb-10 flex flex-col gap-6 sm:mb-14', !center && !!action && 'md:flex-row md:items-end md:justify-between', className)}>
      <div className={cx('max-w-3xl', center && 'mx-auto text-center')}>
        {eyebrow ? (
          <p className="mb-4 font-copy text-eyebrow uppercase text-cocoa-soft">
            <PlaceholderText text={eyebrow} />
          </p>
        ) : null}
        <Tag id={id} className={cx('md-caps text-cocoa', titleSize)}>
          {title}
        </Tag>
        {lead ? (
          <p className={cx('md-pretty mt-5 text-lead text-cocoa-soft', center && 'mx-auto max-w-2xl')}>
            <PlaceholderText text={lead} />
          </p>
        ) : null}
      </div>
      {action ? <div className={cx('shrink-0', center && 'mx-auto')}>{action}</div> : null}
    </div>
  )
}
