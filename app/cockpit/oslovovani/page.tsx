import { redirect } from 'next/navigation'
import Link from 'next/link'
import { PageHeader } from '@/components/PageHeader'
import { DealsSectionTabs } from '@/components/DealsSectionTabs'
import { DealsCompanyLogo } from '@/components/DealsVisuals'
import { DealsStats } from '@/components/DealsKpis'
import { CARD, CARD_PAD } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { OutreachRowActions } from '@/components/OutreachRowActions'
import { canCurrentUserSeeSales } from '@/lib/queries/access'
import { getOutreachQueueDetail } from '@/domain/crm/queries/outreach'
import { DoNotContactChip } from '@/components/DoNotContactChip'
import { SILENCE_THRESHOLD_DAYS } from '@/domain/crm/outreach'
import { formatDate } from '@/lib/format'

export const dynamic = 'force-dynamic'

// Vlastní route: v menu je sekce Obchody, tahle stránka je její záložka
// „Oslovování". Stránka je gatovaná stejně jako /schuzky.
export default async function OslovovaniPage() {
  if (!await canCurrentUserSeeSales()) redirect('/cockpit')

  const { queue, excludedOptOut } = await getOutreachQueueDetail()
  const longest = queue.reduce((max, c) => Math.max(max, c.days_silent), 0)

  return (
    <>
      <PageHeader
        title="Oslovování"
        eyebrow="Firmy, ne obchody"
        subtitle={
          `Firmy bez otevřeného obchodu, kterým jsme psali jako poslední a ${SILENCE_THRESHOLD_DAYS}+ dní se neozvaly. `
          + 'Oslovení tady nezaloží obchod, zapíše se jen jako aktivita.'
        }
      />
      <DealsSectionTabs counts={{ '/cockpit/oslovovani': queue.length }} />

      <DealsStats
        className="mb-6 md:max-w-xl"
        label="Oslovování v číslech"
        stats={[
          { label: 'Čeká na druhý pokus', value: queue.length, note: queue.length === 1 ? 'firma' : queue.length >= 2 && queue.length <= 4 ? 'firmy' : 'firem' },
          { label: 'Nejdelší ticho', value: longest, note: longest === 1 ? 'den' : longest >= 2 && longest <= 4 ? 'dny' : 'dní' },
        ]}
      />

      {excludedOptOut > 0 && (
        <p className="mb-4 text-callout text-muted">
          {excludedOptOut === 1 ? '1 firma se nenabízí' : `${excludedOptOut} ${excludedOptOut <= 4 ? 'firmy se nenabízejí' : 'firem se nenabízí'}`}
          : nesouhlasí s oslovením (všichni její lidé, nebo to říká poznámka firmy).
        </p>
      )}

      {queue.length === 0 ? (
        <div className={CARD}>
          <EmptyState tone="calm" title="Nikdo teď nečeká na druhý pokus." action={{ href: '/cockpit/cilove-seznamy', label: 'Otevřít seznamy k oslovení' }}>
            Všem, komu jsme psali jako poslední, jsme buď nedávno napsali, nebo se řeší jinde.
          </EmptyState>
        </div>
      ) : (
        <section aria-labelledby="k-osloveni" className={`${CARD} ${CARD_PAD}`}>
          <h2 id="k-osloveni" className="m-0 mb-3 font-heading text-title2 font-bold">Firmy k dalšímu oslovení</h2>
          <ul aria-label="Firmy k dalšímu oslovení" className="m-0 flex list-none flex-col p-0">
            {queue.map((c) => (
              <li key={c.account_id} className="flex flex-wrap items-center gap-x-3.5 gap-y-2 border-t border-[color:var(--c-line-2)] py-3 first:border-t-0 first:pt-0 last:pb-0">
                <DealsCompanyLogo name={c.name} size={40} />
                <div className="min-w-0 grow basis-48">
                  <Link href={`/cockpit/clients/${c.account_id}`} className="block truncate text-headline text-ink">{c.name}</Link>
                  <small className="text-footnote text-muted">Naposledy jsme psali my {formatDate(c.last_at)}</small>
                  {c.opt_out && (
                    <div className="mt-1">
                      <DoNotContactChip
                        detail={`${c.opt_out.opted_out} z ${c.opt_out.total}`}
                        title="Někdo z lidí u firmy nesouhlasí s oslovením — jeho neoslovujte. Kdo, je vidět u kontaktů klienta."
                      />
                    </div>
                  )}
                </div>
                <span className={`st ${c.days_silent >= 30 ? 'fail' : c.days_silent >= 21 ? '' : 'info'}`}>{c.days_silent} dní ticha</span>
                <OutreachRowActions accountId={c.account_id} accountName={c.name} />
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  )
}
