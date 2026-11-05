import type { SurfaceTone } from '@/lib/web/tokens'
import { COMPANY } from '@/lib/web/company'
import { Button } from './Button'
import { Container } from './Container'
import { IconPhone } from './icons'
import { PlaceholderText } from './PlaceholderText'
import { cx } from './cx'
import { TONE_BG } from './tones'

export interface CtaLink {
  label: string
  href: string
}

/**
 * CTA pruh na konec stránky / mezi sekce: velký titulek, text, hlavní tlačítko
 * (malinové) + sekundární odkaz a volitelně telefon na člověka.
 * Hlavní CTA má vést na /poptavka s kontextem (inquiryHref z lib/web/inquiry-link).
 */
export function Cta({
  title,
  body,
  primary,
  secondary,
  tone = 'sage',
  showPhone = false,
  id,
  className,
}: {
  title: string
  body?: string | null
  primary: CtaLink
  secondary?: CtaLink | null
  tone?: SurfaceTone
  /** Přidá řádek „nebo zavolejte +420 737 818 694“. */
  showPhone?: boolean
  id?: string
  className?: string
}) {
  const headingId = id ?? 'cta-title'
  return (
    <section aria-labelledby={headingId} className={cx(TONE_BG[tone], 'py-section-sm', className)}>
      <Container className="grid items-center gap-8 md:grid-cols-[1.4fr_1fr] md:gap-12">
        <div>
          <h2 id={headingId} className="md-caps text-h2 text-cocoa">
            {title}
          </h2>
          {body ? (
            <p className="md-pretty mt-4 max-w-2xl text-lead text-cocoa-soft">
              <PlaceholderText text={body} />
            </p>
          ) : null}
        </div>
        <div className="flex flex-col items-start gap-4 md:items-end">
          <Button href={primary.href} variant="primary" size="lg" arrow>
            {primary.label}
          </Button>
          {secondary ? (
            <Button href={secondary.href} variant="ghost">
              {secondary.label}
            </Button>
          ) : null}
          {showPhone ? (
            <a href={COMPANY.phoneHref} className="inline-flex min-h-11 items-center gap-2 font-copy text-small font-semibold text-cocoa hover:underline">
              <IconPhone size={18} /> nebo zavolejte {COMPANY.phone}
            </a>
          ) : null}
        </div>
      </Container>
    </section>
  )
}
