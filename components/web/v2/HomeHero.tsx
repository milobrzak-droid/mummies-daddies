import type { HeroCta } from '../Hero'
import { AccentTitle } from '../AccentTitle'
import { Button } from '../Button'
import { Container } from '../Container'
import { PlaceholderText } from '../PlaceholderText'
import { FloatingCutout } from './FloatingCutout'
import { FloatingTag } from './FloatingTag'

/**
 * Hero úvodu (docs/web-v2-design.md §5.5): obří Anton nadpis na středu s jedním malinovým
 * slovem, kolem něj „levitující“ výřezy cheesecaků a jídla bez pozadí, natočené jako
 * v referenci. Pod nadpisem perex, dvě pilulková CTA a mikrodůvěra.
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
  id = 'hero-title',
}: {
  title: string
  lead?: string | null
  primaryCta?: HeroCta | null
  secondaryCta?: HeroCta | null
  trust?: string | null
  /** Krátký fakt ve štítku nad nadpisem (mobil), např. „Vaříme od roku 2018“. */
  badge?: string | null
  id?: string
}) {
  return (
    <section aria-labelledby={id} className="relative isolate overflow-x-clip bg-cream">
      {/* Výřezy (absolutně vůči sekci). Pořadí: LCP výřez první. */}
      <FloatingCutout
        slug="cheesecake-pistaciovo-malinovy"
        preload
        rotate={10}
        sizes="(min-width: 1024px) 16vw, 36vw"
        className="absolute -right-[7%] top-3 z-0 w-[38%] max-w-[17rem] sm:w-[30%] lg:right-[3%] lg:top-[6%] lg:w-[16%] lg:max-w-none"
      />
      <FloatingCutout
        slug="cheesecake-cokoladovo-liskooriskovy"
        rotate={-12}
        delay={-1.7}
        sizes="16vw"
        className="absolute left-[3%] top-[7%] z-0 hidden w-[15%] lg:block"
      />
      <FloatingCutout slug="avokado-plnene" rotate={8} delay={-3.1} sizes="14vw" className="absolute bottom-[7%] left-[5%] z-0 hidden w-[13%] max-w-[22rem] lg:block" />
      <FloatingCutout slug="mini-cheesecake-kosicek" rotate={-10} delay={-2.4} sizes="140px" className="absolute right-[21%] top-[5%] z-0 hidden w-[6%] max-w-[8.75rem] xl:block" />

      <Container width="wide" className="relative z-10 flex flex-col pb-10 pt-6 sm:pt-10 lg:min-h-[min(calc(100svh-7.5rem),54rem)] lg:items-center lg:justify-center lg:py-20 lg:text-center">
        {badge ? (
          <p className="mb-[22vw] sm:mb-28 lg:mb-6">
            <FloatingTag tone="vanilla" rotate={-4} float={false}>
              {badge}
            </FloatingTag>
          </p>
        ) : null}
        <h1 id={id} className="md-caps max-w-[16ch] text-mega text-cocoa lg:mx-auto lg:max-w-[13ch]">
          <AccentTitle title={title} accent="nezapomíná" />
        </h1>
        {lead ? (
          <p className="md-pretty mt-6 max-w-[46ch] text-lead text-cocoa lg:mx-auto">
            <PlaceholderText text={lead} />
          </p>
        ) : null}
        {primaryCta || secondaryCta ? (
          <div className="mt-8 flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-center lg:justify-center">
            {primaryCta ? (
              <Button href={primaryCta.href} variant="primary" size="lg" arrow>
                {primaryCta.label}
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
          <p className="mt-6 max-w-[52ch] text-small font-medium text-cocoa-soft lg:mx-auto">
            <PlaceholderText text={trust} />
          </p>
        ) : null}

        {/* Mobil: dva výřezy v řadě pod tlačítky; od lg plují v rozích hero. */}
        <div className="mt-8 flex items-end justify-around gap-6 lg:contents">
          <FloatingCutout
            slug="mini-cheesecake-cokoladovy"
            rotate={-8}
            delay={-2.2}
            sizes="(min-width: 1024px) 12vw, 34vw"
            className="w-[34%] max-w-[11rem] lg:absolute lg:bottom-[6%] lg:right-[6%] lg:w-[11%] lg:max-w-none"
          />
          <FloatingCutout
            slug="cupcake-malina-boruvka"
            rotate={7}
            delay={-0.9}
            sizes="(min-width: 1024px) 7vw, 24vw"
            className="w-[24%] max-w-[7.5rem] lg:absolute lg:bottom-[9%] lg:left-[22%] lg:w-[6%] lg:max-w-none"
          />
        </div>
      </Container>
    </section>
  )
}
