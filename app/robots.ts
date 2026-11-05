import type { MetadataRoute } from 'next'

// Veřejný web se indexuje; interní Cockpit, přihlášení a API ne.
export default function robots(): MetadataRoute.Robots {
  return { rules: { userAgent: '*', allow: '/', disallow: ['/cockpit', '/login', '/auth', '/api'] } }
}
