import { describe, expect, it, vi } from 'vitest'
import nextConfig, { ENFORCED_CSP, REPORT_ONLY_CSP } from '../next.config'
import robots from '../app/robots'

async function headerMap() {
  const rules = await nextConfig.headers!()
  expect(rules).toHaveLength(1)
  expect(rules[0].source).toBe('/:path*')
  return Object.fromEntries(rules[0].headers.map((h) => [h.key, h.value]))
}

describe('security headers', () => {
  it('sets the static hardening headers', async () => {
    const h = await headerMap()
    expect(h['Strict-Transport-Security']).toBe('max-age=63072000; includeSubDomains')
    expect(h['Strict-Transport-Security']).not.toContain('preload')
    expect(h['X-Content-Type-Options']).toBe('nosniff')
    expect(h['Referrer-Policy']).toBe('strict-origin-when-cross-origin')
    expect(h['X-Frame-Options']).toBe('DENY')
    expect(h['Cross-Origin-Opener-Policy']).toBe('same-origin')
    for (const f of ['camera=()', 'microphone=()', 'geolocation=()']) {
      expect(h['Permissions-Policy']).toContain(f)
    }
  })

  it('enforces the full CSP (login, Turnstile, self-hosted fonts, Next inline scripts)', async () => {
    const h = await headerMap()
    const csp = h['Content-Security-Policy']
    expect(csp).toBe(ENFORCED_CSP)
    expect(csp).toContain("default-src 'self'")
    expect(csp).toMatch(/script-src 'self' 'unsafe-inline' https:\/\/challenges\.cloudflare\.com(;| )/)
    expect(csp).toMatch(/frame-src [^;]*https:\/\/challenges\.cloudflare\.com/)
    expect(csp).toMatch(/connect-src 'self'[^;]*https:\/\/challenges\.cloudflare\.com/)
    expect(csp).toContain("style-src 'self' 'unsafe-inline'")
    expect(csp).toContain("font-src 'self' data:")
    expect(csp).toContain("img-src 'self' data:") // QR kód 2FA je data: URL
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("base-uri 'self'")
    expect(csp).toContain("object-src 'none'")
    expect(csp).toMatch(/form-action 'self' https: http:\/\/localhost:\* http:\/\/127\.0\.0\.1:\*/)
    // Testy běží s NODE_ENV=test (ne production) → dev výjimky; produkční
    // build je nesmí mít (ověřuje test níže s NODE_ENV=production).
    expect(csp).not.toContain('vercel.live')
  })

  it('keeps a stricter candidate as Report-Only', async () => {
    const h = await headerMap()
    const csp = h['Content-Security-Policy-Report-Only']
    expect(csp).toBe(REPORT_ONLY_CSP)
    expect(csp).not.toBe(ENFORCED_CSP)
    expect(csp).toContain("script-src-attr 'none'")
    expect(csp).toContain("worker-src 'none'")
    expect(csp).toMatch(/img-src 'self' data:(;| )/)
    expect(csp).not.toMatch(/connect-src[^;]*supabase/)
    expect(csp).toMatch(/frame-src [^;]*https:\/\/challenges\.cloudflare\.com/)
  })

  it('points violations of both policies at the report handler', async () => {
    const h = await headerMap()
    for (const csp of [h['Content-Security-Policy'], h['Content-Security-Policy-Report-Only']]) {
      expect(csp).toContain('report-uri /api/csp-report')
      expect(csp).toContain('report-to csp')
    }
    expect(h['Reporting-Endpoints']).toBe('csp="/api/csp-report"')
  })

  it('production build: no eval, no dev websocket, Vercel toolbar only on preview, upgrade on Vercel', async () => {
    const load = async (env: Record<string, string | undefined>) => {
      vi.resetModules()
      for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v as string)
      try {
        return (await import('../next.config')) as typeof import('../next.config')
      } finally {
        vi.unstubAllEnvs()
      }
    }
    const prod = await load({ NODE_ENV: 'production', VERCEL: '1', VERCEL_ENV: 'production', SUPABASE_URL: 'https://abc.supabase.co' })
    for (const csp of [prod.ENFORCED_CSP, prod.REPORT_ONLY_CSP]) {
      expect(csp).not.toContain('unsafe-eval')
      expect(csp).not.toMatch(/connect-src[^;]* ws:/)
      expect(csp).not.toContain('vercel.live')
      expect(csp).toContain('upgrade-insecure-requests')
    }
    expect(prod.ENFORCED_CSP).toMatch(/connect-src [^;]*https:\/\/abc\.supabase\.co wss:\/\/abc\.supabase\.co/)

    const preview = await load({ NODE_ENV: 'production', VERCEL: '1', VERCEL_ENV: 'preview' })
    expect(preview.ENFORCED_CSP).toMatch(/script-src [^;]*https:\/\/vercel\.live/)
    expect(preview.ENFORCED_CSP).toMatch(/frame-src [^;]*https:\/\/vercel\.live/)

    const localStart = await load({ NODE_ENV: 'production', VERCEL: undefined, VERCEL_ENV: undefined })
    expect(localStart.ENFORCED_CSP).not.toContain('upgrade-insecure-requests')
  })
})

describe('robots', () => {
  it('veřejný web se indexuje, Cockpit, přihlášení a API ne', () => {
    const r = robots()
    expect(r.rules).toEqual({ userAgent: '*', allow: '/', disallow: ['/cockpit', '/login', '/auth', '/api', '/kosik', '/poptavka/odeslano'] })
    expect(r.sitemap).toBe('https://www.mummiesdaddies.com/sitemap.xml')
  })
})
