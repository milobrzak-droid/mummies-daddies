import { Button, Faq, Section, SectionHeading } from '@/components/web'
import { BigMarquee } from '@/components/web/v2/BigMarquee'
import { FormatsSection } from '@/components/web/v2/FormatsSection'
import { HomeHero } from '@/components/web/v2/HomeHero'
import {
  CheesecakeTeaser,
  EventTypeGrid,
  FinalInquiry,
  HowItWorks,
  Kitchen,
  QuickStartCard,
  References,
  Team,
  Venues,
  WhyUs,
} from '@/components/web/uvod'
import { pageMetadata } from '@/lib/web/content'
import {
  cheesecakeExplorerData,
  cheesecakeProductsLd,
  cheesecakesData,
  eventGridData,
  faqData,
  finalInquiryData,
  formatsData,
  heroData,
  marqueeData,
  howItWorksData,
  kitchenData,
  quickStartData,
  referencesData,
  teamData,
  venuesData,
  whyUsData,
} from '@/lib/web/uvod/home'

/**
 * Úvodní stránka web v2 (docs/web-v2-design.md §6), catering-first:
 * hero s levitujícími výřezy → rychlý start → typy akcí (mřížka) → formáty (seznam + produkt)
 * → obří pruh CATERING • CHEESECAKY → proč my → reference → z naší kuchyně → jak to funguje
 * → cheesecaky Mummy & Daddy → prostory → tým → FAQ → závěrečná poptávka.
 * Horní lištu, header a patičku kreslí layout. Texty doslova z copy (lib/web/uvod/home).
 */
export const metadata = pageMetadata('/')

export default function HomePage() {
  const faq = faqData()
  const cheesecakes = cheesecakesData()
  const productsLd = cheesecakeProductsLd(cheesecakes.products)

  return (
    <>
      <HomeHero {...heroData()} badge="Catering · Praha i celá ČR" />
      <QuickStartCard {...quickStartData()} source="/" />
      <EventTypeGrid {...eventGridData()} />
      <FormatsSection {...formatsData()} />
      <BigMarquee {...marqueeData()} />
      <WhyUs {...whyUsData()} />
      <References {...referencesData()} />
      <Kitchen {...kitchenData()} />
      <HowItWorks {...howItWorksData()} />
      <CheesecakeTeaser {...cheesecakes} flavors={cheesecakeExplorerData()} />
      <Venues {...venuesData()} />
      <Team {...teamData()} />

      <Section id="faq" tone="cream" width="wide" labelledBy="faq-title">
        <div className="grid gap-8 lg:grid-cols-[minmax(0,4fr)_minmax(0,7fr)] lg:gap-16">
          <SectionHeading
            id="faq-title"
            title={faq.heading}
            lead={faq.lead}
            accent="otázky"
            action={faq.cta ? <Button href={faq.cta.href} variant="outline" arrow>{faq.cta.label}</Button> : undefined}
            className="md:!flex-col md:!items-start md:!justify-start"
          />
          <Faq items={faq.items} />
        </div>
      </Section>

      <FinalInquiry {...finalInquiryData()} />

      {productsLd ? (
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(productsLd).replace(/</g, '\\u003c') }} />
      ) : null}
    </>
  )
}
