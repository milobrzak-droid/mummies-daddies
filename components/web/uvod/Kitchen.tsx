import type { Photo } from '@/lib/web/photos'
import { Button } from '../Button'
import { Container } from '../Container'
import { PhotoFrame } from '../PhotoFrame'
import { SectionHeading } from '../SectionHeading'
import { cx } from '../cx'

/**
 * „Z naší kuchyně“ (docs §6, sekce 9): modrá plocha, vlevo nadpis a seznam signature jídel
 * v orámovaných řádcích, vpravo galerie 6 fotek jako natočené „samolepky“.
 *
 * Fotky a seznam jídel se zatím NEPÁRUJÍ: dnešní fotky (pick home.kitchen.1–6)
 * ukazují jiná jídla, než copy jmenuje (krkovice, chobotnice… chybí, viz
 * pick.missing). Popisek pod fotkou by tak tvrdil nepravdu. Jakmile dorazí
 * signature fotky, stačí `paired` → popisek = položka copy pod každou fotkou.
 */
const TILT = ['-rotate-3', 'rotate-2', '-rotate-1', 'rotate-3', '-rotate-2', 'rotate-1']

export function Kitchen({
  heading,
  lead,
  dishes,
  photos,
  cta,
  paired = false,
  id = 'z-kuchyne',
}: {
  heading: string
  lead?: string | null
  dishes: string[]
  photos: Photo[]
  cta?: { label: string; href: string } | null
  paired?: boolean
  id?: string
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="border-t-2 border-cocoa bg-daddy-tint py-section">
      <Container width="wide" className="grid gap-12 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-16">
        <div className="lg:sticky lg:top-[calc(theme(spacing.header)+2rem)] lg:self-start">
          <SectionHeading id={`${id}-title`} title={heading} accent="kuchyně" lead={lead} className="sm:mb-8" />
          {!paired ? (
            <ul role="list" className="divide-y-2 divide-cocoa border-y-2 border-cocoa">
              {dishes.map((d) => (
                <li key={d} className="flex items-baseline gap-3 py-3.5 font-copy text-[1.0625rem] font-bold leading-snug text-cocoa">
                  <span aria-hidden="true" className="h-2.5 w-2.5 shrink-0 translate-y-[-0.1em] rounded-pill border-2 border-cocoa bg-raspberry" />
                  {d}
                </li>
              ))}
            </ul>
          ) : null}
          {cta ? (
            <p className="mt-8">
              <Button href={cta.href} variant="white" arrow>
                {cta.label}
              </Button>
            </p>
          ) : null}
        </div>
        <ul role="list" className="grid grid-cols-2 content-start gap-5 sm:gap-7 md:grid-cols-3 md:pb-8">
          {photos.map((p, i) => (
            <li key={`${p.slot}-${i}`} className={cx(i % 3 === 1 && 'md:translate-y-10')}>
              <figure className={cx('motion-safe:transition-transform motion-safe:duration-base hover:rotate-0', TILT[i % TILT.length])}>
                <PhotoFrame photo={p} aspect="square" sticker sizes="(min-width: 1440px) 260px, (min-width: 768px) 20vw, 44vw" tone={i % 2 ? 'blush' : 'vanilla'} />
                {paired && dishes[i] ? <figcaption className="mt-3 text-small font-bold text-cocoa">{dishes[i]}</figcaption> : null}
              </figure>
            </li>
          ))}
        </ul>
      </Container>
    </section>
  )
}
