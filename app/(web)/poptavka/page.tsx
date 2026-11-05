import { Breadcrumbs, Button, IconMail, IconPhone, PhotoFrame, PlaceholderText, Section } from '@/components/web'
import { InquiryWizard } from '@/components/web/poptavka'
import { COMPANY, pageMetadata } from '@/lib/web/content'
import { isoDate } from '@/lib/web/format'
import { parseInquiryParams } from '@/lib/web/inquiry-link'
import { getPhoto } from '@/lib/web/photos'
import { inquiryPageCopy, wizardLabels } from '@/lib/web/poptavka/copy'
import { UI_TEXT } from '@/lib/web/poptavka/ui-text'

/**
 * /poptavka – průvodce poptávkou krok za krokem (strategy.conversion: jedna
 * hlavní akce webu). Předvyplnění z odkazu (?typ=&osob=&datum=&zdroj=…),
 * živá orientační cena, odeslání přes submitInquiry → /poptavka/odeslano.
 * Vedle průvodce: Co bude dál, Raději s člověkem; pod ním Vařili jsme pro…
 */
export const metadata = pageMetadata('/poptavka')

type SearchParams = Promise<Record<string, string | string[] | undefined>>

export default async function InquiryPage({ searchParams }: { searchParams: SearchParams }) {
  const prefill = parseInquiryParams(await searchParams)
  const labels = wizardLabels()
  const { uvod, next, human, trust } = inquiryPageCopy()
  const photo = getPhoto('poptavka.trust')

  const aside = (
    <>
      <section aria-labelledby="co-bude-dal-title" className="rounded-soft bg-sage p-5 sm:p-6">
        <h2 id="co-bude-dal-title" className="md-caps text-h3 text-cocoa">
          {next.heading}
        </h2>
        {next.body ? <p className="mt-2 text-copy text-cocoa">{next.body}</p> : null}
        <ol className="mt-5 space-y-4">
          {next.items.map((it, i) => (
            <li key={it.raw} className="grid grid-cols-[auto_1fr] gap-3">
              <span aria-hidden="true" className="grid h-7 w-7 place-items-center rounded-pill bg-paper font-display text-[1.05rem] italic text-cocoa">
                {i + 1}
              </span>
              <p className="text-small text-cocoa">
                {it.title ? <strong className="font-semibold">{it.title}</strong> : null}
                {it.title ? ' — ' : null}
                <PlaceholderText text={it.text} />
              </p>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="clovek-title" className="rounded-soft bg-blush p-5 sm:p-6">
        <h2 id="clovek-title" className="md-caps text-h3 text-cocoa">
          {human.heading}
        </h2>
        <p className="md-pretty mt-2 text-small text-cocoa">
          <PlaceholderText text={human.body} />
        </p>
        <div className="mt-5 flex flex-col items-start gap-2">
          <Button href={COMPANY.phoneHref} variant="white" size="sm" icon={<IconPhone size={18} />}>
            {COMPANY.phone}
          </Button>
          <Button href={`mailto:${COMPANY.email}`} variant="white" size="sm" icon={<IconMail size={18} />}>
            {COMPANY.email}
          </Button>
        </div>
      </section>
    </>
  )

  return (
    <>
      <Section tone="blush" soft spacing="none" labelledBy="poptavka-title" className="pb-10 pt-8 sm:pb-12 sm:pt-12">
        <Breadcrumbs items={[{ label: 'Úvod', href: '/' }, { label: UI_TEXT.breadcrumb }]} className="mb-8" />
        <div className="max-w-3xl motion-safe:animate-lift">
          <h1 id="poptavka-title" className="md-caps text-h1 text-cocoa">
            {uvod.heading}
          </h1>
          <p className="md-pretty mt-5 text-lead text-cocoa">
            <PlaceholderText text={uvod.body} />
          </p>
        </div>
      </Section>

      <Section tone="cream" spacing="sm">
        <InquiryWizard labels={labels} prefill={prefill} today={isoDate()} aside={aside} />
      </Section>

      <Section tone="paper" labelledBy="duvera-title">
        <div className="grid items-center gap-8 md:grid-cols-2 md:gap-14">
          <PhotoFrame photo={photo} aspect="landscape" tone="vanilla" sizes="(min-width: 1280px) 600px, (min-width: 768px) 46vw, 92vw" />
          <div>
            <h2 id="duvera-title" className="md-caps text-h2 text-cocoa">
              {trust.heading}
            </h2>
            <p className="md-pretty mt-5 text-lead text-cocoa-soft">
              <PlaceholderText text={trust.body} />
            </p>
            <div className="mt-6">
              <Button href="/reference" variant="ghost">
                Reference
              </Button>
            </div>
          </div>
        </div>
      </Section>
    </>
  )
}
