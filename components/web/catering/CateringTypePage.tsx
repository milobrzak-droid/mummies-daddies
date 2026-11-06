import type { ReactNode } from 'react'
import { CATERING_PATH, getCateringType, type CateringSlug, type CateringTypeConfig } from '@/lib/web/catering'
import { getPage, getSection, parseCta, parseItem, type SectionCopy } from '@/lib/web/content'
import type { SurfaceTone } from '@/lib/web/tokens'
import type { BreadcrumbItem } from '../Breadcrumbs'
import { Button } from '../Button'
import { Container } from '../Container'
import { Cta } from '../Cta'
import { cx } from '../cx'
import { FactsRow } from './blocks'
import { CateringHero, isWidePhoto } from './CateringHero'
import { CateringSection, FormatGroup, PhotoBand, photoOf, type CateringContext } from './CateringSection'
import { contextHref, splitCtas, splitPriceFacts } from './parse'

/**
 * Sdílená šablona stránky typu akce (/catering/<slug>):
 *   hero → karta s cenou od a minimem osob (z přehledu /catering) → sekce z copy.json
 *   v jejich pořadí (vzhled podle lib/web/catering) → závěrečné CTA do průvodce
 *   poptávkou předvyplněné typem akce a zdrojem.
 */
export function CateringTypePage({ slug }: { slug: CateringSlug }) {
  const cfg = getCateringType(slug)
  const page = getPage(cfg.path)
  const ctx: CateringContext = { typ: cfg.eventType, segment: cfg.segment, zdroj: cfg.path, pageTone: cfg.tone }
  const hero = page.sections.find((s) => s.id === 'hero')
  const end = page.sections.find((s) => s.id === 'cta')
  const body = page.sections.filter((s) => s.id !== 'hero' && s.id !== 'cta')
  const breadcrumbs: BreadcrumbItem[] = [
    { label: 'Úvod', href: '/' },
    { label: 'Catering', href: CATERING_PATH },
    { label: cfg.breadcrumb },
  ]
  const heroPhoto = photoOf(cfg.hero)
  const heroCta = hero?.cta ? parseCta(hero.cta) : null
  const endCtas = splitCtas(end?.cta).map(parseCta).filter((c) => c.href)

  return (
    <>
      <CateringHero
        title={hero?.heading ?? page.metaTitle}
        lead={hero?.body}
        photo={heroPhoto}
        primaryCta={heroCta?.href ? { label: heroCta.label, href: contextHref(heroCta.href, ctx) } : null}
        breadcrumbs={breadcrumbs}
        tone={cfg.tone}
      />
      <QuickFacts cfg={cfg} overlap={isWidePhoto(heroPhoto) ? 'photo' : 'pastel'} />
      {renderSections(body, cfg, ctx)}
      {end && endCtas[0] ? (
        <Cta
          title={end.heading}
          body={end.body}
          primary={{ label: endCtas[0].label, href: contextHref(endCtas[0].href!, ctx) }}
          secondary={endCtas[1] ? { label: endCtas[1].label, href: contextHref(endCtas[1].href!, ctx) } : null}
          tone={cfg.ctaTone}
          showPhone
        />
      ) : null}
    </>
  )
}

/** Sekce v pořadí copy.json, střídání pozadí, skupiny krátkých formátů a pásy fotek. */
function renderSections(sections: SectionCopy[], cfg: CateringTypeConfig, ctx: CateringContext): ReactNode[] {
  const out: ReactNode[] = []
  let i = 0
  let alt = 0
  while (i < sections.length) {
    const s = sections[i]
    const layout = cfg.sections[s.id] ?? { kind: 'text' as const }
    const tone: SurfaceTone | undefined = layout.tone ?? (alt % 2 === 1 ? 'paper' : undefined)
    if (layout.kind === 'format') {
      const group: SectionCopy[] = []
      while (i < sections.length && cfg.sections[sections[i].id]?.kind === 'format') group.push(sections[i++])
      out.push(<FormatGroup key={group[0].id} sections={group} tone={tone} soft={layout.soft} />)
    } else {
      out.push(<CateringSection key={s.id} section={s} layout={layout} ctx={ctx} tone={tone} soft={layout.soft} />)
      i++
    }
    alt++
    const band = cfg.bands?.find((b) => b.after === s.id)
    if (band) out.push(<PhotoBand key={`band-${s.id}`} photos={band.photos} />)
  }
  return out
}

/** Položka přehledu /catering › sluzby pro typ akce („Firemní catering — od … Kč/os. · od 4 osob“). */
export function overviewFacts(cfg: CateringTypeConfig) {
  const item = (getSection(CATERING_PATH, 'sluzby').items ?? []).map(parseItem).find((it) => it.title === cfg.overviewTitle)
  if (!item) throw new Error(`catering: v /catering › sluzby chybí „${cfg.overviewTitle}“`)
  return { title: item.title!, ...splitPriceFacts(item.text) }
}

/** Karta pod hero: orientační cena za osobu a minimum osob (doslova z přehledu služeb). */
function QuickFacts({ cfg, overlap }: { cfg: CateringTypeConfig; overlap: 'photo' | 'pastel' }) {
  const facts = overviewFacts(cfg)
  const back = parseItem(getSection('/', 'hero').items?.find((raw) => raw.startsWith('Sekundární odkaz:')) ?? '')
  return (
    <div className={cx('relative z-20', overlap === 'photo' ? '-mt-10 sm:-mt-12' : '-mt-12')}>
      <Container>
        <div className="flex flex-col gap-4 rounded-soft bg-paper px-5 py-5 shadow-float ring-2 ring-cocoa sm:flex-row sm:flex-wrap sm:items-center sm:justify-between sm:gap-x-8 sm:px-8 motion-safe:animate-lift">
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-center sm:gap-x-6">
            <p className="font-copy text-eyebrow uppercase text-cocoa-soft">{facts.title}</p>
            <FactsRow price={facts.price} guests={facts.guests} size="lg" />
          </div>
          {back.label === 'Sekundární odkaz' && back.href ? (
            <Button href={back.href} variant="ghost" size="sm" className="self-start sm:self-auto">
              {back.text}
            </Button>
          ) : null}
        </div>
      </Container>
    </div>
  )
}
