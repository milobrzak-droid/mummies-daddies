/**
 * Mapa webu pro sitemap.xml a pravidla robots.txt. SERVER-ONLY (copy.json).
 * Do sitemapy jdou stránky z copy.json, které na webu skutečně jsou, plus
 * články blogu; ne košík, potvrzení, interní Cockpit ani /en (fáze 2).
 */
import { allPages } from '../content'
import { BLOG_ARTICLES } from '../duvera/blog'
import { CANONICAL_ORIGIN } from '../redirects'

/** Stránky z copy.json, které do sitemapy nepatří. */
export const SITEMAP_EXCLUDE = new Set(['/kosik', '/cockpit', '/en'])
/** Cesty, které roboti nemají procházet. */
export const ROBOTS_DISALLOW = ['/kosik', '/poptavka/odeslano', '/cockpit']

export interface SitemapRow {
  path: string
  priority: number
  changeFrequency: 'weekly' | 'monthly' | 'yearly'
}

function priorityOf(path: string): number {
  if (path === '/') return 1
  if (path === '/catering' || path === '/poptavka') return 0.9
  if (path.startsWith('/catering/')) return 0.8
  if (['/obchodni-podminky', '/ochrana-osobnich-udaju', '/cookies'].includes(path)) return 0.2
  if (path.startsWith('/blog/')) return 0.5
  return 0.6
}

export function sitemapRows(): SitemapRow[] {
  const paths = [
    ...allPages().map((p) => p.path).filter((p) => !p.includes('[') && !SITEMAP_EXCLUDE.has(p)),
    ...BLOG_ARTICLES.map((a) => `/blog/${a.slug}`),
  ]
  return [...new Set(paths)].map((path) => ({
    path,
    priority: priorityOf(path),
    changeFrequency: path === '/' || path === '/blog' ? 'weekly' : priorityOf(path) <= 0.2 ? 'yearly' : 'monthly',
  }))
}

export const absoluteUrl = (path: string) => `${CANONICAL_ORIGIN}${path === '/' ? '' : path}`
