import { AboutPage } from '@/components/web/duvera'
import { duveraMetadata } from '@/lib/web/duvera/metadata'

/** /o-nas: příběh Rudy a Moniky, tým, hodnoty, kuchyně, čísla, kariéra. */
export const metadata = duveraMetadata('/o-nas', { ogSlot: 'o-nas.rudolf' })

export default function ONasPage() {
  return <AboutPage />
}
