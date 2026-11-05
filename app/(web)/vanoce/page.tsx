import { ChristmasPage } from '@/components/web/duvera'
import { duveraMetadata } from '@/lib/web/duvera/metadata'

/** /vanoce: sezónní landing (večírek a raut, checklist, cukroví, vánoční cheesecake, uzávěrka). */
export const metadata = duveraMetadata('/vanoce', { ogSlot: 'vanoce.hero' })

export default function VanocePage() {
  return <ChristmasPage />
}
