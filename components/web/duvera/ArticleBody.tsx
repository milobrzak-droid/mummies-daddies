import { COMPANY } from '@/lib/web/company'
import type { ArticleBlock } from '@/lib/web/duvera/blog'
import { Button } from '../Button'
import { IconMail, IconPhone } from '../icons'
import { PlaceholderText } from '../PlaceholderText'

/** Tělo článku blogu (odstavce, mezititulky h2, číslované kroky, kontakt). */
export function ArticleBody({ blocks }: { blocks: readonly ArticleBlock[] }) {
  return (
    <div className="space-y-6 text-[1.0625rem] leading-[1.75] text-cocoa">
      {blocks.map((b, i) => {
        switch (b.type) {
          case 'h2':
            return (
              <h2 key={i} className="md-caps pt-6 text-h3 text-cocoa">
                {b.text}
              </h2>
            )
          case 'p':
            return (
              <p key={i} className="md-pretty">
                <PlaceholderText text={b.text} />
              </p>
            )
          case 'steps':
            return (
              <ol key={i} role="list" className="space-y-4">
                {b.items.map((s, n) => (
                  <li key={s.title} className="grid grid-cols-[2.75rem_1fr] gap-4 rounded-frame bg-paper p-5 ring-2 ring-cocoa sm:p-6">
                    <span aria-hidden="true" className="grid h-11 w-11 place-items-center rounded-pill bg-blush font-display text-[1.375rem] font-bold text-cocoa">
                      {n + 1}
                    </span>
                    <div>
                      <h3 className="font-copy text-[1.0625rem] font-bold text-cocoa">
                        <span className="sr-only">{n + 1}. </span>
                        {s.title}
                      </h3>
                      <p className="md-pretty mt-1 text-copy text-cocoa-soft">{s.text}</p>
                    </div>
                  </li>
                ))}
              </ol>
            )
          case 'contact':
            return (
              <div key={i} className="flex flex-col items-start gap-3 sm:flex-row sm:flex-wrap">
                <Button href={COMPANY.phoneHref} variant="white" icon={<IconPhone size={18} />}>
                  {COMPANY.phone}
                </Button>
                <Button href={`mailto:${COMPANY.email}`} variant="white" icon={<IconMail size={18} />}>
                  {COMPANY.email}
                </Button>
              </div>
            )
        }
      })}
    </div>
  )
}
