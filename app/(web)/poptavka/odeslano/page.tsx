import type { Metadata } from 'next'
import { Button, IconPhone, Section } from '@/components/web'
import { ConfirmationText } from '@/components/web/poptavka'
import { COMPANY } from '@/lib/web/content'
import { confirmationCopy, isOutcome } from '@/lib/web/poptavka/copy'

/**
 * /poptavka/odeslano – potvrzení po odeslání poptávky. Text podle výsledku
 * z submitInquiry (?vysledek=standard|na-miru|ceka-na-cenik|konzultace),
 * mikrotexty POTVRZENÍ — …; e-mail a orientační rozpětí doplní klientská
 * komponenta z poslední odeslané poptávky. Neindexovat.
 */
export const metadata: Metadata = {
  title: { absolute: `${confirmationCopy('standard').heading} | ${COMPANY.brand}` },
  robots: { index: false, follow: true },
}

type SearchParams = Promise<Record<string, string | string[] | undefined>>

export default async function InquiryConfirmationPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams
  const raw = Array.isArray(sp.vysledek) ? sp.vysledek[0] : sp.vysledek
  const outcome = isOutcome(raw) ? raw : 'ceka-na-cenik'
  const copy = confirmationCopy(outcome)

  return (
    <Section tone="sage" soft labelledBy="potvrzeni-title" className="min-h-[60vh]">
      <div className="max-w-3xl motion-safe:animate-rise">
        <h1 id="potvrzeni-title" className="md-caps text-h1 text-cocoa">
          {copy.heading}
        </h1>
        {copy.text ? <ConfirmationText template={copy.text} showEstimate={outcome !== 'konzultace'} /> : null}
        <div className="mt-10 flex flex-col items-start gap-4 sm:flex-row sm:items-center">
          <Button href="/reference" variant="primary" size="lg" arrow>
            {copy.nextStep}
          </Button>
          {outcome === 'konzultace' || outcome === 'na-miru' ? (
            <Button href={COMPANY.phoneHref} variant="white" size="lg" icon={<IconPhone size={20} />}>
              {COMPANY.phone}
            </Button>
          ) : null}
        </div>
      </div>
    </Section>
  )
}
