import type { Photo } from '@/lib/web/photos'
import type { PastelTone } from '@/lib/web/tokens'
import { Button } from '../Button'
import { PastelCard } from '../PastelCard'
import { PlaceholderText } from '../PlaceholderText'
import { Section } from '../Section'
import { SectionHeading } from '../SectionHeading'

export interface ReferenceCard {
  title: string
  text: string
  href: string
  photo: Photo | null
}

export interface ReferenceNote {
  /** „Loga klientů“, „Citace a hodnocení“ */
  label: string
  text: string
}

const TONES: PastelTone[] = ['sage', 'blush', 'vanilla']

/**
 * Důvěra a reference: 3 případové studie s velkou fotkou, pod nimi loga,
 * citace a číselný pás. Loga, citace a čísla zatím dodává klient (zástupci).
 */
export function References({
  heading,
  lead,
  cards,
  notes,
  stats,
  cta,
  id = 'reference',
}: {
  heading: string
  lead?: string | null
  cards: ReferenceCard[]
  notes: ReferenceNote[]
  /** Položky číselného pásu (splitDots z „Čísla: …“). */
  stats: string[]
  cta?: { label: string; href: string } | null
  id?: string
}) {
  return (
    <Section id={id} tone="paper" labelledBy={`${id}-title`}>
      <SectionHeading
        id={`${id}-title`}
        title={heading}
        lead={lead}
        action={cta ? <Button href={cta.href} variant="ghost">{cta.label}</Button> : undefined}
      />
      <ul role="list" className="grid gap-6 md:grid-cols-3 lg:gap-8">
        {cards.map((c, i) => (
          <li key={c.href}>
            <PastelCard
              title={c.title}
              description={c.text}
              href={c.href}
              photo={c.photo}
              tone={TONES[i % TONES.length]}
              aspect="tall"
              sizes="(min-width: 1280px) 400px, (min-width: 768px) 31vw, 92vw"
            />
          </li>
        ))}
      </ul>

      {notes.length ? (
        <div className="mt-12 grid gap-6 md:grid-cols-2">
          {notes.map((n) => (
            <div key={n.label} className="rounded-soft border border-dashed border-cocoa/25 bg-cream p-6">
              <p className="mb-3 font-copy text-eyebrow uppercase text-cocoa-soft">{n.label}</p>
              <p className="text-copy text-cocoa">
                <PlaceholderText text={n.text} />
              </p>
            </div>
          ))}
        </div>
      ) : null}

      {stats.length ? (
        <ul role="list" className="mt-6 grid divide-y divide-hairline rounded-soft bg-vanilla-soft sm:grid-cols-3 sm:divide-x sm:divide-y-0">
          {stats.map((s) => (
            <li key={s} className="px-6 py-7 text-center font-display text-h3 font-medium leading-tight text-cocoa">
              <PlaceholderText text={s} />
            </li>
          ))}
        </ul>
      ) : null}
    </Section>
  )
}
