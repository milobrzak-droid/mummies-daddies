import type { ReactNode } from 'react'
import type { PhotoRef, SectionConfig } from '@/lib/web/catering'
import { parseCta, parseItem, type SectionCopy } from '@/lib/web/content'
import type { EventType, CustomerKind } from '@/lib/web/options'
import { getPhoto, getPhotos } from '@/lib/web/photos'
import { toneAt, type PastelTone, type SurfaceTone } from '@/lib/web/tokens'
import { Button } from '../Button'
import { Container } from '../Container'
import { Faq, faqFromItems } from '../Faq'
import { PastelCard } from '../PastelCard'
import { PhotoFrame } from '../PhotoFrame'
import { Section } from '../Section'
import { cx } from '../cx'
import { aspectFor, CheckList, ChipList, FormatCard, MenuCard, PackageGrid, PhotoGrid, SectionIntro, Steps } from './blocks'
import { contextHref } from './parse'

export interface CateringContext {
  /** Typ akce pro průvodce poptávkou (doplní se do odkazů na /poptavka). */
  typ?: EventType
  segment?: CustomerKind
  /** Cesta stránky (zdroj v poptávce). */
  zdroj: string
  pageTone: PastelTone
}

export const headingId = (sectionId: string) => `${sectionId}-title`

export function photoOf(ref: PhotoRef) {
  return getPhoto(ref.slot, ref.index ?? 0)
}

/** CTA sekce („Text → /cesta“) jako tlačítko; na poptávku malinové s kontextem. */
export function SectionCta({ raw, ctx, className }: { raw: string | undefined; ctx: CateringContext; className?: string }) {
  if (!raw) return null
  const cta = parseCta(raw)
  if (!cta.href) return null
  const inquiry = cta.href.startsWith('/poptavka')
  return (
    <div className={cx('mt-8', className)}>
      <Button href={inquiry ? contextHref(cta.href, ctx) : cta.href} variant={inquiry ? 'primary' : 'outline'} arrow>
        {cta.label}
      </Button>
    </div>
  )
}

/** Text (a obsah) vedle fotky; bez fotky jen text v užším sloupci. */
function Split({ section, photo, reverse, ctx, children }: { section: SectionCopy; photo?: PhotoRef; reverse?: boolean; ctx: CateringContext; children?: ReactNode }) {
  const p = photo ? photoOf(photo) : null
  const hasPhoto = !!p && !p.placeholder
  const text = (
    <div className={cx(!hasPhoto && 'max-w-3xl')}>
      <SectionIntro id={headingId(section.id)} title={section.heading} body={section.body} className={children ? undefined : 'mb-0 sm:mb-0'} />
      {children}
      <SectionCta raw={section.cta} ctx={ctx} />
    </div>
  )
  if (!hasPhoto) return text
  const aspect = aspectFor(p, 'portrait')
  return (
    <div className="grid items-center gap-10 md:grid-cols-2 md:gap-14 lg:gap-20">
      <div className={cx(reverse && 'md:order-2')}>
        <PhotoFrame
          photo={p}
          aspect={aspect === 'landscape' ? 'landscape' : aspect}
          sizes="(min-width: 1280px) 560px, (min-width: 768px) 45vw, 100vw"
          tone={ctx.pageTone}
          className={cx(aspect === 'portrait' && 'mx-auto max-w-md md:max-w-none')}
        />
      </div>
      <div className={cx(reverse && 'md:order-1')}>{text}</div>
    </div>
  )
}

/** Jedna sekce z copy.json podle konfigurace (lib/web/catering). */
export function CateringSection({ section, layout, ctx, tone, soft }: { section: SectionCopy; layout: SectionConfig; ctx: CateringContext; tone?: SurfaceTone; soft?: boolean }) {
  const id = headingId(section.id)
  const items = section.items ?? []
  const wrap = (children: ReactNode, opts: { width?: 'default' | 'wide' | 'prose' } = {}) => (
    <Section id={section.id} labelledBy={id} tone={tone} soft={soft} width={opts.width}>
      {children}
    </Section>
  )

  switch (layout.kind) {
    case 'chips':
      return wrap(
        <Split section={section} ctx={ctx}>
          <ChipList items={items} />
        </Split>,
      )
    case 'checklist':
      return wrap(
        <Split section={section} photo={layout.photo} ctx={ctx}>
          <CheckList items={items} columns={layout.photo ? 1 : 2} />
        </Split>,
      )
    case 'feature':
      return wrap(
        <Split section={section} photo={layout.photo} reverse={layout.reverse} ctx={ctx}>
          {items.length ? <CheckList items={items} /> : null}
        </Split>,
      )
    case 'text':
      return wrap(<Split section={section} ctx={ctx} />)
    case 'packages':
      return wrap(
        <>
          <SectionIntro id={id} title={section.heading} body={section.body} />
          <PackageGrid items={items} />
          <SectionCta raw={section.cta} ctx={ctx} />
        </>,
      )
    case 'menu':
      return wrap(
        <>
          <SectionIntro id={id} title={section.heading} body={items.length ? section.body : null} align="center" />
          <MenuCard items={items} fallback={items.length ? null : section.body} />
          <SectionCta raw={section.cta} ctx={ctx} className="text-center" />
        </>,
      )
    case 'steps':
      return wrap(
        <>
          <SectionIntro id={id} title={section.heading} body={section.body} />
          <Steps items={items} />
          <SectionCta raw={section.cta} ctx={ctx} />
        </>,
      )
    case 'faq':
      return wrap(
        <div className="grid gap-10 lg:grid-cols-[1fr_1.6fr] lg:gap-16">
          <SectionIntro id={id} title={section.heading} body={section.body} className="mb-0 sm:mb-0" />
          <Faq items={faqFromItems(items)} />
        </div>,
      )
    case 'gallery':
      return wrap(
        <>
          <SectionIntro id={id} title={section.heading} body={section.body} />
          <PhotoGrid photos={getPhotos(layout.slot)} />
        </>,
      )
    case 'links': {
      const links = items.map(parseItem).filter((it) => it.href)
      return wrap(
        <>
          <SectionIntro id={id} title={section.heading} body={section.body} />
          <ul className="grid gap-5 sm:grid-cols-2 sm:gap-6 lg:max-w-5xl">
            {links.map((it, i) => (
              <li key={it.href}>
                <PastelCard
                  title={it.text}
                  href={it.href!}
                  photo={layout.photos[i] ? photoOf(layout.photos[i]) : undefined}
                  aspect="landscape"
                  sizes="(min-width: 1024px) 480px, (min-width: 640px) 50vw, 100vw"
                  tone={toneAt(i)}
                />
              </li>
            ))}
          </ul>
          <SectionCta raw={section.cta} ctx={ctx} />
        </>,
      )
    }
    case 'format':
      // Skupinu vykresluje FormatGroup (sousední sekce); samostatně jako jedna karta.
      return <FormatGroup sections={[section]} tone={tone} soft={soft} />
  }
}

/** Sousední krátké sekce (bufet, banket, sharing table) jako mřížka karet. */
export function FormatGroup({ sections, tone, soft }: { sections: SectionCopy[]; tone?: SurfaceTone; soft?: boolean }) {
  return (
    <Section tone={tone} soft={soft}>
      <ul className={cx('grid gap-5 sm:gap-6', sections.length > 1 && 'md:grid-cols-2', sections.length > 2 && 'lg:grid-cols-3')}>
        {sections.map((s, i) => (
          <li key={s.id} id={s.id}>
            <FormatCard id={headingId(s.id)} title={s.heading} body={s.body} tone={toneAt(i)} />
          </li>
        ))}
      </ul>
    </Section>
  )
}

/** Pás fotek mezi sekcemi (bez nadpisu; fotky mají vlastní alt). */
export function PhotoBand({ photos }: { photos: PhotoRef[] }) {
  return (
    <div className="py-section-sm">
      <Container>
        <PhotoGrid photos={photos.map(photoOf)} />
      </Container>
    </div>
  )
}
