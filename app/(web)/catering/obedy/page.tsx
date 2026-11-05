import { CateringTypePage } from '@/components/web/catering'
import { pageMetadata } from '@/lib/web/content'

export const metadata = pageMetadata('/catering/obedy')

export default function CateringObedyPage() {
  return <CateringTypePage slug="obedy" />
}
