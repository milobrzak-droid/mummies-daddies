import { Breadcrumbs, Button, IconPhone, PlaceholderText, Section } from '@/components/web'
import { ContactPanel, ContactPersonCard, QuickStartForm, SocialList } from '@/components/web/uvod'
import { pageMetadata } from '@/lib/web/content'
import { billingData, peopleData, premisesData, primaryActions, quickInquiryData, socialsData } from '@/lib/web/uvod/kontakt'
import { AccentTitle } from '@/components/web/AccentTitle'

/**
 * /kontakt (strategy.sitemap): lidé s telefony a e-maily, rychlá poptávka,
 * fakturační údaje, provozovna (doplní klient) a sociální sítě.
 * Hlavní CTA „Zavolat / Poptat“ je hned pod nadpisem.
 */
export const metadata = pageMetadata('/kontakt')

export default function ContactPage() {
  const people = peopleData()
  const actions = primaryActions()
  const quick = quickInquiryData()
  const billing = billingData()
  const premises = premisesData()
  const socials = socialsData()

  return (
    <>
      <Section tone="blush" soft labelledBy="kontakt-title" className="pb-section-sm pt-10 sm:pt-14">
        <Breadcrumbs items={[{ label: 'Úvod', href: '/' }, { label: 'Kontakt' }]} className="mb-8" />
        <div className="grid gap-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-16">
          <div className="motion-safe:animate-lift">
            <h1 id="kontakt-title" className="md-caps text-h1 text-cocoa"><AccentTitle title={people.heading} /></h1>
            {people.lead ? (
              <p className="md-pretty mt-5 max-w-xl text-lead text-cocoa">
                <PlaceholderText text={people.lead} />
              </p>
            ) : null}
            <div className="mt-8 flex flex-col items-start gap-3 sm:flex-row sm:items-center sm:gap-4">
              {actions.call ? (
                <Button href={actions.call.href} variant="primary" size="lg" icon={<IconPhone size={20} />}>
                  {actions.call.label}
                </Button>
              ) : null}
              {actions.ask ? (
                <Button href={actions.ask.href} variant="white" size="lg" arrow>
                  {actions.ask.label}
                </Button>
              ) : null}
            </div>
          </div>
          <h2 className="sr-only">Kontakty</h2>
          <ul role="list" className="grid gap-5 sm:grid-cols-2">
            {people.people.map((p, i) => (
              <li key={p.name}>
                <ContactPersonCard name={p.name} lines={p.lines} tone={i % 2 ? 'vanilla' : 'sage'} />
              </li>
            ))}
          </ul>
        </div>
      </Section>

      <Section tone="cream">
        <div className="grid gap-6 lg:grid-cols-2 lg:gap-8">
          <ContactPanel id="rychla-poptavka" heading={quick.heading} body={quick.body} className="shadow-float lg:row-span-2">
            <QuickStartForm labels={quick.labels} options={quick.options} source="/kontakt" idPrefix="kontakt-poptavka" layout="stack" />
          </ContactPanel>

          <ContactPanel id="fakturace" heading={billing.heading} body={billing.body} tone="vanilla">
            <address className="space-y-1 text-copy not-italic text-cocoa">
              {billing.lines.map((l, i) => (
                <p key={l} className={i === 0 ? 'font-bold' : undefined}>
                  {l}
                </p>
              ))}
            </address>
          </ContactPanel>

          <ContactPanel id="provozovna" heading={premises.heading} body={premises.body} tone="sage" />

          <ContactPanel id="site" heading={socials.heading} body={socials.body} tone="blush" className="lg:col-span-2">
            <SocialList items={socials.items} />
          </ContactPanel>
        </div>
      </Section>
    </>
  )
}
