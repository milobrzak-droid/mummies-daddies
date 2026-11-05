import { notFound } from 'next/navigation'
import { AccountForm } from '@/components/AccountForm'
import { PageHeader } from '@/components/PageHeader'
import { SectionTabs, CLIENT_TABS } from '@/components/SectionTabs'
import { Card } from '@/components/ui/Card'
import { updateAccount } from '@/domain/crm/actions/accounts'
import { getAccount } from '@/domain/crm/queries/accounts'
import { listPartners } from '@/domain/crm/queries/partners'
import { listTeamMembers } from '@/lib/queries/team'

// Záložní stránka úpravy firmy. Běžně se firma upravuje na místě v bočním
// panelu detailu (/clients/[id]?upravit=firma); tahle adresa zůstává pro
// staré odkazy a jako cesta bez panelu.
export default async function EditAccount({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const [account, partners, members] = await Promise.all([
    getAccount(Number(id)), listPartners(), listTeamMembers(),
  ])
  if (!account) notFound()
  const action = updateAccount.bind(null, account.id)
  return (
    <>
      <PageHeader title="Upravit klienta" eyebrow={account.name} back={{ href: `/cockpit/clients/${account.id}`, label: account.name }} />
      <SectionTabs tabs={CLIENT_TABS} label="Klienti a partneři" />
      <Card id="upravit-klienta" title="Údaje o firmě" sub="Změny se uloží tlačítkem dole." className="max-w-3xl">
        <AccountForm action={action} initial={account} partners={partners} members={members} />
      </Card>
    </>
  )
}
