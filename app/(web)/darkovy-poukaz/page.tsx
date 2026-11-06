import { Breadcrumbs, PlaceholderText, Section } from '@/components/web'
import { VoucherForm } from '@/components/web/eshop'
import { pageMetadata } from '@/lib/web/content'
import { voucherPageData } from '@/lib/web/eshop/copy'
import { AccentTitle } from '@/components/web/AccentTitle'

/**
 * /darkovy-poukaz – jedna stránka poukazu (strategy.sitemap): hodnota
 * 1 000–5 000 Kč nebo vlastní částka → pro koho (jméno, vzkaz, e-mail) →
 * platba a souhlas; vedle živý náhled poukazu. Na co platí a platnost
 * zatím doplní klient (viditelní zástupci). Nákup jde přes submitVoucherOrder.
 */
export const metadata = pageMetadata('/darkovy-poukaz')

export default function VoucherPage() {
  const d = voucherPageData()
  return (
    <>
      <Section tone="blush" soft labelledBy="poukaz-title" className="pb-section-sm pt-8 sm:pt-12" spacing="none">
        <Breadcrumbs items={[{ label: 'Úvod', href: '/' }, { label: 'Cheesecaky', href: '/cheesecaky' }, { label: d.labels.previewTitle }]} className="mb-8" />
        <div className="max-w-3xl motion-safe:animate-lift">
          <h1 id="poukaz-title" className="md-caps text-h1 text-cocoa"><AccentTitle title={d.uvod.heading} /></h1>
          <p className="md-pretty mt-5 text-lead text-cocoa">
            <PlaceholderText text={d.uvod.body} />
          </p>
        </div>
      </Section>

      <Section tone="cream">
        <VoucherForm labels={d.labels} />
      </Section>

      <Section tone="paper" spacing="sm">
        <div className="grid gap-5 md:grid-cols-2">
          {[d.uplatneni, d.platnost].map((s, i) => (
            <section key={s.id} aria-labelledby={`poukaz-${s.id}-title`} className={i ? 'rounded-frame bg-sage p-6 sm:p-8' : 'rounded-frame bg-vanilla p-6 sm:p-8'}>
              <h2 id={`poukaz-${s.id}-title`} className="md-caps text-h3 text-cocoa">
                {s.heading}
              </h2>
              <p className="md-pretty mt-3 text-copy text-cocoa">
                <PlaceholderText text={s.body} />
              </p>
            </section>
          ))}
        </div>
      </Section>
    </>
  )
}
