import type { Photo } from '@/lib/web/photos'
import { toneAt } from '@/lib/web/tokens'
import { Button } from '../Button'
import { PastelCard } from '../PastelCard'
import { PriceTag } from '../PriceTag'
import { Section } from '../Section'
import { SectionHeading } from '../SectionHeading'

export interface CheesecakeCard {
  name: string
  note: string | null
  /** Cena doslova z copy („790 Kč“). */
  price: string | null
  href: string
  photo: Photo | null
}

/**
 * „Sladká tečka každé akce“: menší sekce s nižší vizuální váhou (cheesecaky
 * jsou doplněk cateringu). Vizuálně nejblíž referenci: produkt na pastelu.
 */
export function CheesecakeTeaser({
  heading,
  lead,
  products,
  order,
  addToEvent,
  id = 'cheesecaky',
}: {
  heading: string
  lead?: string | null
  products: CheesecakeCard[]
  /** „Objednat domů“ → /cheesecaky */
  order?: { label: string; href: string } | null
  /** „Přidat na akci“ → /poptavka?doplnek=sladky-bar */
  addToEvent?: { label: string; href: string } | null
  id?: string
}) {
  return (
    <Section id={id} tone="cream" labelledBy={`${id}-title`}>
      <div className="grid gap-10 lg:grid-cols-[minmax(0,4fr)_minmax(0,8fr)] lg:gap-14">
        <div className="lg:pt-4">
          <SectionHeading id={`${id}-title`} title={heading} lead={lead} className="sm:mb-8" />
          <div className="flex flex-col items-start gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-5">
            {order ? (
              <Button href={order.href} variant="primary">
                {order.label}
              </Button>
            ) : null}
            {addToEvent ? (
              <Button href={addToEvent.href} variant="outline">
                {addToEvent.label}
              </Button>
            ) : null}
          </div>
        </div>
        <ul role="list" className="grid gap-5 sm:grid-cols-3">
          {products.map((p, i) => (
            <li key={p.href}>
              <PastelCard
                title={p.name}
                description={p.note}
                href={p.href}
                photo={p.photo}
                tone={toneAt(i, ['blush', 'sage', 'pistachio'])}
                aspect="square"
                photoClassName="max-sm:aspect-[3/2]"
                sizes="(min-width: 1280px) 260px, (min-width: 640px) 30vw, 92vw"
                meta={p.price ? <PriceTag text={p.price} size="md" /> : null}
              />
            </li>
          ))}
        </ul>
      </div>
    </Section>
  )
}
