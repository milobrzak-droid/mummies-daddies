import { Breadcrumbs, Section } from '@/components/web'
import { CartView } from '@/components/web/eshop'
import { pageMetadata } from '@/lib/web/content'
import { allProductSummaries, cartLabels } from '@/lib/web/eshop/copy'

/**
 * /kosik – košík a objednávka cheesecaků (strategy.sitemap): položky →
 * doručení / vyzvednutí a termín → kontakt a fakturace (IČO volitelně) →
 * platba → souhlas. Obsah košíku je v localStorage (klientská komponenta),
 * objednávka jde přes submitOrder (lib/web/api). Stránka se neindexuje.
 */
export const metadata = pageMetadata('/kosik', { robots: { index: false, follow: true } })

export default function CartPage() {
  return (
    <Section tone="cream" className="pt-8 sm:pt-12">
      <Breadcrumbs items={[{ label: 'Úvod', href: '/' }, { label: 'Cheesecaky', href: '/cheesecaky' }, { label: 'Košík' }]} className="mb-8" />
      <CartView labels={cartLabels()} products={allProductSummaries()} />
    </Section>
  )
}
