import Image from 'next/image'
import Link from 'next/link'
import type { Photo } from '@/lib/web/photos'
import { Button } from '../Button'
import { IconArrowRight, IconPlate } from '../icons'
import { PlaceholderText } from '../PlaceholderText'
import { SectionBand } from '../v2/SectionBand'

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

/**
 * Reference (docs/web-v2-design.md §5.10) BEZ vymýšlení: žádné hvězdičky ani fiktivní lidé.
 * Mřížka 3 buněk: velké malinové uvozovky, skutečný popis akce z copy, fotka akce jako kruhový
 * „avatar“ s obrysem (nebo kruh s příborem). Citáty, loga a čísla zatím dodá klient (zástupci).
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
    <section id={id} aria-labelledby={`${id}-title`} className="bg-cream">
      <SectionBand
        id={`${id}-title`}
        title={heading}
        accent="pro"
        lead={lead}
        tone="cream"
        action={cta ? <Button href={cta.href} variant="outline" arrow>{cta.label}</Button> : undefined}
      />
      <div className="mx-auto max-w-web-wide">
        <ul role="list" className="md-grid border-y-0 md:grid-cols-3 min-[90rem]:border-x-2 min-[90rem]:border-cocoa">
          {cards.map((c, i) => (
            <li key={c.href} className="hover:!bg-raspberry-tint">
              <article className="group relative flex h-full flex-col px-gutter py-8 sm:p-8 xl:p-10">
                <span aria-hidden="true" className="md-caps block h-[4.5rem] text-[7rem] leading-[1] text-raspberry">
                  “
                </span>
                <h3 className="md-caps text-h3 text-cocoa">
                  <Link href={c.href} className="outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:outline focus-visible:after:outline-[3px] focus-visible:after:-outline-offset-4 focus-visible:after:outline-daddy-ink">
                    {c.title}
                  </Link>
                </h3>
                <p className="md-pretty mt-3 text-copy text-cocoa-soft">
                  <PlaceholderText text={c.text} />
                </p>
                <div className="mt-auto flex items-center justify-between gap-4 pt-8">
                  <span className={`relative block h-20 w-20 overflow-hidden rounded-full border-[2.5px] border-cocoa shadow-hard-sm ${i % 2 ? 'bg-daddy-tint' : 'bg-raspberry-tint'}`}>
                    {c.photo?.src && !c.photo.placeholder ? (
                      <Image src={c.photo.src} alt={c.photo.alt} fill sizes="80px" className="object-cover" />
                    ) : (
                      <span role="img" aria-label="Fotka akce bude doplněna" className="grid h-full place-items-center">
                        <IconPlate size={30} />
                      </span>
                    )}
                  </span>
                  <span aria-hidden="true" className="grid h-11 w-11 place-items-center rounded-pill border-2 border-cocoa bg-paper transition-colors group-hover:bg-raspberry-ink group-hover:text-cream">
                    <IconArrowRight size={18} />
                  </span>
                </div>
              </article>
            </li>
          ))}
        </ul>
        {notes.length || stats.length ? (
          <div className="md-grid border-y-0 border-t-2 md:grid-cols-2 min-[90rem]:border-x-2 min-[90rem]:border-cocoa">
            {notes.map((n) => (
              <div key={n.label} className="px-gutter py-6 sm:p-8">
                <p className="mb-3 font-copy text-eyebrow uppercase text-cocoa">{n.label}</p>
                <p className="text-copy text-cocoa">
                  <PlaceholderText text={n.text} />
                </p>
              </div>
            ))}
            {stats.length ? (
              <ul role="list" className="grid gap-2 !bg-butter px-gutter py-6 sm:grid-cols-3 sm:p-8 md:col-span-2">
                {stats.map((s) => (
                  <li key={s} className="md-caps text-h3 text-cocoa">
                    <PlaceholderText text={s} />
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  )
}
