import { getSection, getSectionParsed } from '@/lib/web/content'
import { contextInquiryHref } from '@/lib/web/duvera/links'
import { getPhoto } from '@/lib/web/photos'
import type { SurfaceTone } from '@/lib/web/tokens'
import { Button } from '../Button'
import { Cta } from '../Cta'
import { Hero } from '../Hero'
import { PastelCard } from '../PastelCard'
import { PhotoFrame } from '../PhotoFrame'
import { PlaceholderText } from '../PlaceholderText'
import { PriceTag } from '../PriceTag'
import { Section } from '../Section'
import { SectionHeading } from '../SectionHeading'
import { PriceText } from './PriceText'

const P = '/vanoce'
const CHECK_TONES: readonly SurfaceTone[] = ['paper', 'vanilla', 'blush']

export function ChristmasPage() {
  const hero = getSectionParsed(P, 'hero')
  const vecirek = getSection(P, 'vecirek')
  const checklist = getSectionParsed(P, 'checklist')
  const cukrovi = getSectionParsed(P, 'cukrovi')
  const cheesecake = getSectionParsed(P, 'cheesecake')
  const uzaverka = getSection(P, 'uzaverka')
  const cta = getSectionParsed(P, 'cta')

  const partyLink = hero.parsedCta ? { label: hero.parsedCta.label, href: contextInquiryHref(hero.parsedCta.href, { typ: 'vanocni-vecirek', zdroj: P }) } : null
  const finalLink = cta.parsedCta ? { label: cta.parsedCta.label, href: contextInquiryHref(cta.parsedCta.href, { typ: 'vanocni-vecirek', zdroj: P }) } : null
  const cookies = cukrovi.parsedItems.filter((it) => !it.label)
  const cookieFacts = cukrovi.parsedItems.filter((it) => it.label)

  return (
    <>
      <Hero
        size="page"
        tone="blush"
        title={hero.heading}
        lead={hero.body}
        photo={getPhoto('vanoce.hero')}
        primaryCta={partyLink}
        breadcrumbs={[{ label: 'Úvod', href: '/' }, { label: 'Vánoce' }]}
      />

      <Section id="vecirek" labelledBy="vecirek-title">
        <div className="grid gap-10 md:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] md:items-center lg:gap-16">
          <div>
            <h2 id="vecirek-title" className="md-caps text-h2 text-cocoa">
              {vecirek.heading}
            </h2>
            <p className="md-pretty mt-5 text-lead text-cocoa-soft">
              <PriceText text={vecirek.body} />
            </p>
            {partyLink ? (
              <div className="mt-8">
                <Button href={partyLink.href} variant="primary" size="lg" arrow>
                  {partyLink.label}
                </Button>
              </div>
            ) : null}
          </div>
          <PhotoFrame photo={getPhoto('vanoce.gallery', 1)} aspect="portrait" tone="vanilla" sizes="(min-width: 1280px) 460px, (min-width: 768px) 40vw, 100vw" />
        </div>
      </Section>

      <Section tone="sage" soft id="checklist" labelledBy="checklist-title">
        <SectionHeading id="checklist-title" title={checklist.heading} lead={checklist.body} />
        <ol role="list" className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {checklist.parsedItems.map((it, i) => (
            <li key={it.raw}>
              <PastelCard
                eyebrow={String(i + 1).padStart(2, '0')}
                title={it.title ?? it.text}
                description={it.title ? it.text : null}
                tone={CHECK_TONES[i % CHECK_TONES.length]}
              />
            </li>
          ))}
        </ol>
      </Section>

      <Section id="cukrovi" labelledBy="cukrovi-title">
        <div className="grid gap-10 md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] md:items-center lg:gap-16">
          <PhotoFrame photo={getPhoto('vanoce.gallery', 0)} aspect="landscape" tone="blush" sizes="(min-width: 1280px) 480px, (min-width: 768px) 40vw, 100vw" />
          <div>
            <h2 id="cukrovi-title" className="md-caps text-h2 text-cocoa">
              {cukrovi.heading}
            </h2>
            <p className="md-pretty mt-5 text-lead text-cocoa-soft">
              <PlaceholderText text={cukrovi.body} />
            </p>
            <ul role="list" className="mt-6 flex flex-wrap gap-2">
              {cookies.map((it, i) => (
                <li key={it.raw} className={`rounded-pill px-4 py-2 font-copy text-small font-semibold text-cocoa ${['bg-blush', 'bg-sage', 'bg-vanilla'][i % 3]}`}>
                  {it.text}
                </li>
              ))}
            </ul>
            {cookieFacts.map((it) => (
              <p key={it.raw} className="mt-6 flex flex-wrap items-baseline gap-x-2 text-copy text-cocoa">
                <span className="font-semibold">{it.label}:</span>
                <PriceTag text={it.text} />
              </p>
            ))}
          </div>
        </div>
      </Section>

      <Section tone="vanilla" soft id="cheesecake" labelledBy="cheesecake-title">
        <div className="grid gap-10 md:grid-cols-2 md:items-center lg:gap-16">
          <div className="md:order-2">
            <h2 id="cheesecake-title" className="md-caps text-h2 text-cocoa">
              {cheesecake.heading}
            </h2>
            <p className="md-pretty mt-5 text-lead text-cocoa-soft">
              <PriceText text={cheesecake.body} />
            </p>
            {cheesecake.parsedCta?.href ? (
              <div className="mt-8">
                <Button href={cheesecake.parsedCta.href} variant="white" size="lg" arrow>
                  {cheesecake.parsedCta.label}
                </Button>
              </div>
            ) : null}
          </div>
          <PhotoFrame
            photo={getPhoto('cheesecaky.mummy-vanilkovo-pomerancovy-vanocni.main')}
            aspect="square"
            tone="vanilla"
            sizes="(min-width: 1280px) 600px, (min-width: 768px) 48vw, 100vw"
          />
        </div>
      </Section>

      <Section spacing="sm" id="uzaverka" labelledBy="uzaverka-title">
        <div className="rounded-soft bg-paper p-6 shadow-float sm:p-10 md:flex md:items-center md:justify-between md:gap-10">
          <h2 id="uzaverka-title" className="md-caps text-h3 text-cocoa">
            {uzaverka.heading}
          </h2>
          <p className="mt-4 text-lead text-cocoa md:mt-0">
            <PlaceholderText text={uzaverka.body} />
          </p>
        </div>
      </Section>

      {finalLink ? <Cta title={cta.heading} body={cta.body} primary={finalLink} tone="blush" showPhone /> : null}
    </>
  )
}
