import { NotFoundView } from '@/components/web/poptavka'
import { inquiryHref } from '@/lib/web/inquiry-link'
import { notFoundCopy } from '@/lib/web/poptavka/copy'

/**
 * 404 webu (v layoutu webu: hlavička, patička). Vykreslí se při notFound()
 * v (web) i pro neznámé adresy (catch-all [...nenalezeno]). Next sám přidá
 * <meta name="robots" content="noindex">; titulek 404 nastavuje catch-all.
 */
export default function WebNotFound() {
  const c = notFoundCopy()
  return <NotFoundView heading={c.heading} text={c.text} home={c.home} inquiry={c.inquiry} inquiryHref={inquiryHref()} />
}
