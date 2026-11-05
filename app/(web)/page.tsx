import { Button, Faq, Hero, Section, SectionHeading } from '@/components/web'
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
  cheesecakeProductsLd,
  cheesecakesData,
  eventGridData,
  faqData,
  finalInquiryData,
  heroData,
  howItWorksData,
  kitchenData,
  quickStartData,
  referencesData,
  teamData,
  venuesData,
  whyUsData,
} from '@/lib/web/uvod/home'

/**
 * Úvodní stránka přesně podle strategy.homepage:
 * hero (vlastní raut) → rychlý start → mřížka typů akcí → proč my → reference
 * → z naší kuchyně → jak to funguje → prostory → cheesecaky (doplněk) → tým
 * → FAQ → závěrečná poptávka. Horní lištu, header a patičku kreslí layout.
 */
export const metadata = pageMetadata('/')

export default function HomePage() {
  const faq = faqData()
  const cheesecakes = cheesecakesData()
  const productsLd = cheesecakeProductsLd(cheesecakes.products)

  return (
    <>
      <Hero {...heroData()} tone="blush" size="home" />
      <QuickStartCard {...quickStartData()} source="/" />
      <EventTypeGrid {...eventGridData()} />
      <WhyUs {...whyUsData()} />
      <References {...referencesData()} />
      <Kitchen {...kitchenData()} />
      <HowItWorks {...howItWorksData()} />
      <Venues {...venuesData()} />
      <CheesecakeTeaser {...cheesecakes} />
      <Team {...teamData()} />

      <Section id="faq" tone="cream" labelledBy="faq-title">
        <div className="grid gap-8 lg:grid-cols-[minmax(0,4fr)_minmax(0,7fr)] lg:gap-16">
          <SectionHeading
            id="faq-title"
            title={faq.heading}
            lead={faq.lead}
            action={faq.cta ? <Button href={faq.cta.href} variant="ghost">{faq.cta.label}</Button> : undefined}
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
