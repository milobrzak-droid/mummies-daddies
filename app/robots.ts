import type { MetadataRoute } from 'next'
import { ROBOTS_DISALLOW } from '@/lib/web/poptavka/seo'
import { CANONICAL_ORIGIN } from '@/lib/web/redirects'

// Veřejný web se indexuje; interní Cockpit, přihlášení a API ne. Z webu
// navíc košík a potvrzení poptávky (lib/web/poptavka/seo.ts). Mapa webu
// je app/(web)/sitemap.ts.
const SYSTEM_DISALLOW = ['/cockpit', '/login', '/auth', '/api'] as const

export default function robots(): MetadataRoute.Robots {
  const disallow = [...new Set([...SYSTEM_DISALLOW, ...ROBOTS_DISALLOW])]
  return {
    rules: { userAgent: '*', allow: '/', disallow },
    sitemap: `${CANONICAL_ORIGIN}/sitemap.xml`,
    host: CANONICAL_ORIGIN,
  }
}
