import { notFound, redirect } from 'next/navigation'
import { ContactForm } from '@/components/ContactForm'
import { PageHeader } from '@/components/PageHeader'
import { SectionTabs, CLIENT_TABS } from '@/components/SectionTabs'
import { buttonClass } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { ClientsConfirmSubmit } from '@/components/ui/ClientsConfirmSubmit'
import { updateContact, deleteContact, deletePartnerContact } from '@/domain/crm/actions/contacts'
import { getContactById } from '@/domain/crm/queries/contacts'
import { isCurrentUserAdmin, listTeamMembers } from '@/lib/queries/team'
import { DoNotContactChip } from '@/components/DoNotContactChip'
import { formatDate } from '@/lib/format'

// Stránka kontaktu: úprava údajů, export (GDPR) a smazání. Kontakt klienta
// se běžně upravuje na místě v panelu detailu klienta (?tab=kontakty&kontakt=ID);
// sem vede odkaz z panelu (export, smazání), z hledání a od partnera – kontakt
// může viset na klientovi i na partnerovi a z obou míst se sem vede stejná cesta.
export default async function EditContact({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const contact = await getContactById(Number(id))
  if (!contact) notFound()
  // Smazání kontaktu je admin-only (rozhodnutí majitele 2026-09-28, stejně
  // jako GDPR export) — server akce to samy vynucují, tlačítko se jen
  // schovává, aby se non-admin vůbec nedostal k chybové hlášce.
  const isAdmin = await isCurrentUserAdmin()
  // Kdo a kdy nesouhlas s oslovením zapsal (0087, doplňuje databáze).
  let optOutInfo: string | undefined
  if (contact.do_not_contact && contact.do_not_contact_at) {
    const by = contact.do_not_contact_by
      ? (await listTeamMembers().catch(() => [])).find((m) => m.id === contact.do_not_contact_by)?.full_name ?? null
      : null
    optOutInfo = `Zapsáno ${formatDate(contact.do_not_contact_at)}${by ? ` (${by})` : ''}. Odškrtnutím se nesouhlas zruší.`
  }

  const back = contact.account_id
    ? `/cockpit/clients/${contact.account_id}?tab=kontakty`
    : `/cockpit/partners/${contact.partner_id}/edit`

  async function remove() {
    'use server'
    if (!contact) return
    if (contact.account_id) await deleteContact(contact.account_id, contact.id)
    else if (contact.partner_id) await deletePartnerContact(contact.partner_id, contact.id)
    redirect(back)
  }

  return (
    <>
      <PageHeader
        title="Upravit kontakt"
        eyebrow={contact.full_name}
        back={{ href: back, label: contact.account_id ? 'Kontakty klienta' : 'Partner' }}
      >
        {contact.do_not_contact && <DoNotContactChip />}
      </PageHeader>
      <SectionTabs tabs={CLIENT_TABS} label="Klienti a partneři" />

      <div className="max-w-2xl space-y-6">
        <Card id="kontakt" title="Údaje o kontaktu" sub="Jméno, role a spojení. Kontakt může viset na klientovi i na partnerovi.">
          <ContactForm
            action={updateContact.bind(null, contact.id)}
            initial={contact}
            submitLabel="Uložit změny"
            optOutInfo={optOutInfo}
          />
        </Card>

        <Card
          id="gdpr-export"
          title="Export údajů (GDPR)"
          sub="Stáhne vše, co o osobě evidujeme, jako JSON (čl. 15 GDPR). Jen pro administrátory."
        >
          <a href={`/cockpit/kontakty/${contact.id}/export`} download className={buttonClass('outline')}>
            Stáhnout export
          </a>
        </Card>

        {isAdmin && (
          // Smazání je nevratné: potvrzení na místě říká, co se stane.
          <Card
            id="smazat-kontakt"
            title="Smazat kontakt"
            sub="Smaže se jen kontaktní údaj. Zapsané schůzky a aktivity zůstanou, u nich se odkaz na kontakt jen vyprázdní."
          >
            <form action={remove}>
              <ClientsConfirmSubmit
                label="Smazat"
                confirmLabel="Smazat natrvalo"
                question={`Kontakt ${contact.full_name} se smaže a nejde vrátit.`}
                size="md"
              />
            </form>
          </Card>
        )}
      </div>
    </>
  )
}
