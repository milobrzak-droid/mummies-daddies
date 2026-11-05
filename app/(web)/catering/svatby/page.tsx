import { CateringTypePage } from '@/components/web/catering'
import { pageMetadata } from '@/lib/web/content'

export const metadata = pageMetadata('/catering/svatby')

export default function CateringSvatbyPage() {
  return <CateringTypePage slug="svatby" />
}
