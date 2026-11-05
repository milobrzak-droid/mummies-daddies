import { PageHeader } from '@/components/PageHeader'
import { Card } from '@/components/ui/Card'
import { EngagementForm } from '@/components/EngagementForm'
import { createEngagement } from '@/domain/delivery/actions/engagements'

export default async function NewEngagement({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return (
    <>
      <PageHeader
        title="Nová dodávka"
        eyebrow="Práce · Dodávky"
        back={{ href: `/cockpit/clients/${Number(id)}`, label: 'Zpět na klienta' }}
        subtitle="Vyplň druh, fázi a termíny. Milníky, tým a předání doplníš na stránce dodávky."
      />
      <div className="max-w-3xl">
        <Card>
          <EngagementForm action={createEngagement.bind(null, Number(id))} />
        </Card>
      </div>
    </>
  )
}
