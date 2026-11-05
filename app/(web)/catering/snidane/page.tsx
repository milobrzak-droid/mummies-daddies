import { CateringTypePage } from '@/components/web/catering'
import { pageMetadata } from '@/lib/web/content'

export const metadata = pageMetadata('/catering/snidane')

export default function CateringSnidanePage() {
  return <CateringTypePage slug="snidane" />
}
