import { VenuesPage } from '@/components/web/duvera'
import { duveraMetadata } from '@/lib/web/duvera/metadata'

/** /prostory: partnerské eventové a svatební prostory, každý s poptávkou (?prostor=slug). */
export const metadata = duveraMetadata('/prostory', { ogSlot: 'prostory.hero' })

export default function ProstoryPage() {
  return <VenuesPage />
}
