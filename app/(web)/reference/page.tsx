import { ReferenceListPage } from '@/components/web/duvera'
import { duveraMetadata } from '@/lib/web/duvera/metadata'

/** /reference: případové studie s filtrem (Firemní · Svatby · Oslavy), loga a hodnocení (doplní klient). */
export const metadata = duveraMetadata('/reference', { ogSlot: 'reference.jitka-rostislav.cover' })

export default function ReferencePage() {
  return <ReferenceListPage />
}
