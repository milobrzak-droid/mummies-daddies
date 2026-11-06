import { CATERING_PATH, CATERING_TYPES, FORMAT_PHOTOS } from '@/lib/web/catering'
import { getSection, microcopy, parseCta, parseItem } from '@/lib/web/content'
import { getPhoto } from '@/lib/web/photos'
import { toneAt } from '@/lib/web/tokens'
import { Button } from '../Button'
import { Cta } from '../Cta'
import { PastelCard } from '../PastelCard'
import { PhotoFrame } from '../PhotoFrame'
import { Section } from '../Section'
import { TONE_BG } from '../tones'
import { cx } from '../cx'
import { CheckList, FactsRow, SectionIntro } from './blocks'
import { CateringHero } from './CateringHero'
import { headingId, photoOf, type CateringContext } from './CateringSection'
import { overviewFacts } from './CateringTypePage'
import { contextHref, splitPriceFacts } from './parse'
import { RichText } from './RichText'
import { AccentTitle } from '@/components/web/AccentTitle'

/**
 * Přehled /catering: rozcestník všech služeb s cenou od a minimem osob,
 * malý průvodce formáty servisu, co je v ceně, diety, oblast a CTA.
 */
export function CateringOverview() {
  const sec = (id: string) => getSection(CATERING_PATH, id)
  const uvod = sec('uvod')
  const sluzby = sec('sluzby')
  const formaty = sec('formaty')
  const vCene = sec('v-cene')
  const diety = sec('diety')
  const oblast = sec('oblast')
  const end = sec('cta')
  const ctx: CateringContext = { zdroj: CATERING_PATH, pageTone: 'blush' }
  const endCta = end.cta ? parseCta(end.cta) : null
  const primary = endCta?.href ? { label: endCta.label, href: contextHref(endCta.href, ctx) } : null
  const unsure = { label: microcopy('CTA — sekundární univerzální'), href: contextHref('/poptavka?typ=nevim', ctx) }

  // Popisy karet doslova z mřížky typů akcí na úvodu (stejné karty jako na homepage).
  const homeCards = (getSection('/', 'typy-akci').items ?? []).map(parseItem)

  return (
    <>
      <CateringHero
        title={uvod.heading}
        lead={uvod.body}
        photo={getPhoto('catering.hero')}
        primaryCta={primary}
        breadcrumbs={[{ label: 'Úvod', href: '/' }, { label: 'Catering' }]}
        tone="blush"
      />

      <Section id={sluzby.id} labelledBy={headingId(sluzby.id)} className="-mt-6">
        <SectionIntro id={headingId(sluzby.id)} title={sluzby.heading} body={sluzby.body} />
        <ul className="grid gap-5 sm:grid-cols-2 sm:gap-6 lg:grid-cols-3">
          {CATERING_TYPES.map((t, i) => {
            const facts = overviewFacts(t)
            const home = homeCards.find((c) => c.href === t.path)
            const description = home ? splitPriceFacts(home.text).rest : null
            return (
              <li key={t.slug}>
                <PastelCard
                  title={facts.title}
                  description={description}
                  href={t.path}
                  photo={photoOf(t.card)}
                  photoClassName="max-sm:aspect-[3/2]"
                  tone={toneAt(i)}
                  sizes="(min-width: 1440px) 440px, (min-width: 1024px) 31vw, (min-width: 640px) 48vw, 100vw"
                  meta={<FactsRow price={facts.price} guests={facts.guests} />}
                />
              </li>
            )
          })}
        </ul>
      </Section>

      <Section id={formaty.id} labelledBy={headingId(formaty.id)} tone="paper">
        <SectionIntro id={headingId(formaty.id)} title={formaty.heading} body={formaty.body} />
        <ul className="grid gap-x-12 gap-y-8 md:grid-cols-2">
          {(formaty.items ?? []).map(parseItem).map((it, i) => {
            const slot = FORMAT_PHOTOS.find((f) => f.match.test(it.title ?? it.text))?.slot ?? null
            const photo = slot ? getPhoto(slot) : null
            const hasPhoto = !!photo?.src && !photo.placeholder
            return (
              <li key={i} className="flex items-start gap-5 border-t-2 border-cocoa pt-6">
                {/* Bez fotky žádná ikona v rámečku: jen barevný pruh vlevo (vedle skutečných fotek působí ikona rozbitě). */}
                {hasPhoto ? (
                  <PhotoFrame photo={photo} aspect="square" sticker sizes="112px" tone={toneAt(i)} className="w-20 shrink-0 sm:w-28" />
                ) : (
                  <span aria-hidden="true" className={cx('w-2.5 shrink-0 self-stretch border-2 border-cocoa', TONE_BG[toneAt(i)])} />
                )}
                <div className="min-w-0">
                  <h3 className="md-caps text-h3 text-cocoa">{it.title ?? it.text}</h3>
                  {it.title ? (
                    <p className="md-pretty mt-2 text-copy text-cocoa-soft first-letter:uppercase">
                      <RichText text={it.text} />
                    </p>
                  ) : null}
                </div>
              </li>
            )
          })}
        </ul>
        <div className="mt-10">
          <Button href={unsure.href} variant="ghost" className="!whitespace-normal text-left">
            {unsure.label}
          </Button>
        </div>
      </Section>

      <Section id={vCene.id} labelledBy={headingId(vCene.id)}>
        <div className="grid gap-10 lg:grid-cols-[1fr_1.2fr] lg:gap-16">
          <SectionIntro id={headingId(vCene.id)} title={vCene.heading} body={vCene.body} className="mb-0 sm:mb-0" />
          <CheckList items={vCene.items ?? []} columns={2} className="self-center" />
        </div>
      </Section>

      <Section spacing="sm" className="pb-section">
        <div className="grid gap-5 sm:gap-6 md:grid-cols-2">
          {[diety, oblast].map((s, i) => (
            <section key={s.id} id={s.id} aria-labelledby={headingId(s.id)} className={cx('rounded-sticker border-2 border-cocoa p-6 shadow-hard sm:p-10', i === 0 ? 'bg-daddy-tint' : 'bg-butter')}>
              <h2 id={headingId(s.id)} className="md-caps text-h2 text-cocoa"><AccentTitle title={s.heading} /></h2>
              <p className="md-pretty mt-5 text-copy text-cocoa-soft">
                <RichText text={s.body} />
              </p>
            </section>
          ))}
        </div>
      </Section>

      {primary ? <Cta title={end.heading} body={end.body} primary={primary} tone="sage" showPhone /> : null}
    </>
  )
}
