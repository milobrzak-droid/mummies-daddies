import type { HeroCta } from '../Hero'
import { AccentTitle } from '../AccentTitle'
import { Button } from '../Button'
import { Container } from '../Container'
import { PlaceholderText } from '../PlaceholderText'
import type { Photo } from '@/lib/web/photos'
import { FloatingCutout } from './FloatingCutout'
import { FloatingPlate } from './FloatingPlate'
import { FloatingTag } from './FloatingTag'

/**
 * Hero úvodu (docs/web-v2-design.md §5.5): obří Anton nadpis na středu s jedním malinovým
 * slovem, kolem něj „levitující“ výřezy a kruhové talíře cateringových jídel (catering-first)
 * a dva cheesecaky, natočené jako v referenci. Na 1440×900 se vejde i s CTA a mikrodůvěrou. Pod nadpisem perex, dvě pilulková CTA a mikrodůvěra.
 * Mobil: nadpis vlevo, jeden výřez vpravo nahoře přes okraj, dva pod tlačítky v řadě.
 * LCP: jen výřez vpravo nahoře má preload, ostatní se načítají líně; všechny mají pevné rozměry.
 * Výřezy jsou dekorace (aria-hidden), informaci nesou texty.
 */
export function HomeHero({
  title,
  lead,
  primaryCta,
  secondaryCta,
  trust,
  badge,
  plates = [],
  id = 'hero-title',
}: {
  title: string
  lead?: string | null
  primaryCta?: HeroCta | null
  secondaryCta?: HeroCta | null
  trust?: string | null
  /** Krátký fakt ve štítku nad nadpisem (mobil), např. „Vaříme od roku 2018“. */
  badge?: string | null
  /** Fotky cateringových jídel do kruhových „talířů“ (catering-first: nejen cheesecaky). */
  plates?: (Photo | null)[]
  id?: string
}) {
  const [plateA, plateB] = plates
  // „Chci nabídku do 1 pracovního dne“: na mobilu jen „Chci nabídku“ (jeden řádek), dovětek od sm.
  const ctaMatch = primaryCta ? /^(Chci nabídku)(\s.+)$/.exec(primaryCta.label) : null
  return (
    <section aria-labelledby={id} className="relative isolate overflow-x-clip bg-cream">
      {/* Výřezy (absolutně vůči sekci). Pořadí: LCP výřez první. */}
      <FloatingCutout
        slug="cheesecake-pistaciovo-malinovy"
        preload
        rotate={10}
        sizes="(min-width: 1024px) 16vw, 28vw"
        className="absolute -right-[5%] top-2 z-0 w-[28vw] max-w-[13rem] sm:w-[24%] lg:right-[3%] lg:top-[6%] lg:w-[15%] lg:max-w-none"
      />
      <FloatingPlate photo={plateA ?? null} rotate={-8} delay={-1.7} sizes="(min-width: 1440px) 220px, 15vw" className="absolute left-[3.5%] top-[8%] z-0 hidden w-[14%] max-w-[15rem] lg:block" />
      <FloatingCutout slug="avokado-plnene" rotate={8} delay={-3.1} sizes="14vw" className="absolute bottom-[7%] left-[4%] z-0 hidden w-[12%] max-w-[22rem] lg:block" />
      <FloatingPlate photo={plateB ?? null} rotate={6} delay={-2.4} sizes="140px" className="absolute right-[20%] top-[4%] z-0 hidden w-[7.5%] max-w-[8.75rem] xl:block" />

      <Container width="wide" className="relative z-10 flex flex-col pb-10 pt-5 sm:pt-10 lg:min-h-[min(calc(100svh-7.5rem),48rem)] lg:items-center lg:justify-center lg:pb-14 lg:pt-10 lg:text-center">
        {badge ? (
          <p className="mb-[13vw] sm:mb-24 lg:mb-6">
            <FloatingTag tone="vanilla" rotate={-4} float={false}>
              {badge}
            </FloatingTag>
          </p>
        ) : null}
        <h1 id={id} className="md-caps max-w-[16ch] text-mega text-cocoa lg:mx-auto lg:max-w-[13ch] lg:text-[clamp(3.25rem,1.4rem+6vw,7rem)] lg:leading-[1.18]">
          <AccentTitle title={title} accent="nezapomíná" />
        </h1>
        {lead ? (
          <p className="md-pretty mt-5 max-w-[46ch] text-lead text-cocoa lg:mx-auto">
            <PlaceholderText text={lead} />
          </p>
        ) : null}
        {primaryCta || secondaryCta ? (
          <div className="mt-7 flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-center lg:justify-center">
            {primaryCta ? (
              <Button href={primaryCta.href} variant="primary" size="lg" arrow>
                {ctaMatch ? (
                  <>
                    {ctaMatch[1]}
                    <span className="max-sm:hidden">{ctaMatch[2]}</span>
                  </>
                ) : (
                  primaryCta.label
                )}
              </Button>
            ) : null}
            {secondaryCta ? (
              <Button href={secondaryCta.href} variant="outline" size="lg">
                {secondaryCta.label}
              </Button>
            ) : null}
          </div>
        ) : null}
        {trust ? (
          <p className="mt-5 max-w-[52ch] text-small font-medium text-cocoa-soft lg:mx-auto">
            <PlaceholderText text={trust} />
          </p>
        ) : null}

        {/* Mobil: talíř a výřez v řadě pod tlačítky; od lg plují v rozích hero. */}
        <div className="mt-8 flex items-end justify-around gap-6 lg:contents">
          <FloatingCutout
            slug="mini-cheesecake-cokoladovy"
            rotate={-8}
            delay={-2.2}
            sizes="(min-width: 1024px) 12vw, 30vw"
            className="w-[30%] max-w-[10rem] lg:absolute lg:bottom-[6%] lg:right-[5%] lg:w-[10%] lg:max-w-none"
          />
          <FloatingPlate photo={plateA ?? null} rotate={6} delay={-0.9} sizes="34vw" className="w-[34%] max-w-[11rem] lg:hidden" />
        </div>
      </Container>
    </section>
  )
}
