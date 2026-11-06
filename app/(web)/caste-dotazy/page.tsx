import { Breadcrumbs, Cta, Faq, PlaceholderText, Section } from '@/components/web'
import { JsonLd, faqPageJsonLd } from '@/components/web/poptavka'
import { getPage, pageMetadata } from '@/lib/web/content'
import { inquiryHref } from '@/lib/web/inquiry-link'
import { FAQ_PAGE, faqGroups } from '@/lib/web/poptavka/copy'
import { UI_TEXT } from '@/lib/web/poptavka/ui-text'
import { AccentTitle } from '@/components/web/AccentTitle'

/**
 * /caste-dotazy – ceny, minima, doprava, alergeny, servis, platba, termíny
 * a cheesecaky. „Otázka? — Odpověď“ = rozbalovací FAQ, „Štítek — hodnota“
 * (minima, záloha, storno) = přehledná tabulka. Jedna FAQPage pro celou
 * stránku (otázky se zástupcem [DOPLNÍ KLIENT] se do ní nedávají).
 */
export const metadata = pageMetadata(FAQ_PAGE)

/** Titulek stránky = popisek v patičce („Časté dotazy“), perex = meta popis z copy. */
const TITLE = 'Časté dotazy'

export default function FaqPage() {
  const page = getPage(FAQ_PAGE)
  const { groups, cta } = faqGroups()
  const ld = faqPageJsonLd(groups.flatMap((g) => g.questions))

  return (
    <>
      <Section tone="vanilla" soft spacing="none" labelledBy="dotazy-title" className="pb-12 pt-8 sm:pb-16 sm:pt-12">
        <Breadcrumbs items={[{ label: 'Úvod', href: '/' }, { label: TITLE }]} className="mb-8" />
        <div className="max-w-3xl motion-safe:animate-lift">
          <h1 id="dotazy-title" className="md-caps text-h1 text-cocoa"><AccentTitle title={TITLE} /></h1>
          <p className="md-pretty mt-5 text-lead text-cocoa">{page.metaDescription}</p>
        </div>
      </Section>

      <Section tone="cream">
        <div className="grid gap-10 lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-16">
          <nav aria-label={UI_TEXT.faqToc} className="lg:sticky lg:top-[calc(theme(spacing.header)+1.5rem)] lg:self-start">
            <ul role="list" className="flex flex-wrap gap-2 lg:flex-col lg:gap-1">
              {groups.map((g) => (
                <li key={g.id}>
                  <a
                    href={`#${g.id}`}
                    className="inline-flex min-h-10 items-center rounded-pill bg-paper px-4 font-copy text-small font-bold text-cocoa ring-2 ring-inset ring-cocoa hover:ring-cocoa/40 lg:bg-transparent lg:px-0 lg:ring-0 lg:hover:text-raspberry-ink"
                  >
                    {g.heading}
                  </a>
                </li>
              ))}
            </ul>
          </nav>

          <div className="max-w-web-prose space-y-14 lg:max-w-none">
            {groups.map((g) => (
              <section key={g.id} id={g.id} aria-labelledby={`${g.id}-title`} className="scroll-mt-[calc(theme(spacing.header)+1.5rem)]">
                <h2 id={`${g.id}-title`} className="md-caps text-h2 text-cocoa"><AccentTitle title={g.heading} /></h2>
                {g.body ? (
                  <p className="md-pretty mt-4 text-lead text-cocoa-soft">
                    <PlaceholderText text={g.body} />
                  </p>
                ) : null}
                {g.questions.length ? <Faq items={g.questions} jsonLd={false} className="mt-6" /> : null}
                {g.terms.length ? (
                  <dl className="mt-6 divide-y divide-hairline overflow-hidden rounded-soft bg-paper ring-2 ring-inset ring-cocoa">
                    {g.terms.map((t) => (
                      <div key={t.term} className="grid gap-1 px-5 py-4 sm:grid-cols-[minmax(0,3fr)_minmax(0,2fr)] sm:gap-6">
                        <dt className="font-copy text-copy text-cocoa">
                          <PlaceholderText text={t.term} />
                        </dt>
                        <dd className="font-copy text-copy font-bold text-cocoa">
                          <PlaceholderText text={t.value} />
                        </dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
                {g.notes.map((n) => (
                  <p key={n} className="mt-4 text-copy text-cocoa-soft">
                    <PlaceholderText text={n} />
                  </p>
                ))}
              </section>
            ))}
          </div>
        </div>
      </Section>

      {cta ? (
        <Cta
          id="dotazy-cta-title"
          title={cta.heading}
          body={cta.body}
          primary={{ label: cta.cta ?? '', href: `${inquiryHref({ zdroj: FAQ_PAGE })}#asistent` }}
          tone="sage"
          showPhone
        />
      ) : null}

      <JsonLd data={ld} />
    </>
  )
}
