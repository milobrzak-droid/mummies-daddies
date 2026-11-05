import { BlogListPage } from '@/components/web/duvera'
import { duveraMetadata } from '@/lib/web/duvera/metadata'

/** /blog: výpis s filtrem štítků (?stitek=…), doporučené články, CTA na poptávku. */
export const metadata = duveraMetadata('/blog', { ogSlot: 'blog.svatebni-catering' })

export default function BlogPage() {
  return <BlogListPage />
}
