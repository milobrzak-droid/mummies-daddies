import { CateringTypePage } from '@/components/web/catering'
import { pageMetadata } from '@/lib/web/content'

export const metadata = pageMetadata('/catering/teambuilding')

export default function CateringTeambuildingPage() {
  return <CateringTypePage slug="teambuilding" />
}
