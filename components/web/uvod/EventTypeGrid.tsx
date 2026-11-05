import type { Photo } from '@/lib/web/photos'
import { toneAt, PASTEL_TONES } from '@/lib/web/tokens'
import { Button } from '../Button'
import { PastelCard } from '../PastelCard'
import { PriceTag } from '../PriceTag'
import { Section } from '../Section'
import { SectionHeading } from '../SectionHeading'

export interface EventTypeCard {
  title: string
  description: string
  /** Cena z copy (se zástupcem), např. „Od [DOPLNÍ KLIENT] Kč/os.“. */
  price: string | null
  /** Minimum osob z copy, např. „od 4 osob“. */
  minimum: string | null
  href: string
  photo: Photo | null
}

/**
 * Srdce úvodu: mřížka typů akcí (3 / 2 / 1 sloupec), karty na výšku v pastelech.
 * Střídají se 4 tóny, takže se barvy v řádcích po 3 kartách posouvají (jako v referenci).
 */
export function EventTypeGrid({
  heading,
  lead,
  cards,
  assistant,
  id = 'typy-akci',
}: {
  heading: string
  lead?: string | null
  cards: EventTypeCard[]
  /** „Nevíte, který formát zvolit? Zeptejte se asistenta“ */
  assistant?: { label: string; href: string } | null
  id?: string
}) {
  return (
    <Section id={id} tone="paper" labelledBy={`${id}-title`} className="pt-section-sm sm:pt-section">
      <SectionHeading id={`${id}-title`} title={heading} lead={lead} />
      <ul role="list" className="grid gap-5 sm:grid-cols-2 sm:gap-6 lg:grid-cols-3 lg:gap-8">
        {cards.map((c, i) => (
          <li key={c.href}>
            <PastelCard
              title={c.title}
              description={c.description}
              href={c.href}
              photo={c.photo}
              tone={toneAt(i, PASTEL_TONES)}
              aspect="portrait"
              sizes="(min-width: 1280px) 400px, (min-width: 1024px) 31vw, (min-width: 640px) 46vw, 92vw"
              meta={
                c.price || c.minimum ? (
                  <span className="flex flex-col gap-1">
                    {c.price ? <PriceTag text={c.price} size="sm" /> : null}
                    {c.minimum ? <span className="font-copy text-small text-cocoa-soft">{c.minimum}</span> : null}
                  </span>
                ) : null
              }
            />
          </li>
        ))}
      </ul>
      {assistant ? (
        <p className="mt-10 text-center sm:mt-12">
          <Button href={assistant.href} variant="ghost" size="md">
            {assistant.label}
          </Button>
        </p>
      ) : null}
    </Section>
  )
}
