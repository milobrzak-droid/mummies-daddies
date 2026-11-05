import type { MetadataRoute } from 'next'
import { absoluteUrl, sitemapRows } from '@/lib/web/poptavka/seo'

/** /sitemap.xml – veřejné stránky webu (lib/web/poptavka/seo.ts). */
export default function sitemap(): MetadataRoute.Sitemap {
  return sitemapRows().map((r) => ({ url: absoluteUrl(r.path), changeFrequency: r.changeFrequency, priority: r.priority }))
}
