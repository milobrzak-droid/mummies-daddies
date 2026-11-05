import { LegalPage } from '@/components/web/poptavka'
import { pageMetadata } from '@/lib/web/content'
import { legalPageCopy } from '@/lib/web/poptavka/copy'

/** /obchodni-podminky – šablona z copy.json se zástupci [DOPLNÍ KLIENT / PRÁVNÍK: …]. */
export const metadata = pageMetadata('/obchodni-podminky')

export default function Page() {
  const { title, lead, sections } = legalPageCopy('/obchodni-podminky')
  return <LegalPage title={title} lead={lead} sections={sections} />
}
