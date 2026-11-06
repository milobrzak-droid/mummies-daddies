import { getSection, getSectionParsed } from '@/lib/web/content'
import { contextInquiryHref } from '@/lib/web/duvera/links'
import { venueFor } from '@/lib/web/duvera/venues'
import { inquiryHref } from '@/lib/web/inquiry-link'
import { HEADER_CTA } from '@/lib/web/navigation'
import { getPhoto } from '@/lib/web/photos'
import { toneAt } from '@/lib/web/tokens'
import { Button } from '../Button'
import { Cta } from '../Cta'
import { Hero } from '../Hero'
import { PastelCard } from '../PastelCard'
import { PhotoFrame } from '../PhotoFrame'
import { PlaceholderText } from '../PlaceholderText'
import { Section } from '../Section'
import { SectionHeading } from '../SectionHeading'
import { AccentTitle } from '@/components/web/AccentTitle'

const P = '/prostory'

/** Karty prostorů z copy („Název — popis“) + slug pro poptávku a fotka. */
export function venueCards() {
  return getSectionParsed(P, 'prostory').parsedItems.map((it) => {
    const name = it.title ?? it.text
    const cfg = venueFor(name)
    return {
      name,
      text: it.title ? it.text : '',
      slug: cfg?.slug ?? null,
      confirmed: cfg?.confirmed ?? false,
      photo: cfg?.photoSlot ? getPhoto(cfg.photoSlot) : null,
    }
  })
}

export function VenuesPage() {
  const uvod = getSection(P, 'uvod')
  const prostory = getSection(P, 'prostory')
  const pomuzeme = getSection(P, 'pomuzeme')
  const cta = getSectionParsed(P, 'cta')
  const ctaLabel = cta.parsedCta?.label ?? HEADER_CTA.label
  const cards = venueCards()

  return (
    <>
      <Hero
        size="page"
        tone="sage"
        title={uvod.heading}
        lead={uvod.body}
        photo={getPhoto('prostory.hero')}
        secondaryCta={{ label: prostory.heading, href: '#nase-prostory' }}
        breadcrumbs={[{ label: 'Úvod', href: '/' }, { label: 'Prostory' }]}
      />

      <Section id="nase-prostory" labelledBy="nase-prostory-title">
        <SectionHeading id="nase-prostory-title" title={prostory.heading} lead={prostory.body} />
        <ul role="list" className="grid gap-6 md:grid-cols-2 lg:gap-8">
          {cards.map((v, i) => (
            <li key={v.name}>
              <PastelCard
                title={v.name}
                description={v.text || null}
                photo={v.photo}
                aspect="landscape"
                tone={toneAt(i, ['sage', 'blush', 'vanilla', 'pistachio'])}
                sizes="(min-width: 1280px) 600px, (min-width: 768px) 48vw, 100vw"
              >
                {v.confirmed && v.slug ? (
                  <div className="mt-auto pt-6">
                    <Button href={inquiryHref({ prostor: v.slug, zdroj: P })} variant="white" arrow aria-label={`${ctaLabel}: ${v.name}`}>
                      {ctaLabel}
                    </Button>
                  </div>
                ) : null}
              </PastelCard>
            </li>
          ))}
        </ul>
      </Section>

      <Section tone="blush" soft labelledBy="pomuzeme-title">
        <div className="grid gap-10 md:grid-cols-2 md:items-center lg:gap-16">
          <div>
            <h2 id="pomuzeme-title" className="md-caps text-h2 text-cocoa"><AccentTitle title={pomuzeme.heading} /></h2>
            <p className="md-pretty mt-5 text-lead text-cocoa-soft">
              <PlaceholderText text={pomuzeme.body} />
            </p>
            <div className="mt-8">
              <Button href={inquiryHref({ zdroj: P })} variant="primary" size="lg" arrow>
                {HEADER_CTA.label}
              </Button>
            </div>
          </div>
          <PhotoFrame photo={getPhoto('prostory.gallery')} aspect="landscape" tone="blush" sizes="(min-width: 1280px) 600px, (min-width: 768px) 48vw, 100vw" />
        </div>
      </Section>

      <Cta title={cta.heading} body={cta.body || null} primary={{ label: ctaLabel, href: contextInquiryHref(cta.parsedCta?.href, { zdroj: P }) }} showPhone />
    </>
  )
}
