import { Chip } from '@/components/Chip'
import { DO_NOT_CONTACT_LABEL, contactOptOut, type OptOutFields } from '@/domain/crm/outreachContacts'

// Štítek „Nesouhlasí s oslovením" (contact.do_not_contact, 0087, nebo
// výslovný nesouhlas v poznámce). U kontaktu bez doplňku, u firmy může nést
// počet („1 z 3") — kolik jejích lidí nesouhlasí.
export function DoNotContactChip({ detail, title }: { detail?: string; title?: string }) {
  return (
    <span title={title} className="inline-flex">
      <Chip tone="neg">{detail ? `${DO_NOT_CONTACT_LABEL} (${detail})` : DO_NOT_CONTACT_LABEL}</Chip>
    </span>
  )
}

/**
 * Štítek u kontaktu: políčko „Nesouhlasí s oslovením", nebo (druhá pojistka)
 * výslovný nesouhlas v poznámce. Jinak nic.
 */
export function ContactOptOutChip({ contact }: { contact: OptOutFields }) {
  const source = contactOptOut(contact)
  if (source === 'flag') return <DoNotContactChip />
  if (source === 'note') return <DoNotContactChip detail="podle poznámky" title="Poznámka u kontaktu uvádí nesouhlas s oslovením." />
  return null
}
