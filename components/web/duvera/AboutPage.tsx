import { getSection, getSectionParsed, hasClientPlaceholder, splitDots } from '@/lib/web/content'
import { contextInquiryHref } from '@/lib/web/duvera/links'
import { getPhoto } from '@/lib/web/photos'
import { toneAt, type SurfaceTone } from '@/lib/web/tokens'
import { Button } from '../Button'
import { Cta } from '../Cta'
import { PastelCard } from '../PastelCard'
import { PhotoFrame } from '../PhotoFrame'
import { PlaceholderText } from '../PlaceholderText'
import { Section } from '../Section'
import { SectionHeading } from '../SectionHeading'
import { PlaceholderPanel } from './PlaceholderPanel'
import { SplitHero } from './SplitHero'

const P = '/o-nas'
const VALUE_TONES: readonly SurfaceTone[] = ['blush', 'sage', 'pistachio', 'blush']

/** Fotky lidí podle začátku jména v copy (sloty z výběru fotek). */
const PERSON_PHOTO: readonly [string, string][] = [
  ['Rudolf', 'o-nas.rudolf'],
  ['Bc. Monika', 'o-nas.monika'],
]

export function teamMembers() {
  return getSectionParsed(P, 'tym').parsedItems.map((it) => {
    const slot = it.title ? PERSON_PHOTO.find(([prefix]) => it.title!.startsWith(prefix))?.[1] : undefined
    return { key: it.raw, name: it.title, text: it.text, photo: slot ? getPhoto(slot) : undefined }
  })
}

export function AboutPage() {
  const pribeh = getSection(P, 'pribeh')
  const tym = getSection(P, 'tym')
  const hodnoty = getSectionParsed(P, 'hodnoty')
  const kuchyne = getSection(P, 'kuchyne')
  const cisla = getSection(P, 'cisla')
  const kariera = getSection(P, 'kariera')
  const cta = getSectionParsed(P, 'cta')
  const ctaLink = cta.parsedCta ? { label: cta.parsedCta.label, href: contextInquiryHref(cta.parsedCta.href, { zdroj: P }) } : null
  const people = teamMembers()
  const stats = splitDots(cisla.body)

  return (
    <>
      <SplitHero
        title={pribeh.heading}
        lead={pribeh.body}
        photo={getPhoto('o-nas.hero')}
        breadcrumbs={[{ label: 'Úvod', href: '/' }, { label: 'O nás' }]}
      >
        {ctaLink ? (
          <Button href={ctaLink.href} variant="white" size="lg" arrow>
            {ctaLink.label}
          </Button>
        ) : null}
      </SplitHero>

      <Section id="tym" labelledBy="tym-title">
        <SectionHeading id="tym-title" title={tym.heading} lead={tym.body} />
        <ul role="list" className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3 lg:gap-8">
          {people.map((p, i) => (
            <li key={p.key}>
              {p.name ? (
                <PastelCard
                  title={p.name}
                  description={p.text}
                  photo={p.photo ?? null}
                  aspect="portrait"
                  tone={toneAt(i)}
                  sizes="(min-width: 1280px) 400px, (min-width: 1024px) 31vw, (min-width: 640px) 48vw, 100vw"
                />
              ) : (
                <PlaceholderPanel text={p.text} className="flex h-full min-h-[12rem] items-center justify-center" />
              )}
            </li>
          ))}
        </ul>
      </Section>

      <Section tone="vanilla" soft labelledBy="hodnoty-title">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:items-center lg:gap-16">
          <div>
            <SectionHeading id="hodnoty-title" title={hodnoty.heading} lead={hodnoty.body} className="sm:mb-10" />
            <ul role="list" className="grid gap-4 sm:grid-cols-2">
              {hodnoty.parsedItems.map((it, i) => (
                <li key={it.raw}>
                  <PastelCard title={it.text} tone={VALUE_TONES[i % VALUE_TONES.length]} headingLevel="h3" />
                </li>
              ))}
            </ul>
          </div>
          <PhotoFrame photo={getPhoto('o-nas.team', 0)} aspect="tall" tone="vanilla" sizes="(min-width: 1280px) 460px, (min-width: 1024px) 38vw, 100vw" />
        </div>
      </Section>

      <Section id="kuchyne" labelledBy="kuchyne-title">
        <div className="grid gap-10 md:grid-cols-2 md:items-center lg:gap-16">
          <div>
            <h2 id="kuchyne-title" className="md-caps text-h2 text-cocoa">
              {kuchyne.heading}
            </h2>
            <p className="md-pretty mt-5 text-lead text-cocoa-soft">
              <PlaceholderText text={kuchyne.body} />
            </p>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <PhotoFrame photo={getPhoto('home.kitchen.1')} aspect="square" tone="blush" sizes="(min-width: 1280px) 290px, (min-width: 768px) 24vw, 46vw" />
            <PhotoFrame
              photo={getPhoto('home.cheesecakes.daddy-pistaciovo-malinovy')}
              aspect="square"
              tone="sage"
              sizes="(min-width: 1280px) 290px, (min-width: 768px) 24vw, 46vw"
              className="mt-10"
            />
          </div>
        </div>
      </Section>

      <Section tone="sage" spacing="sm" labelledBy="cisla-title">
        <h2 id="cisla-title" className="font-copy text-eyebrow uppercase text-cocoa-soft">
          {cisla.heading}
        </h2>
        <ul role="list" className="mt-6 grid gap-6 sm:grid-cols-2">
          {stats.map((s) => (
            <li key={s} className={hasClientPlaceholder(s) ? 'text-lead text-cocoa' : 'md-caps text-h2 text-cocoa'}>
              <PlaceholderText text={s} />
            </li>
          ))}
        </ul>
      </Section>

      <Section spacing="sm" labelledBy="kariera-title">
        <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between md:gap-10">
          <h2 id="kariera-title" className="md-caps text-h3 text-cocoa">
            {kariera.heading}
          </h2>
          <p className="text-copy text-cocoa-soft">
            <PlaceholderText text={kariera.body} />
          </p>
        </div>
      </Section>

      {ctaLink ? <Cta title={cta.heading} body={cta.body || null} primary={ctaLink} tone="blush" showPhone /> : null}
    </>
  )
}
