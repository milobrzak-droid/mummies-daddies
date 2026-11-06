import Image from 'next/image'
import Link from 'next/link'
import type { Photo } from '@/lib/web/photos'
import { Button } from '../Button'
import { IconArrowRight, IconPlate } from '../icons'
import { PlaceholderText } from '../PlaceholderText'
import { PriceTag } from '../PriceTag'
import { SectionBand } from '../v2/SectionBand'
import { cx } from '../cx'

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
 * Srdce úvodu (docs/web-v2-design.md §5.7 CategoryGrid): modrý pruh nadpisu a pod ním
 * orámovaná mřížka 3 × 3 buněk dělených sdílenými 2px linkami. V buňce štítek s minimem,
 * jídlo jako natočená „samolepka“, Anton název a kruhová šipka; celá buňka je jeden odkaz.
 * Mobil: kompaktní řádky (samolepka 88 px vlevo, text vpravo).
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
    <section id={id} aria-labelledby={`${id}-title`} className="bg-cream">
      <SectionBand id={`${id}-title`} title={heading} accent="akci" lead={lead} tone="blue" />
      <div className="mx-auto max-w-web-wide">
        <ul role="list" className="md-grid border-y-0 sm:grid-cols-2 lg:grid-cols-3 min-[90rem]:border-x-2 min-[90rem]:border-cocoa">
          {cards.map((c, i) => (
            <li key={c.href} className={cx('transition-colors duration-base', i % 2 ? 'hover:!bg-daddy-tint' : 'hover:!bg-raspberry-tint')}>
              <article className="group relative grid h-full grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-x-4 gap-y-2 px-gutter py-5 sm:flex sm:flex-col sm:items-stretch sm:p-7 xl:p-9">
                {c.minimum ? (
                  <p className="col-start-2 row-start-1 self-end sm:self-start">
                    <span className="inline-flex rounded-pill border-2 border-cocoa bg-butter px-2.5 py-0.5 font-copy text-[0.8125rem] font-bold text-cocoa">{c.minimum}</span>
                  </p>
                ) : null}
                <div className="row-span-3 row-start-1 sm:my-6 sm:flex sm:justify-center">
                  <div
                    className={cx(
                      'relative aspect-square w-[5.5rem] overflow-hidden border-[2.5px] border-cocoa shadow-hard-sm sm:w-[62%] sm:shadow-hard-md',
                      'motion-safe:transition-transform motion-safe:duration-base group-hover:rotate-0 motion-safe:group-hover:-translate-y-1.5',
                      i % 3 === 1 ? 'rounded-full' : 'rounded-sticker',
                      i % 2 ? 'rotate-[4deg] bg-daddy-tint' : '-rotate-[4deg] bg-raspberry-tint',
                    )}
                  >
                    {c.photo?.src && !c.photo.placeholder ? (
                      <Image
                        src={c.photo.src}
                        alt={c.photo.alt}
                        fill
                        sizes="(min-width: 1440px) 300px, (min-width: 1024px) 20vw, (min-width: 640px) 30vw, 88px"
                        className="object-cover"
                        style={c.photo.position ? { objectPosition: c.photo.position } : undefined}
                      />
                    ) : (
                      <div role="img" aria-label={c.photo?.alt ?? 'Fotka bude doplněna'} className="grid h-full place-items-center text-cocoa/50">
                        <IconPlate size={36} />
                      </div>
                    )}
                  </div>
                </div>
                <div className="col-start-2 flex items-end justify-between gap-4 sm:mt-auto">
                  <div className="min-w-0">
                    <h3 className="md-caps text-h3 text-cocoa">
                      <Link href={c.href} className="outline-none after:absolute after:inset-0 after:z-10 after:content-[''] focus-visible:after:outline focus-visible:after:outline-[3px] focus-visible:after:-outline-offset-4 focus-visible:after:outline-daddy-ink">
                        {c.title}
                      </Link>
                    </h3>
                    <p className="md-pretty mt-1.5 text-small text-cocoa-soft max-sm:hidden">
                      <PlaceholderText text={c.description} />
                    </p>
                    {c.price ? <PriceTag text={c.price} size="sm" className="mt-2" /> : null}
                  </div>
                  <span aria-hidden="true" className="grid h-11 w-11 shrink-0 place-items-center rounded-pill border-2 border-cocoa bg-paper text-cocoa transition-colors duration-quick group-hover:bg-raspberry-ink group-hover:text-cream">
                    <IconArrowRight size={18} className="motion-safe:transition-transform group-hover:translate-x-0.5" />
                  </span>
                </div>
              </article>
            </li>
          ))}
        </ul>
      </div>
      {assistant ? (
        <p className="border-b-2 border-cocoa bg-paper py-6 text-center">
          <Button href={assistant.href} variant="ghost" size="md">
            {assistant.label}
          </Button>
        </p>
      ) : null}
    </section>
  )
}
