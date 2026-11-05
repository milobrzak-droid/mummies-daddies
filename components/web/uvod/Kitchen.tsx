import type { Photo } from '@/lib/web/photos'
import { Button } from '../Button'
import { PhotoFrame } from '../PhotoFrame'
import { Section } from '../Section'
import { SectionHeading } from '../SectionHeading'
import { cx } from '../cx'

/**
 * „Z naší kuchyně“: jídlo jako hrdina podruhé. Vlevo text a seznam signature
 * jídel (copy), vpravo galerie 6 čtvercových fotek.
 *
 * Fotky a seznam jídel se zatím NEPÁRUJÍ: dnešní fotky (pick home.kitchen.1–6)
 * ukazují jiná jídla, než copy jmenuje (krkovice, chobotnice… chybí, viz
 * pick.missing). Popisek pod fotkou by tak tvrdil nepravdu. Jakmile dorazí
 * signature fotky, stačí `paired` → popisek = položka copy pod každou fotkou.
 */
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
    <Section id={id} tone="cream" labelledBy={`${id}-title`}>
      <div className="grid gap-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-16">
        <div className="lg:sticky lg:top-[calc(theme(spacing.header)+2rem)] lg:self-start">
          <SectionHeading id={`${id}-title`} title={heading} lead={lead} className="sm:mb-8" />
          {!paired ? (
            <ul role="list" className="divide-y divide-hairline border-y border-hairline">
              {dishes.map((d) => (
                <li key={d} className="py-3.5 font-display text-[1.375rem] font-medium leading-snug text-cocoa">
                  {d}
                </li>
              ))}
            </ul>
          ) : null}
          {cta ? (
            <p className="mt-8">
              <Button href={cta.href} variant="outline">
                {cta.label}
              </Button>
            </p>
          ) : null}
        </div>
        <ul role="list" className="grid grid-cols-2 content-start gap-3 sm:gap-4 md:grid-cols-3 md:pb-8">
          {photos.map((p, i) => (
            <li key={`${p.slot}-${i}`} className={cx(i % 3 === 1 && 'md:translate-y-8')}>
              <figure>
                <PhotoFrame photo={p} aspect="square" sizes="(min-width: 1280px) 240px, (min-width: 768px) 20vw, 46vw" tone={i % 2 ? 'sage' : 'blush'} />
                {paired && dishes[i] ? <figcaption className="mt-3 text-small font-semibold text-cocoa">{dishes[i]}</figcaption> : null}
              </figure>
            </li>
          ))}
        </ul>
      </div>
    </Section>
  )
}
