import { LegalPage } from '@/components/web/poptavka'
import { pageMetadata } from '@/lib/web/content'
import { legalPageCopy } from '@/lib/web/poptavka/copy'

/** /ochrana-osobnich-udaju – šablona z copy.json se zástupci [DOPLNÍ KLIENT / PRÁVNÍK: …]. */
export const metadata = pageMetadata('/ochrana-osobnich-udaju')

export default function Page() {
  const { title, lead, sections } = legalPageCopy('/ochrana-osobnich-udaju')
  return <LegalPage title={title} lead={lead} sections={sections} />
}
