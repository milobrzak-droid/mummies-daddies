import type { ReactNode } from 'react'
import type { SectionCopy } from '@/lib/web/content'
import { Breadcrumbs } from '../Breadcrumbs'
import { Section } from '../Section'
import { LegalText } from './LegalText'
import { AccentTitle } from '@/components/web/AccentTitle'

/**
 * Šablona právní stránky (obchodní podmínky, ochrana údajů, cookies):
 * úzký sloupec textu, sekce s nadpisy h2 a viditelnými zástupci
 * [DOPLNÍ KLIENT / PRÁVNÍK: …]. `actions` = tlačítko pod sekcí (podle id sekce).
 */
export function LegalPage({
  title,
  lead,
  sections,
  actions,
}: {
  title: string
  lead?: string | null
  sections: SectionCopy[]
  actions?: Partial<Record<string, ReactNode>>
}) {
  return (
    <>
      <Section tone="pistachio" soft spacing="none" labelledBy="pravni-title" width="prose" className="pb-10 pt-8 sm:pb-14 sm:pt-12">
        <Breadcrumbs items={[{ label: 'Úvod', href: '/' }, { label: title }]} className="mb-8" />
        <h1 id="pravni-title" className="md-caps text-h1 text-cocoa"><AccentTitle title={title} /></h1>
        {lead ? (
          <p className="md-pretty mt-5 text-lead text-cocoa">
            <LegalText text={lead} />
          </p>
        ) : null}
      </Section>
      <Section tone="cream" width="prose">
        <div className="space-y-12">
          {sections.map((s) => (
            <section key={s.id} id={s.id} aria-labelledby={`${s.id}-title`}>
              <h2 id={`${s.id}-title`} className="md-caps text-h3 text-cocoa">
                {s.heading}
              </h2>
              {s.body ? (
                <p className="md-pretty mt-4 text-copy leading-relaxed text-cocoa">
                  <LegalText text={s.body} />
                </p>
              ) : null}
              {s.items?.length ? (
                <ul className="mt-4 list-disc space-y-2 pl-5 text-copy text-cocoa">
                  {s.items.map((it) => (
                    <li key={it}>
                      <LegalText text={it} />
                    </li>
                  ))}
                </ul>
              ) : null}
              {actions?.[s.id] ? <div className="mt-6">{actions[s.id]}</div> : null}
            </section>
          ))}
        </div>
      </Section>
    </>
  )
}
