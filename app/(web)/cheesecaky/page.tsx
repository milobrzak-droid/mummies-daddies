import { Button, Hero, PhotoFrame, PlaceholderText, PriceTag, Section, SectionHeading } from '@/components/web'
import { ProductCard, TermList } from '@/components/web/eshop'
import { pageMetadata } from '@/lib/web/content'
import { catalogPageData } from '@/lib/web/eshop/copy'
import { isMini } from '@/lib/web/eshop/catalog'
import { AccentTitle } from '@/components/web/AccentTitle'
import { FloatingCutout } from '@/components/web/v2/FloatingCutout'

/**
 * /cheesecaky – doplňkový e-shop (strategy.sitemap): úvod → produkty (karty
 * v barvě příchuti, cena doslova z copy, přidání do košíku) → mini → nápis
 * na přání → sezóna → doprava → banner „na vaši akci“ (poptávka) → poukaz.
 */
export const metadata = pageMetadata('/cheesecaky')

export default function CheesecakesPage() {
  const d = catalogPageData()
  const quickAdd = { label: d.addLabel, added: d.added, cart: d.goToCart }
  const breadcrumbs = [{ label: 'Úvod', href: '/' }, { label: 'Cheesecaky' }]

  return (
    <>
      <Hero
        title={d.uvod.heading}
        lead={d.uvod.body}
        photo={d.heroPhoto}
        breadcrumbs={breadcrumbs}
        tone="blush"
        size="page"
        primaryCta={{ label: d.produkty.heading, href: '#produkty' }}
        art={<CheesecakeArt />}
      />

      <Section id="produkty" tone="cream" labelledBy="produkty-title">
        <SectionHeading id="produkty-title" title={d.produkty.heading} lead={d.produkty.body} />
        <ul role="list" className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3 lg:gap-6">
          {d.products.map((p) => (
            <li key={p.slug}>
              <ProductCard product={p} description={p.description} quickAdd={isMini(p.slug) ? null : quickAdd} />
            </li>
          ))}
        </ul>
      </Section>

      <Section id="mini" tone="blush" soft labelledBy="mini-title">
        <div className="grid items-center gap-10 md:grid-cols-2 md:gap-16">
          <PhotoFrame
            photo={d.mini.product.photo}
            aspect="landscape"
            tone={d.mini.product.tone}
            sizes="(min-width: 1280px) 600px, (min-width: 768px) 46vw, 92vw"
            className="md:order-2"
          />
          <div>
            <SectionHeading id="mini-title" title={d.mini.section.heading} lead={d.mini.section.body} className="sm:mb-8" />
            <div className="flex flex-wrap items-center gap-x-6 gap-y-4">
              <PriceTag text={d.mini.product.priceText} size="lg" />
              <Button href={d.mini.product.href} variant="primary" arrow>
                {d.mini.product.name}
              </Button>
            </div>
          </div>
        </div>
      </Section>

      <Section id="na-prani" tone="cream" spacing="sm" labelledBy="na-prani-title">
        <div className="grid gap-8 md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] md:gap-16">
          <h2 id="na-prani-title" className="md-caps text-h2 text-cocoa"><AccentTitle title={d.naPrani.heading} /></h2>
          <p className="md-pretty text-lead text-cocoa">
            <PlaceholderText text={d.naPrani.body} />
          </p>
        </div>
      </Section>

      {d.sezona.product ? (
        <Section id="sezona" tone="sage" soft labelledBy="sezona-title">
          <div className="grid items-center gap-10 md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] md:gap-16">
            <div>
              <SectionHeading id="sezona-title" title={d.sezona.section.heading} lead={d.sezona.text} className="sm:mb-8" />
              {d.sezona.price ? <PriceTag text={d.sezona.price} size="lg" /> : null}
            </div>
            <div className="max-w-md md:justify-self-end">
              <ProductCard product={d.sezona.product} quickAdd={quickAdd} sizes="(min-width: 768px) 28rem, 92vw" />
            </div>
          </div>
        </Section>
      ) : null}

      <Section id="doprava" tone="cream" labelledBy="doprava-title">
        <div className="grid gap-10 md:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] md:gap-16">
          <SectionHeading id="doprava-title" title={d.doprava.section.heading} lead={d.doprava.section.body} className="mb-0 sm:mb-0" />
          <TermList items={d.doprava.items} />
        </div>
      </Section>

      {d.naAkci.cta ? (
        <section aria-labelledby="na-akci-title" className="bg-vanilla">
          <div className="mx-auto grid max-w-web-wide items-stretch md:grid-cols-2">
            <div className="relative min-h-[18rem] md:order-2">
              <PhotoFrame photo={d.naAkci.photo} aspect="fill" rounded={false} tone="vanilla" sizes="(min-width: 768px) 50vw, 100vw" />
            </div>
            <div className="flex flex-col justify-center px-gutter py-section-sm md:py-section md:pl-[max(theme(spacing.gutter),calc((min(100vw,theme(maxWidth.web-wide))-theme(maxWidth.web))/2+theme(spacing.gutter)))] md:pr-12">
              <h2 id="na-akci-title" className="md-caps text-h2 text-cocoa"><AccentTitle title={d.naAkci.section.heading} /></h2>
              <p className="md-pretty mt-5 max-w-xl text-lead text-cocoa-soft">
                <PlaceholderText text={d.naAkci.section.body} />
              </p>
              <div className="mt-8">
                <Button href={d.naAkci.cta.href} variant="primary" size="lg" arrow>
                  {d.naAkci.cta.label}
                </Button>
              </div>
            </div>
          </div>
        </section>
      ) : null}

      {d.poukaz.cta ? (
        <Section id="poukaz" tone="cream" spacing="sm" labelledBy="poukaz-title">
          <div className="flex flex-col gap-6 rounded-frame bg-pistachio p-6 sm:flex-row sm:items-center sm:justify-between sm:p-10">
            <div>
              <h2 id="poukaz-title" className="md-caps text-h2 text-cocoa"><AccentTitle title={d.poukaz.section.heading} /></h2>
              <p className="mt-3 text-lead text-cocoa">
                <PlaceholderText text={d.poukaz.section.body} />
              </p>
            </div>
            <Button href={d.poukaz.cta.href} variant="white" size="lg" arrow className="self-start sm:self-auto">
              {d.poukaz.cta.label}
            </Button>
          </div>
        </Section>
      ) : null}
    </>
  )
}

/** Hero /cheesecaky: levitující výřezy cheesecaků na kruhových „talířích“ v barvách řad (Daddy modrá, Mummy malina). */
function CheesecakeArt() {
  return (
    <div className="relative mx-auto aspect-square w-full max-w-[34rem]">
      <div aria-hidden="true" className="absolute inset-[6%] rounded-full border-2 border-cocoa bg-daddy-tint shadow-hard-md" />
      <div aria-hidden="true" className="absolute -bottom-[2%] -left-[4%] h-[42%] w-[42%] rounded-full border-2 border-cocoa bg-raspberry-tint shadow-hard-sm" />
      <FloatingCutout slug="cheesecake-pistaciovo-malinovy" preload decorative={false} rotate={8} sizes="(min-width: 1024px) 400px, 70vw" className="absolute left-[14%] top-[10%] w-[66%]" />
      <FloatingCutout slug="cheesecake-cokoladovo-liskooriskovy" rotate={-10} delay={-2} sizes="(min-width: 1024px) 200px, 34vw" className="absolute -bottom-[1%] left-[0%] w-[38%]" />
      <FloatingCutout slug="mini-cheesecake-cokoladovy" rotate={6} delay={-3.4} sizes="(min-width: 1024px) 150px, 26vw" className="absolute -right-[2%] bottom-[4%] w-[26%]" />
      <FloatingCutout slug="mini-cheesecake-kosicek" rotate={-12} delay={-1.1} sizes="120px" className="absolute right-[4%] top-[2%] w-[18%] max-w-[8.5rem]" />
    </div>
  )
}
