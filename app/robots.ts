import type { MetadataRoute } from 'next'
import { CANONICAL_ORIGIN } from '@/lib/web/redirects'
import { ROBOTS_DISALLOW } from '@/lib/web/poptavka/seo'

/**
 * /robots.txt – vše kromě košíku, potvrzení poptávky a interního Cockpitu.
 * MUSÍ ležet v kořeni app/ (Next ho v route group (web) nenajde, na rozdíl od sitemap.ts);
 * při přenosu do hlavního systému patří do jeho app/robots.ts.
 */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: '*', allow: '/', disallow: ROBOTS_DISALLOW },
    sitemap: `${CANONICAL_ORIGIN}/sitemap.xml`,
    host: CANONICAL_ORIGIN,
  }
}
