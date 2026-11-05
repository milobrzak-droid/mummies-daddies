import { CateringOverview } from '@/components/web/catering'
import { pageMetadata } from '@/lib/web/content'

export const metadata = pageMetadata('/catering')

export default function CateringPage() {
  return <CateringOverview />
}
