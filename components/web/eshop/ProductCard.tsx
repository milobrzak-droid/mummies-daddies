import type { ProductSummary } from '@/lib/web/eshop/types'
import { Badge } from '../Badge'
import { PastelCard } from '../PastelCard'
import { PlaceholderText } from '../PlaceholderText'
import { PriceTag } from '../PriceTag'
import { cx } from '../cx'
import { QuickAddButton } from './QuickAddButton'

/**
 * Karta cheesecaku v katalogu: fotka na pastelu v barvě příchuti, název, popis
 * a cena doslova z copy. Celá karta vede na detail; „Přidat do košíku“ (když jde
 * produkt přidat bez voleb) leží nad roztaženým odkazem.
 */
export function ProductCard({
  product,
  description,
  badge,
  quickAdd,
  headingLevel = 'h3',
  linkLabel,
  sizes = '(min-width: 1280px) 400px, (min-width: 1024px) 31vw, (min-width: 640px) 46vw, 92vw',
  className,
}: {
  product: ProductSummary
  description?: string | null
  badge?: string | null
  quickAdd?: { label: string; added: string; cart: { label: string; href: string } } | null
  headingLevel?: 'h2' | 'h3' | 'h4'
  /** Text výzvy u šipky karty (např. „Vybrat příchutě“ u mini mixu). */
  linkLabel?: string
  sizes?: string
  className?: string
}) {
  return (
    <PastelCard
      title={product.name}
      description={description}
      href={product.href}
      photo={product.photo}
      tone={product.tone}
      aspect="portrait"
      photoClassName="max-sm:aspect-square"
      sizes={sizes}
      headingLevel={headingLevel}
      linkLabel={linkLabel}
      className={cx('h-full', className)}
      meta={
        <span className="flex flex-col items-start gap-2">
          {badge ? (
            <Badge tone="paper" size="sm">
              <PlaceholderText text={badge} />
            </Badge>
          ) : null}
          <PriceTag text={product.priceText || null} amount={product.priceText ? null : product.price} size="md" />
          {/* Tlačítko dole u ceny: v řadě karet tak sedí na stejné lince bez ohledu na délku popisu. */}
          {quickAdd ? <QuickAddButton slug={product.slug} name={product.name} label={quickAdd.label} added={quickAdd.added} cart={quickAdd.cart} className="mt-2" /> : null}
        </span>
      }
    />
  )
}
