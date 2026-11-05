import { stripPlaceholders } from '@/lib/web/placeholders'

/** Strukturovaná data schema.org (bezpečně serializovaná, `<` escapované). */
export function JsonLd({ data }: { data: Record<string, unknown> | null | undefined }) {
  if (!data) return null
  return <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(data).replace(/</g, '\\u003c') }} />
}

const hasPlaceholder = (s: string) => /\[DOPLNÍ/.test(s)

/**
 * Jedna FAQPage pro celou stránku (Google chce na stránce jen jednu).
 * Otázky se zástupcem [DOPLNÍ …] vynechá; bez otázek vrátí null.
 */
export function faqPageJsonLd(items: { question: string; answer: string }[]) {
  const ok = items.filter((i) => !hasPlaceholder(i.question + i.answer))
  if (!ok.length) return null
  return {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: ok.map((i) => ({ '@type': 'Question', name: i.question, acceptedAnswer: { '@type': 'Answer', text: i.answer } })),
  }
}

/**
 * Product pro detail cheesecaku. Cena (Offer) jen když je potvrzená klientem –
 * nepotvrzenou cenu do vyhledávačů neposíláme. Popis bez zástupců.
 */
export function productJsonLd(p: {
  name: string
  url: string
  description?: string | null
  image?: string | null
  price?: number | null
  priceConfirmed?: boolean
  brand: string
  sellerId?: string
}) {
  return {
    '@context': 'https://schema.org',
    '@type': 'Product',
    name: p.name,
    url: p.url,
    ...(p.description ? { description: stripPlaceholders(p.description).replace(/\[DOPLNÍ[^\]]*\]/g, '').trim() } : {}),
    ...(p.image ? { image: p.image } : {}),
    brand: { '@type': 'Brand', name: p.brand },
    category: 'Cheesecake',
    ...(p.price && p.priceConfirmed
      ? {
          offers: {
            '@type': 'Offer',
            price: String(p.price),
            priceCurrency: 'CZK',
            availability: 'https://schema.org/InStock',
            url: p.url,
            ...(p.sellerId ? { seller: { '@id': p.sellerId } } : {}),
          },
        }
      : {}),
  }
}
