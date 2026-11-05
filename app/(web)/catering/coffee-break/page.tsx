import { CateringTypePage } from '@/components/web/catering'
import { pageMetadata } from '@/lib/web/content'

export const metadata = pageMetadata('/catering/coffee-break')

export default function CateringCoffeeBreakPage() {
  return <CateringTypePage slug="coffee-break" />
}
