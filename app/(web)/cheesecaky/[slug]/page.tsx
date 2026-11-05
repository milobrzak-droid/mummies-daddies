import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { Breadcrumbs, Cta, PastelCard, PhotoFrame, PlaceholderText, PriceTag, Section, SectionHeading, TONE_BG, cx } from '@/components/web'
import { ProductCard, ProductConfigurator, TermList } from '@/components/web/eshop'
import { JsonLd, productJsonLd } from '@/components/web/poptavka'
import { COMPANY } from '@/lib/web/company'
import { cheesecakeOf } from '@/lib/web/options'
import { pageMetadata } from '@/lib/web/content'
import { CHEESECAKE_PATH, CHEESECAKE_SLUGS, allowsInscription, isCheesecakeSlug, productPath } from '@/lib/web/eshop/catalog'
import { productPageData } from '@/lib/web/eshop/copy'

/**
 * /cheesecaky/[slug] – detail cheesecaku (7 produktů z copy.json):
 * fotka + popis + cena + konfigurátor (počet, nápis / příchutě, termín) →
 * parametry a doprava → související → upsell „na akci“ (poptávka).
 */
export function generateStaticParams() {
  return CHEESECAKE_SLUGS.map((slug) => ({ slug }))
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params
  if (!isCheesecakeSlug(slug)) return {}
  return pageMetadata(productPath(slug))
}

export default async function CheesecakePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params
  if (!isCheesecakeSlug(slug)) notFound()
  const d = productPageData(slug)
  const p = d.product
  const breadcrumbs = [
    { label: 'Úvod', href: '/' },
    { label: 'Cheesecaky', href: CHEESECAKE_PATH },
    { label: p.name },
  ]

  return (
    <>
      <Section tone={p.tone} soft spacing="none" labelledBy="produkt-title" className="pb-section-sm pt-8 sm:pt-12">
        <Breadcrumbs items={breadcrumbs} className="mb-8" />
        {/* Product (schema.org); cena jen potvrzená klientem – doplnila část poptávka/SEO */}
        <JsonLd
          data={productJsonLd({
            name: p.name,
            url: `${COMPANY.siteUrl}${productPath(slug)}`,
            description: d.description,
            image: p.photo.src ? `${COMPANY.siteUrl}${p.photo.src}` : null,
            price: p.price,
            priceConfirmed: cheesecakeOf(slug)?.priceConfirmed ?? false,
            brand: COMPANY.brand,
            sellerId: `${COMPANY.siteUrl}/#firma`,
          })}
        />
        <div className="grid gap-10 lg:grid-cols-2 lg:gap-16">
          <div className="lg:sticky lg:top-[calc(theme(spacing.header)+1.5rem)] lg:self-start">
            <div className={cx('rounded-frame p-3 sm:p-4', TONE_BG[p.tone])}>
              <PhotoFrame photo={p.photo} aspect="portrait" tone={p.tone} preload quality={85} sizes="(min-width: 1280px) 600px, (min-width: 1024px) 46vw, 92vw" />
            </div>
          </div>

          <div className="motion-safe:animate-lift">
            <h1 id="produkt-title" className="md-caps text-h1 text-cocoa">
              {d.heading}
            </h1>
            <div className="mt-5">
              <PriceTag text={d.priceText} amount={d.priceText ? null : p.price} size="lg" />
            </div>
            {d.description ? (
              <p className="md-pretty mt-6 text-lead text-cocoa">
                <PlaceholderText text={d.description} />
              </p>
            ) : null}

            <div className="mt-8 rounded-soft bg-paper p-5 shadow-float ring-1 ring-inset ring-hairline sm:p-7">
              {d.labels.optionsHeading && allowsInscription(slug) ? (
                <div className="mb-6">
                  <h2 className="md-caps text-h3 text-cocoa">{d.labels.optionsHeading}</h2>
                  {d.labels.optionsBody ? <p className="mt-2 text-copy text-cocoa-soft">{d.labels.optionsBody}</p> : null}
                </div>
              ) : null}
              <ProductConfigurator slug={slug} price={p.price} labels={d.labels} />
            </div>
          </div>
        </div>
      </Section>

      <Section tone="cream" labelledBy={d.parametry ? 'parametry-title' : 'doprava-title'}>
        <div className="grid gap-12 md:grid-cols-2 md:gap-16">
          {d.parametry ? (
            <div>
              <h2 id="parametry-title" className="md-caps mb-6 text-h2 text-cocoa">
                {d.parametry.section.heading}
              </h2>
              <TermList items={d.parametry.items} />
            </div>
          ) : null}
          {d.doprava ? (
            <div>
              <h2 id="doprava-title" className="md-caps mb-6 text-h2 text-cocoa">
                {d.doprava.heading}
              </h2>
              <p className="md-pretty text-lead text-cocoa">
                <PlaceholderText text={d.doprava.body} />
              </p>
            </div>
          ) : null}
        </div>
      </Section>

      {d.firmy && d.firmy.cta ? (
        <Cta id="firmy-title" title={d.firmy.section.heading} body={d.firmy.section.body} primary={d.firmy.cta} tone="vanilla" />
      ) : null}

      {d.related.section && d.related.items.length ? (
        <Section tone="paper" labelledBy="souvisejici-title">
          <div className={d.related.items.length < 3 ? 'grid gap-y-2 lg:grid-cols-3 lg:gap-x-6' : undefined}>
            <SectionHeading id="souvisejici-title" title={d.related.section.heading} />
            <ul role="list" className={d.related.items.length < 3 ? 'grid gap-5 sm:grid-cols-2 lg:col-span-2' : 'grid gap-5 sm:grid-cols-2 lg:grid-cols-3'}>
              {d.related.items.map((r) => (
                <li key={r.key}>
                  {r.product ? (
                    <ProductCard product={r.product} sizes="(min-width: 1024px) 440px, (min-width: 640px) 46vw, 92vw" />
                  ) : (
                    <PastelCard title={r.title} href={r.href} tone="vanilla" className="min-h-[12rem]" />
                  )}
                </li>
              ))}
            </ul>
          </div>
        </Section>
      ) : null}

      {d.naAkci && d.naAkci.cta ? (
        <Cta
          id="na-akci-title"
          title={d.naAkci.section.heading}
          body={d.naAkci.section.body}
          primary={d.naAkci.cta}
          tone="sage"
          showPhone
        />
      ) : null}
    </>
  )
}

