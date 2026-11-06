import Link from 'next/link'
import type { Photo } from '@/lib/web/photos'
import type { Cutout } from '@/lib/web/cutouts'
import { Button } from '../Button'
import { PriceTag } from '../PriceTag'
import { Explorer } from '../v2/Explorer'
import { SectionBand } from '../v2/SectionBand'
import { Container } from '../Container'

export interface CheesecakeCard {
  name: string
  note: string | null
  /** Cena doslova z copy („790 Kč“). */
  price: string | null
  href: string
  photo: Photo | null
}

export interface CheesecakeFlavor {
  id: string
  label: string
  tone: 'raspberry' | 'blue' | 'butter'
  kicker: string
  photo: Photo | null
  cutout: Cutout | null
  tags: string[]
  /** Cena z lib/web/options (nepotvrzená se zástupcem). */
  price: string
  href: string
}

/**
 * Cheesecaky Mummy & Daddy (docs/web-v2-design.md §5.9): růžový pruh s nadpisem z copy,
 * vlevo seznam příchutí (Daddy modře, Mummy malinově), vpravo výřez produktu na kruhovém
 * „talíři“ v barvě řady se štítky ingrediencí odvozenými jen z názvu příchuti a cenou
 * z lib/web/options. Pod tím doporučené produkty z copy a CTA „Objednat domů“ / „Přidat na akci“.
 */
export function CheesecakeTeaser({
  heading,
  lead,
  products,
  flavors = [],
  order,
  addToEvent,
  id = 'cheesecaky',
}: {
  heading: string
  lead?: string | null
  products: CheesecakeCard[]
  flavors?: CheesecakeFlavor[]
  /** „Objednat domů“ → /cheesecaky */
  order?: { label: string; href: string } | null
  /** „Přidat na akci“ → /poptavka?doplnek=sladky-bar */
  addToEvent?: { label: string; href: string } | null
  id?: string
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="bg-cream">
      <SectionBand
        id={`${id}-title`}
        title={heading}
        accent="tečka"
        lead={lead}
        tone="rasp"
        action={
          <p className="font-copy text-eyebrow uppercase text-cocoa">
            <span className="text-daddy-ink">Daddy</span> · <span className="text-raspberry-ink">Mummy</span> · Mini
          </p>
        }
      />
      {flavors.length ? (
        <div className="mx-auto max-w-web-wide pt-6 lg:pt-0 min-[90rem]:border-x-2 min-[90rem]:border-cocoa">
          <Explorer
            label="Příchutě cheesecaků"
            showDots
            items={flavors.map((f) => ({
              id: f.id,
              label: f.label,
              tone: f.tone,
              kicker: f.kicker,
              photo: f.photo,
              cutout: f.cutout,
              tags: f.tags,
              meta: <PriceTag text={f.price} size="lg" />,
              links: [{ label: 'Detail a objednávka', href: f.href, primary: true }],
            }))}
          />
        </div>
      ) : null}
      <div className="border-t-2 border-cocoa bg-paper">
        <Container width="wide" className="flex flex-col gap-6 py-8 lg:flex-row lg:items-center lg:justify-between">
          <ul role="list" className="flex flex-wrap gap-x-6 gap-y-2 font-copy text-small text-cocoa">
            {products.map((p) => (
              <li key={p.href}>
                <Link href={p.href} className="md-link font-bold">
                  {p.name}
                </Link>
                {p.price ? <span className="ml-2 font-bold tabular-nums text-raspberry-ink">{p.price}</span> : null}
              </li>
            ))}
          </ul>
          <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:gap-4">
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
        </Container>
      </div>
    </section>
  )
}
