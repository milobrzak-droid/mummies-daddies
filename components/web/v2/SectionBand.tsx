import type { ReactNode } from 'react'
import { AccentTitle, type AccentTone } from '../AccentTitle'
import { Container } from '../Container'
import { PlaceholderText } from '../PlaceholderText'
import { cx } from '../cx'

/**
 * Pruh nadpisu sekce (docs/web-v2-design.md §5.6): buňka přes celou šířku v tintu
 * (blue = světle modrá Daddy jako pruh v referenci, rasp = růžová Mummy, cream),
 * 2px ink linky nahoře i dole. Vlevo obří Anton h2 s jedním akcentovým slovem,
 * vpravo perex (zarovnaný vlevo, spodní řádek na účaří nadpisu) a pod ním akce. Na mobilu vše pod sebou.
 */
export type BandTone = 'blue' | 'rasp' | 'cream' | 'paper'

const BG: Record<BandTone, string> = {
  blue: 'bg-daddy-tint',
  rasp: 'bg-raspberry-tint',
  cream: 'bg-cream',
  paper: 'bg-paper',
}

export function SectionBand({
  id,
  title,
  accent,
  accentTone,
  titleNode,
  lead,
  action,
  tone = 'blue',
  as: Tag = 'h2',
  className,
}: {
  /** id nadpisu (pro aria-labelledby sekce). */
  id: string
  title: string
  accent?: string | false
  accentTone?: AccentTone
  /** Vlastní obsah titulku (např. dvě akcentová slova MUMMY & DADDY); text musí odpovídat `title`. */
  titleNode?: ReactNode
  lead?: string | null
  action?: ReactNode
  tone?: BandTone
  as?: 'h1' | 'h2'
  className?: string
}) {
  return (
    <div className={cx('border-y-2 border-cocoa', BG[tone], className)}>
      <Container width="wide" className="grid gap-5 py-[clamp(2rem,1.4rem+2.5vw,3.5rem)] lg:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)] lg:items-end lg:gap-12">
        <Tag id={id} className={cx('md-caps text-cocoa', Tag === 'h1' ? 'text-h1' : 'text-h2')}>
          {titleNode ?? <AccentTitle title={title} accent={accent} tone={accentTone} />}
        </Tag>
        {lead || action ? (
          <div className="flex flex-col items-start gap-5 lg:pb-[0.35em]">
            {lead ? (
              <p className="md-pretty max-w-[40ch] text-lead text-cocoa-soft max-lg:max-w-[46ch]">
                <PlaceholderText text={lead} />
              </p>
            ) : null}
            {action}
          </div>
        ) : null}
      </Container>
    </div>
  )
}
