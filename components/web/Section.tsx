import type { ReactNode } from 'react'
import type { SurfaceTone } from '@/lib/web/tokens'
import { Container } from './Container'
import { cx } from './cx'
import { TONE_BG, TONE_BG_SOFT } from './tones'

/**
 * Sekce stránky se svislým rytmem (py-section) a kontejnerem.
 * tone = pozadí (výchozí bez pozadí = krémová stránky), soft = světlejší varianta tónu.
 * Web v2 = jeden rám: každá sekce začíná 2px ink linkou (rule=false ji vypne).
 */
export function Section({
  id,
  tone,
  soft = false,
  spacing = 'default',
  width = 'default',
  labelledBy,
  rule = true,
  className,
  containerClassName,
  children,
}: {
  id?: string
  tone?: SurfaceTone
  soft?: boolean
  spacing?: 'default' | 'sm' | 'none'
  width?: 'default' | 'wide' | 'prose'
  /** id nadpisu sekce (aria-labelledby). */
  labelledBy?: string
  /** 2px ink linka nad sekcí (rámovaný layout). */
  rule?: boolean
  className?: string
  containerClassName?: string
  children: ReactNode
}) {
  const bg = tone ? (soft ? TONE_BG_SOFT[tone] : TONE_BG[tone]) : undefined
  const py = spacing === 'default' ? 'py-section' : spacing === 'sm' ? 'py-section-sm' : undefined
  return (
    <section id={id} aria-labelledby={labelledBy} className={cx(bg, py, rule && 'border-t-2 border-cocoa', className)}>
      <Container width={width} className={containerClassName}>
        {children}
      </Container>
    </section>
  )
}
