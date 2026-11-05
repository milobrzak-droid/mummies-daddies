import { ActivityForm } from '@/components/ActivityForm'
import { ActivityTimeline } from '@/components/ActivityTimeline'
import { PageHeader } from '@/components/PageHeader'
import { SectionTabs, WORK_TABS } from '@/components/SectionTabs'
import { WorkKpiStrip } from '@/components/WorkUi'
import { buttonClass } from '@/components/ui/Button'
import { ExportButtons } from '@/components/ExportButtons'
import { createSalesActivity } from '@/domain/crm/actions/sales'
import { getAccountOption, getContacts } from '@/domain/crm/queries/accounts'
import { getSalesActivities, getSalesDeals } from '@/domain/crm/queries/sales'
import { canCurrentUserSeeSales } from '@/lib/queries/access'
import { addDaysToPragueDay, pragueDayOf, pragueToday } from '@/lib/pragueDate'
import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

// Druhy aktivit pro klidná čísla nahoře (bez barevných ploch: číslo a slovo).
const KINDS = [
  { key: 'call', label: 'Telefonáty' },
  { key: 'email', label: 'E-maily' },
  { key: 'meeting', label: 'Schůzky' },
  { key: 'note', label: 'Poznámky' },
] as const

export default async function ActivitiesPage({
  searchParams,
}: { searchParams: Promise<{ account?: string; deal?: string }> }) {
  if (!await canCurrentUserSeeSales()) redirect('/cockpit')
  const params = await searchParams
  const [deals, activities] = await Promise.all([getSalesDeals(), getSalesActivities(150)])
  const requestedDeal = deals.find((deal) => deal.id === Number(params.deal))
  const requestedAccount = requestedDeal?.account_id ?? Number(params.account)
  // Firma se vybírá hledáním (AccountPicker) — načítá se jen ta předvybraná
  // z URL a její kontakty, ne všechny firmy a všechny kontakty.
  const initialAccount = await getAccountOption(requestedAccount)
  const contacts = initialAccount ? await getContacts(initialAccount.id) : []
  // Za posledních 7 dní (pražské dny, včetně dneška) z načtené historie.
  const since = addDaysToPragueDay(pragueToday(), -6)
  const recent = activities.filter((a) => pragueDayOf(a.occurred_at) >= since)
  const recentTotal = recent.length
  return (
    <>
      <PageHeader
        title="Aktivity"
        eyebrow="Práce"
        subtitle={
          recentTotal === 0
            ? 'Za posledních 7 dní tým nic nezapsal. Zapiš výsledek jednou větou.'
            : `Za posledních 7 dní ${recentTotal} ${recentTotal === 1 ? 'zápis' : recentTotal < 5 ? 'zápisy' : 'zápisů'}. Zapiš výsledek jednou větou, zbytek jen když ho tým využije.`
        }
      >
        <ExportButtons prehled="aktivity" label="Stáhnout historii aktivit" />
        <a href="#nova-aktivita" className={buttonClass('primary')}>Zapsat aktivitu</a>
      </PageHeader>
      <SectionTabs tabs={WORK_TABS} label="Práce" />
      <div className="mb-8">
        <WorkKpiStrip
          label="Aktivity za posledních 7 dní"
          items={KINDS.map((k) => ({
            key: k.key,
            label: k.label,
            value: recent.filter((a) => a.kind === k.key).length,
            hint: 'za 7 dní',
          }))}
        />
      </div>
      <div className="grid items-start gap-6 lg:grid-cols-[0.85fr_1.15fr]">
        <div id="nova-aktivita" className="scroll-mt-6 lg:sticky lg:top-6">
          <ActivityForm
            action={createSalesActivity}
            deals={deals}
            contacts={contacts}
            initialAccount={initialAccount}
            initialDealId={initialAccount && requestedDeal?.account_id === initialAccount.id ? requestedDeal.id : undefined}
          />
        </div>
        <section aria-labelledby="historie-tymu">
          <h2 id="historie-tymu" className="m-0 mb-4 font-heading text-title1 font-bold">Historie týmu</h2>
          <ActivityTimeline activities={activities} />
        </section>
      </div>
    </>
  )
}
