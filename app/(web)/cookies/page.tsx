import { CookieSettingsButton, LegalPage } from '@/components/web/poptavka'
import { pageMetadata } from '@/lib/web/content'
import { legalPageCopy } from '@/lib/web/poptavka/copy'

/** /cookies – šablona z copy.json; „Nastavit cookies“ otevře lištu souhlasu (až bude). */
export const metadata = pageMetadata('/cookies')

export default function CookiesPage() {
  const { title, lead, sections } = legalPageCopy('/cookies')
  const actions = Object.fromEntries(sections.filter((s) => s.cta).map((s) => [s.id, <CookieSettingsButton key={s.id} label={s.cta!} />]))
  return <LegalPage title={title} lead={lead} sections={sections} actions={actions} />
}
