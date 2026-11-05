import { AccountForm } from '@/components/AccountForm'
import { PageHeader } from '@/components/PageHeader'
import { SectionTabs, CLIENT_TABS } from '@/components/SectionTabs'
import { Card } from '@/components/ui/Card'
import { createAccount } from '@/domain/crm/actions/accounts'
import { listPartners } from '@/domain/crm/queries/partners'
import { listTeamMembers } from '@/lib/queries/team'

export default async function NewAccount() {
  const [partners, members] = await Promise.all([listPartners(), listTeamMembers()])
  return (
    <>
      <PageHeader
        title="Nový klient"
        eyebrow="Klienti"
        subtitle="Založ firmu. Údaje jde předvyplnit z ARES podle IČO nebo názvu."
        back={{ href: '/cockpit/clients', label: 'Klienti' }}
      />
      <SectionTabs tabs={CLIENT_TABS} label="Klienti a partneři" />
      <Card id="novy-klient" title="Údaje o firmě" sub="Stačí název, ostatní můžeš doplnit později." className="max-w-3xl">
        <AccountForm action={createAccount} partners={partners} members={members} />
      </Card>
    </>
  )
}
