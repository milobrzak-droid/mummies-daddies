import type { ReactNode } from 'react'
import { AccentTitle, type AccentTone } from './AccentTitle'
import { PlaceholderText } from './PlaceholderText'
import { cx } from './cx'

/**
 * Nadpis sekce: nadtitulek (eyebrow, štítek s malinovou tečkou), titulek Antonem verzálkami
 * s jedním akcentovým slovem (AccentTitle) a perex. `action` = odkaz vpravo (desktop).
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
  accent,
  accentTone,
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
  /** Akcentové slovo (podřetězec titulku); výchozí auto u h1/h2, false = bez akcentu. */
  accent?: string | false
  accentTone?: AccentTone
  className?: string
}) {
  const s = size ?? Tag
  const titleSize = { hero: 'text-hero', h1: 'text-h1', h2: 'text-h2', h3: 'text-h3' }[s]
  const accentValue = accent === undefined && s === 'h3' ? false : accent
  const center = align === 'center'
  return (
    <div className={cx('mb-10 flex flex-col gap-6 sm:mb-14', !center && !!action && 'md:flex-row md:items-end md:justify-between', className)}>
      <div className={cx('max-w-4xl', center && 'mx-auto text-center')}>
        {eyebrow ? (
          <p className={cx('mb-4 flex items-center gap-2 font-copy text-eyebrow uppercase text-cocoa', center && 'justify-center')}>
            <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 rounded-pill border-2 border-cocoa bg-raspberry" />
            <span>
              <PlaceholderText text={eyebrow} />
            </span>
          </p>
        ) : null}
        <Tag id={id} className={cx('md-caps text-cocoa', titleSize)}>
          <AccentTitle title={title} accent={accentValue} tone={accentTone} />
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
