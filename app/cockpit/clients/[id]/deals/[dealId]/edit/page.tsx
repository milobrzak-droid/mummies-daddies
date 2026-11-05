import { notFound, redirect } from 'next/navigation'
import { DealForm } from '@/components/DealForm'
import { DealPartnerForm } from '@/components/DealPartnerForm'
import { updateDeal } from '@/domain/crm/actions/deals'
import { addDealPartner } from '@/domain/crm/actions/deal-partners'
import { getDealPartners } from '@/domain/crm/queries/deals'
import { getDealForAccount } from '@/domain/crm/queries/dealDetail'
import { canCurrentUserSeeSales } from '@/lib/queries/access'
import { listPartners } from '@/domain/crm/queries/partners'
import { DataTable } from '@/components/DataTable'
import { PageHeader } from '@/components/PageHeader'
import { formatPct } from '@/lib/format'
import { getContacts } from '@/domain/crm/queries/accounts'
import { listTeamMembers } from '@/lib/queries/team'
import { TaskListCompact } from '@/components/TaskListCompact'
import { TaskQuickForm } from '@/components/TaskQuickForm'
import { createTask } from '@/domain/crm/actions/tasks'
import { getOpenTasksForDeal, getDoneTaskCountForDeal } from '@/domain/crm/queries/tasks'

const SECTION = 'm-0 mb-3 mt-9 font-heading text-title2 font-bold'

export default async function EditDeal({ params }:
  { params: Promise<{ id: string; dealId: string }> }) {
  const { id, dealId } = await params
  if (!await canCurrentUserSeeSales()) redirect('/cockpit')
  const accountId = Number(id)
  // Obchod se hledá VČETNĚ klienta z URL — cizí dealId pod jiným klientem
  // se tváří jako neexistující (jinak by formulář ukládal pod špatné account_id).
  const deal = await getDealForAccount(accountId, Number(dealId))
  if (!deal) notFound()
  const [partners, dealPartners, members, contacts, openTasks, doneTaskCount] = await Promise.all([
    listPartners(), getDealPartners(deal.id), listTeamMembers(), getContacts(accountId),
    getOpenTasksForDeal(deal.id), getDoneTaskCountForDeal(deal.id),
  ])
  const action = updateDeal.bind(null, accountId, deal.id)
  return (
    <>
      <PageHeader
        title="Upravit obchod"
        eyebrow={deal.account?.name ? `${deal.account.name} · Obchod` : 'Obchod'}
        subtitle={deal.title}
        back={{ href: `/cockpit/clients/${accountId}/deals/${deal.id}`, label: 'Zpět na obchod' }}
      />
      <DealForm action={action} partners={partners} members={members} contacts={contacts} initial={deal} />
      <h2 className={SECTION}>Partnerská atribuce</h2>
      <DataTable mobile="cards" label="Partnerská atribuce"
        rows={dealPartners}
        empty="Žádní partneři."
        columns={[
          { header: 'Partner', cell: (dp) => partners.find((p) => p.id === dp.partner_id)?.name ?? String(dp.partner_id) },
          { header: 'Program', cell: (dp) => dp.program },
          { header: 'Atribuce', cell: (dp) => formatPct(dp.attribution_pct) },
          { header: 'Sourcing', cell: (dp) => (dp.is_sourcing ? 'Ano' : '—') },
          { header: 'NNPSA', cell: (dp) => dp.nnpsa_target ?? '—' },
        ]}
      />
      <DealPartnerForm action={addDealPartner.bind(null, accountId, deal.id)} partners={partners} />

      {/* Úkol navázaný na konkrétní deal, ne jen na klienta obecně —
          projektový tým tu vidí, co je potřeba udělat právě pro tento obchod. */}
      <div className="grid lg:grid-cols-[0.85fr_1.15fr] gap-5 items-start mt-9">
        <section>
          <h2 className={`${SECTION} !mt-0`}>Přidat úkol</h2>
          <TaskQuickForm action={createTask} members={members} accountId={accountId} dealId={deal.id} />
        </section>
        <section>
          <h2 className={`${SECTION} !mt-0`}>Úkoly k obchodu</h2>
          <TaskListCompact tasks={openTasks} doneCount={doneTaskCount} members={members} />
        </section>
      </div>
    </>
  )
}
