import Image from 'next/image'
import Link from 'next/link'
import type { Photo } from '@/lib/web/photos'
import { Button } from '../Button'
import { IconArrowRight } from '../icons'
import { PlaceholderText } from '../PlaceholderText'
import { SectionBand } from '../v2/SectionBand'
import { cx } from '../cx'

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
 * Položka pásu čísel → velké číslo + popisek pod ním (stejná struktura pro hotové i chybějící):
 *   "[DOPLNÍ KLIENT: akcí ročně]" → { value: "[DOPLNÍ KLIENT]", label: "akcí ročně" }
 *   "vaříme od roku 2018"         → { value: "2018", label: "vaříme od roku" }
 */
export function statParts(text: string): { value: string; label: string } {
  const ph = /^\[DOPLNÍ KLIENT:\s*([^\]]+)\]$/.exec(text.trim())
  if (ph) return { value: '[DOPLNÍ KLIENT]', label: ph[1].trim() }
  const n = /(\d[\d\s\u00a0]*\d|\d)/.exec(text)
  if (!n) return { value: text, label: '' }
  return { value: n[1], label: text.replace(n[1], '').replace(/\s{2,}/g, ' ').trim() }
}

/**
 * Reference (docs/web-v2-design.md §5.10) BEZ vymýšlení: žádné hvězdičky, citáty ani fiktivní lidé.
 * Mřížka 3 buněk: fotka akce 4 : 3 jako natočená „samolepka“ (hlavní prvek karty), název akce,
 * skutečný popis z copy a „Detail akce →“. Citáty, loga a čísla zatím dodá klient (zástupci).
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
                {c.photo?.src && !c.photo.placeholder ? (
                  <div className={cx('mb-7 motion-safe:transition-transform motion-safe:duration-base group-hover:rotate-0', i % 2 ? 'rotate-2' : '-rotate-2')}>
                    <div className="md-sticker relative aspect-[4/3]">
                      <Image src={c.photo.src}
                  {...(c.photo.blur ? { placeholder: 'blur' as const, blurDataURL: c.photo.blur } : {})} alt={c.photo.alt} fill sizes="(min-width: 1440px) 420px, (min-width: 768px) 30vw, 92vw" className="object-cover" style={c.photo.position ? { objectPosition: c.photo.position } : undefined} />
                    </div>
                  </div>
                ) : null}
                <h3 className="md-caps text-h3 text-cocoa">
                  <Link href={c.href} className="outline-none after:absolute after:inset-0 after:content-[''] focus-visible:after:outline focus-visible:after:outline-[3px] focus-visible:after:-outline-offset-4 focus-visible:after:outline-daddy-ink">
                    {c.title}
                  </Link>
                </h3>
                <p className="md-pretty mt-3 text-copy text-cocoa-soft first-letter:uppercase">
                  <PlaceholderText text={c.text} />
                </p>
                <p aria-hidden="true" className="mt-auto flex items-center gap-2 pt-6 font-copy font-bold text-cocoa">
                  Detail akce
                  <span className="grid h-11 w-11 place-items-center rounded-pill border-2 border-cocoa bg-paper transition-colors group-hover:bg-raspberry-ink group-hover:text-cream">
                    <IconArrowRight size={18} />
                  </span>
                </p>
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
              <ul role="list" className="grid gap-6 !bg-butter px-gutter py-7 text-center sm:grid-cols-3 sm:p-8 md:col-span-2">
                {stats.map((s) => {
                  const p = statParts(s)
                  return (
                    <li key={s} className="flex flex-col items-center gap-1">
                      <span className="md-caps text-h2 leading-[1.1] text-cocoa">
                        <PlaceholderText text={p.value} />
                      </span>
                      <span className="font-copy text-small font-bold text-cocoa-soft">{p.label}</span>
                    </li>
                  )
                })}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  )
}
