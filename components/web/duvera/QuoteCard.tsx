import type { SurfaceTone } from '@/lib/web/tokens'
import { PlaceholderText } from '../PlaceholderText'
import { cx } from '../cx'
import { TONE_BG } from '../tones'

/**
 * Citace klienta / hodnocení. Dokud citace chybí, ukáže zástupce z copy.
 * Velké uvozovky jsou jen dekorace (aria-hidden).
 */
export function QuoteCard({
  heading,
  text,
  id,
  tone = 'blush',
  headingLevel: H = 'h2',
  className,
}: {
  heading: string
  text: string
  id: string
  tone?: SurfaceTone
  headingLevel?: 'h2' | 'h3'
  className?: string
}) {
  return (
    <figure aria-labelledby={id} className={cx('relative rounded-frame px-6 pb-10 pt-10 sm:px-12', TONE_BG[tone], className)}>
      <span aria-hidden="true" className="pointer-events-none absolute right-6 top-0 font-display text-[6rem] leading-none text-cocoa/20 sm:right-10">
        „
      </span>
      <H id={id} className="md-caps text-h3 text-cocoa">
        {heading}
      </H>
      <blockquote className="mt-5 font-display text-[1.5rem] italic leading-snug text-cocoa sm:text-[1.75rem]">
        <p className="md-pretty">
          <PlaceholderText text={text} />
        </p>
      </blockquote>
    </figure>
  )
}
