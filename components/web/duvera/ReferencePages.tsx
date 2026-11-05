import { getSection, getSectionParsed, parseItem, splitDots, splitPlaceholders } from '@/lib/web/content'
import { contextInquiryHref, slugify } from '@/lib/web/duvera/links'
import { REFERENCE_CASES, referenceCase, referenceSlugFromHref } from '@/lib/web/duvera/references'
import { getPhoto } from '@/lib/web/photos'
import { toneAt } from '@/lib/web/tokens'
import { Breadcrumbs } from '../Breadcrumbs'
import { Cta } from '../Cta'
import { Hero } from '../Hero'
import { PastelCard } from '../PastelCard'
import { PlaceholderText } from '../PlaceholderText'
import { Section } from '../Section'
import { SectionHeading } from '../SectionHeading'
import { FactList } from './FactList'
import { FilterGrid, type FilterItem } from './FilterGrid'
import { Gallery } from './Gallery'
import { QuoteCard } from './QuoteCard'

const LIST_PATH = '/reference'

/** Filtr z copy („Filtr: Vše · Firemní · Svatby · Oslavy“) → legenda, „vše“ a možnosti. */
export function referenceFilter() {
  const it = parseItem(getSection(LIST_PATH, 'pripadovky').body)
  const [all, ...rest] = splitDots(it.text)
  return { legend: it.label ?? '', allLabel: all, options: rest.map((label) => ({ value: slugify(label), label })) }
}

/** Karta případovky z položky copy („Svatby · Jitka & Rostislav, Klášterec nad Ohří → /reference/…“). */
export function referenceCards() {
  return getSectionParsed(LIST_PATH, 'pripadovky').parsedItems.map((it) => {
    const [tag, ...rest] = splitDots(it.text)
    const name = rest.join(' · ')
    const parts = splitPlaceholders(name)
    const title = parts.filter((p) => !p.placeholder).map((p) => p.text).join('').trim()
    const pending = parts.filter((p) => p.placeholder).map((p) => p.text).join(' ')
    const slug = referenceSlugFromHref(it.href)
    const c = slug ? referenceCase(slug) : undefined
    const summary = c ? getSection(c.path, 'shrnuti').body : null
    return {
      key: slug ?? slugify(title),
      tag,
      title,
      description: summary ?? (pending || null),
      href: c ? c.path : undefined,
      photo: c ? getPhoto(c.coverSlot) : null,
    }
  })
}

export function ReferenceListPage() {
  const uvod = getSection(LIST_PATH, 'uvod')
  const loga = getSection(LIST_PATH, 'loga')
  const pripadovky = getSection(LIST_PATH, 'pripadovky')
  const hodnoceni = getSection(LIST_PATH, 'hodnoceni')
  const cta = getSectionParsed(LIST_PATH, 'cta')
  const filter = referenceFilter()
  const cards = referenceCards()

  const items: FilterItem[] = cards.map((c, i) => ({
    key: c.key,
    tags: [slugify(c.tag)],
    node: (
      <PastelCard
        title={c.title}
        description={c.description}
        href={c.href}
        photo={c.photo}
        aspect="landscape"
        tone={toneAt(i)}
        eyebrow={c.tag}
        sizes="(min-width: 1280px) 600px, (min-width: 768px) 48vw, 100vw"
      />
    ),
  }))

  return (
    <>
      <Section tone="blush" soft labelledBy="reference-title" className="pb-section-sm pt-10 sm:pt-14">
        <Breadcrumbs items={[{ label: 'Úvod', href: '/' }, { label: 'Reference' }]} className="mb-8" />
        <div className="grid gap-10 lg:grid-cols-[minmax(0,7fr)_minmax(0,5fr)] lg:items-end lg:gap-16">
          <div className="motion-safe:animate-lift">
            <h1 id="reference-title" className="md-caps text-h1 text-cocoa">
              {uvod.heading}
            </h1>
            <p className="md-pretty mt-5 max-w-2xl text-lead text-cocoa">
              <PlaceholderText text={uvod.body} />
            </p>
          </div>
          <section aria-labelledby="reference-loga" className="rounded-soft bg-paper/80 p-6 ring-1 ring-hairline">
            <h2 id="reference-loga" className="font-copy text-eyebrow uppercase text-cocoa-soft">
              {loga.heading}
            </h2>
            <p className="mt-3 text-copy text-cocoa">
              <PlaceholderText text={loga.body} />
            </p>
          </section>
        </div>
      </Section>

      <Section id="pripadove-studie" labelledBy="pripadovky-title">
        <SectionHeading id="pripadovky-title" title={pripadovky.heading} />
        <FilterGrid
          legend={filter.legend}
          allLabel={filter.allLabel}
          options={filter.options}
          items={items}
          gridClassName="grid gap-6 md:grid-cols-2 lg:gap-8"
        />
      </Section>

      <Section tone="paper" spacing="sm" labelledBy="hodnoceni-title">
        <QuoteCard id="hodnoceni-title" heading={hodnoceni.heading} text={hodnoceni.body} tone="vanilla" />
      </Section>

      <Cta
        title={cta.heading}
        body={cta.body}
        primary={{ label: cta.parsedCta?.label ?? '', href: contextInquiryHref(cta.parsedCta?.href, { zdroj: LIST_PATH }) }}
        showPhone
      />
    </>
  )
}

// ── případová studie ────────────────────────────────────────────────────────

export function referenceStaticParams() {
  return REFERENCE_CASES.map((c) => ({ slug: c.slug }))
}

/** Případovka čeká na souhlas klienta s publikací ([DOPLNÍ KLIENT: souhlas …] ve shrnutí). */
export function referenceAwaitsConsent(slug: string): boolean {
  const c = referenceCase(slug)
  if (!c) return false
  return splitPlaceholders(getSection(c.path, 'shrnuti').body).some((p) => p.placeholder && /souhlas/i.test(p.text))
}

export function ReferenceCasePage({ slug }: { slug: string }) {
  const c = referenceCase(slug)
  if (!c) throw new Error(`reference: neznámá případová studie ${slug}`)
  const P = c.path
  const shrnuti = getSectionParsed(P, 'shrnuti')
  const zadani = getSection(P, 'zadani')
  const menu = getSectionParsed(P, 'menu')
  const galerie = getSection(P, 'galerie')
  const citace = getSection(P, 'citace')
  const cta = getSectionParsed(P, 'cta')
  const ctaHref = contextInquiryHref(cta.parsedCta?.href, { typ: c.eventType, vzor: c.slug, zdroj: P })
  const facts = shrnuti.parsedItems.filter((it) => it.label).map((it) => ({ label: it.label!, value: it.text }))
  const photos = c.gallery.map(([slot, i]) => getPhoto(slot, i))

  return (
    <>
      <Hero
        size="page"
        tone={c.filter === 'Svatby' ? 'blush' : 'sage'}
        eyebrow={c.filter}
        title={shrnuti.heading}
        lead={shrnuti.body}
        photo={getPhoto(c.coverSlot)}
        primaryCta={cta.parsedCta ? { label: cta.parsedCta.label, href: ctaHref } : null}
        breadcrumbs={[{ label: 'Úvod', href: '/' }, { label: 'Reference', href: LIST_PATH }, { label: shrnuti.heading }]}
      />

      <Section labelledBy="zadani-title">
        <div className="grid gap-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:gap-16">
          <FactList facts={facts} />
          <div>
            <h2 id="zadani-title" className="md-caps text-h2 text-cocoa">
              {zadani.heading}
            </h2>
            <p className="md-pretty mt-5 text-lead text-cocoa-soft">
              <PlaceholderText text={zadani.body} />
            </p>
          </div>
        </div>
      </Section>

      <Section tone="vanilla" soft labelledBy="menu-title">
        <SectionHeading id="menu-title" title={menu.heading} lead={menu.body || null} />
        {menu.parsedItems.length ? (
          <ul role="list" className="gap-5 md:columns-2">
            {menu.parsedItems.map((it) => (
              <li key={it.raw} className="mb-5 break-inside-avoid">
                <article className="h-full rounded-frame bg-paper p-6 ring-1 ring-hairline sm:p-8">
                  <h3 className="md-caps text-h3 text-cocoa">{it.label ?? it.title}</h3>
                  <p className="md-pretty mt-3 text-copy text-cocoa-soft">
                    <PlaceholderText text={it.text} />
                  </p>
                </article>
              </li>
            ))}
          </ul>
        ) : null}
      </Section>

      <Section labelledBy="galerie-title">
        <SectionHeading id="galerie-title" title={galerie.heading} />
        <div className="space-y-6">
          <Gallery photos={photos} />
          <p className="text-small text-cocoa-soft">
            <PlaceholderText text={galerie.body} />
          </p>
        </div>
      </Section>

      <Section tone="paper" spacing="sm" labelledBy="citace-title">
        <QuoteCard id="citace-title" heading={citace.heading} text={citace.body} tone={c.filter === 'Svatby' ? 'blush' : 'sage'} />
      </Section>

      <Cta title={cta.heading} body={cta.body} primary={{ label: cta.parsedCta?.label ?? '', href: ctaHref }} showPhone tone="sage" />
    </>
  )
}

/** Pro testy a sitemapu: všechny případovky s cestou. */
export function referenceCasePaths(): string[] {
  return REFERENCE_CASES.map((c) => c.path)
}
