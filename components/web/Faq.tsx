import { stripPlaceholders } from '@/lib/web/placeholders'
import { IconPlus } from './icons'
import { PlaceholderText } from './PlaceholderText'
import { cx } from './cx'

export interface FaqItem {
  question: string
  answer: string
}

/**
 * Časté dotazy jako nativní <details>/<summary> (funguje bez JS, klávesnice i čtečky).
 * Položky z copy.json („Otázka? — Odpověď“) převeď: faqFromItems(section.items).
 * jsonLd = FAQPage strukturovaná data (jen otázky bez zástupců [DOPLNÍ KLIENT]).
 */
export function Faq({ items, jsonLd = true, headingLevel: H = 'h3', className }: { items: FaqItem[]; jsonLd?: boolean; headingLevel?: 'h2' | 'h3' | 'h4'; className?: string }) {
  const ldItems = items.filter((i) => !/\[DOPLNÍ KLIENT/.test(i.question + i.answer))
  const ld = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: ldItems.map((i) => ({ '@type': 'Question', name: i.question, acceptedAnswer: { '@type': 'Answer', text: stripPlaceholders(i.answer) } })),
  }
  return (
    <div className={cx('divide-y divide-hairline border-y border-hairline', className)}>
      {items.map((it, i) => (
        <details key={i} className="group/faq">
          <summary className="flex cursor-pointer items-start justify-between gap-6 py-5 sm:py-6">
            <H className="font-copy text-[1.0625rem] font-semibold leading-snug text-cocoa sm:text-[1.125rem]">
              <PlaceholderText text={it.question} />
            </H>
            <span className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-pill bg-paper text-cocoa ring-1 ring-hairline motion-safe:transition-transform motion-safe:duration-base group-open/faq:rotate-45">
              <IconPlus size={16} />
            </span>
          </summary>
          <div className="md-pretty max-w-web-prose pb-6 pr-12 text-copy text-cocoa-soft">
            <PlaceholderText text={it.answer} />
          </div>
        </details>
      ))}
      {jsonLd && ldItems.length ? (
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(ld).replace(/</g, '\\u003c') }} />
      ) : null}
    </div>
  )
}

/** "Otázka? — Odpověď" → FaqItem (položky bez „ — “ se přeskočí). */
export function faqFromItems(items: string[] | undefined): FaqItem[] {
  return (items ?? []).flatMap((raw) => {
    const i = raw.indexOf(' — ')
    return i > 0 ? [{ question: raw.slice(0, i).trim(), answer: raw.slice(i + 3).trim() }] : []
  })
}
