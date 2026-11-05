import { notFound } from 'next/navigation'
import { PartnerForm } from '@/components/PartnerForm'
import { ContactForm } from '@/components/ContactForm'
import { DataTable } from '@/components/DataTable'
import { Chip, toneForKey } from '@/components/Chip'
import { ContactOptOutChip } from '@/components/DoNotContactChip'
import { PageHeader } from '@/components/PageHeader'
import { SectionTabs, CLIENT_TABS } from '@/components/SectionTabs'
import { ButtonLink } from '@/components/ui/Button'
import { Card, CARD } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { updatePartner } from '@/domain/crm/actions/partners'
import { createPartnerContact } from '@/domain/crm/actions/contacts'
import { ActivityTimeline } from '@/components/ActivityTimeline'
import { ActivityForm } from '@/components/ActivityForm'
import { createSalesActivity } from '@/domain/crm/actions/sales'
import { EmailLink } from '@/components/ui/EmailLink'
import { getPartner, getRegistrations, getPartnerContacts, getPartnerActivities, listPartners } from '@/domain/crm/queries/partners'

const H2 = 'm-0 mt-10 mb-3 font-heading text-title1 font-bold'

// Karta partnera: údaje (úprava), kontakty, historie a zápis aktivity,
// registrace v programech. Pořadí podle anatomie stránky: údaje a seznamy
// nahoře, formuláře pro přidání na konci oddílu.
export default async function EditPartner({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const partner = await getPartner(Number(id))
  if (!partner) notFound()
  const [regs, partners, contacts, activities] = await Promise.all([
    getRegistrations(partner.id), listPartners(), getPartnerContacts(partner.id),
    getPartnerActivities(partner.id),
  ])
  return (
    <>
      <PageHeader title={partner.name} eyebrow="Partner" back={{ href: '/cockpit/partners', label: 'Partneři' }}>
        <ButtonLink href="#zapsat-aktivitu" variant="outline">Zapsat aktivitu</ButtonLink>
      </PageHeader>
      <SectionTabs tabs={CLIENT_TABS} label="Klienti a partneři" />

      <Card id="udaje-partnera" title="Údaje o partnerovi" sub="Název, sektor, role a přes koho k nám partner přichází." className="max-w-3xl">
        <PartnerForm action={updatePartner.bind(null, partner.id)} initial={partner} partners={partners} />
      </Card>

      <h2 id="kontakty" className={H2}>Kontakty</h2>
      <DataTable mobile="cards" label="Kontakty partnera"
        rows={contacts}
        empty="Zatím žádný kontakt."
        emptyHint="Člověk u partnera, se kterým jednáme."
        emptyAction={{ href: '#pridat-kontakt', label: 'Přidat kontakt' }}
        columns={[
          { header: 'Jméno', cell: (c) => <span className="inline-flex flex-wrap items-center gap-2">{c.full_name}{c.is_champion && <Chip tone="pos">Champion</Chip>}<ContactOptOutChip contact={c} /></span> },
          { header: 'Role', cell: (c) => c.role ?? <span className="text-muted">—</span> },
          { header: 'E-mail', cell: (c) => <EmailLink email={c.email} /> },
          {
            header: 'Úprava',
            align: 'right',
            cell: (c) => (
              <ButtonLink href={`/cockpit/kontakty/${c.id}/edit`} variant="quiet" size="sm" aria-label={`Upravit kontakt ${c.full_name}`}>Upravit</ButtonLink>
            ),
          },
        ]}
      />
      <Card id="pridat-kontakt" title="Přidat kontakt" sub="Člověk u partnera, se kterým jednáme." className="mt-4 max-w-3xl scroll-mt-4">
        <ContactForm action={createPartnerContact.bind(null, partner.id)} submitVariant="default" />
      </Card>

      <h2 id="historie" className={H2}>Historie</h2>
      {/* Aktivity partnera (schůzky, hovory, poznámky) — u partnera je account
          vždy null, proto showAccount={false} stejně jako na detailu klienta. */}
      {activities.length === 0 ? (
        <div className={CARD}>
          <EmptyState title="Zatím žádná aktivita." action={{ href: '#zapsat-aktivitu', label: 'Zapsat aktivitu' }}>
            Zapsané hovory, e-maily a schůzky s partnerem se ukážou tady.
          </EmptyState>
        </div>
      ) : (
        <ActivityTimeline activities={activities} showAccount={false} />
      )}
      {/* Zápis aktivity u partnera. Číst šlo dřív, zapsat ne — takže hovor
          s kanálem bez zápisu schůzky neměl v CRM kam. */}
      <Card id="zapsat-aktivitu" title="Zapsat aktivitu" sub="Hovor, e-mail, schůzka nebo poznámka k partnerovi." className="mt-4 max-w-3xl scroll-mt-4">
        <ActivityForm
          action={createSalesActivity}
          accounts={[]}
          deals={[]}
          contacts={contacts}
          partnerId={partner.id}
        />
      </Card>

      <h2 id="registrace" className={H2}>Registrace v programech</h2>
      <DataTable mobile="cards" label="Registrace partnera" rows={regs} empty="Zatím žádné registrace v programech." columns={[
        { header: 'Program', cell: (r) => <Chip tone={toneForKey(r.program)}>{r.program}</Chip> },
        { header: 'Stav', cell: (r) => <Chip tone={toneForKey(r.status)}>{r.status}</Chip> },
      ]} />
    </>
  )
}
