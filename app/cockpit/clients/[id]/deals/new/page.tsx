import { redirect } from 'next/navigation'
import { DealForm } from '@/components/DealForm'
import { createDeal } from '@/domain/crm/actions/deals'
import { listPartners } from '@/domain/crm/queries/partners'
import { getContacts } from '@/domain/crm/queries/accounts'
import { listTeamMembers } from '@/lib/queries/team'
import { getAccount } from '@/domain/crm/queries/accounts'
import { PageHeader } from '@/components/PageHeader'
import { canCurrentUserSeeSales } from '@/lib/queries/access'

export default async function NewDeal({ params }: { params: Promise<{ id: string }> }) {
  if (!await canCurrentUserSeeSales()) redirect('/cockpit')
  const { id } = await params
  const accountId = Number(id)
  const [partners, members, contacts, account] = await Promise.all([
    listPartners(), listTeamMembers(), getContacts(accountId), getAccount(accountId),
  ])
  return (
    <>
      <PageHeader
        title="Nový obchod"
        eyebrow="Obchody"
        back={account ? { href: `/cockpit/clients/${accountId}`, label: account.name } : { href: '/cockpit/pipeline', label: 'Obchody' }}
        subtitle={account ? `Pro klienta ${account.name}. Stačí název a další krok, zbytek může počkat.` : 'Stačí název a další krok, zbytek může počkat.'}
      />
      <DealForm action={createDeal.bind(null, accountId)} partners={partners} members={members} contacts={contacts} />
    </>
  )
}
