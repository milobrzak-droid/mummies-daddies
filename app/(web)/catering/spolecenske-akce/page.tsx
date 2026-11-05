import { CateringTypePage } from '@/components/web/catering'
import { pageMetadata } from '@/lib/web/content'

export const metadata = pageMetadata('/catering/spolecenske-akce')

export default function CateringSpolecenskeAkcePage() {
  return <CateringTypePage slug="spolecenske-akce" />
}
