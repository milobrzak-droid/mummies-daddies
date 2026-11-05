import { PartnerForm } from '@/components/PartnerForm'
import { PageHeader } from '@/components/PageHeader'
import { SectionTabs, CLIENT_TABS } from '@/components/SectionTabs'
import { Card } from '@/components/ui/Card'
import { createPartner } from '@/domain/crm/actions/partners'
import { listPartners } from '@/domain/crm/queries/partners'

export default async function NewPartner() {
  const partners = await listPartners()
  return (
    <>
      <PageHeader
        title="Nový partner"
        eyebrow="Partneři"
        subtitle="Doporučitel, dodavatel nebo distributor. Role může mít víc."
        back={{ href: '/cockpit/partners', label: 'Partneři' }}
      />
      <SectionTabs tabs={CLIENT_TABS} label="Klienti a partneři" />
      <Card id="novy-partner" title="Údaje o partnerovi" sub="Název je povinný, ostatní jde doplnit později." className="max-w-2xl">
        <PartnerForm action={createPartner} partners={partners} />
      </Card>
    </>
  )
}
