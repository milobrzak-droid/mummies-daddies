import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'
import { describe, expect, test } from 'vitest'

// Proxy (lib/supabase/middleware.ts) pouští některé prefixy /api bez cookie
// session, protože si autentizaci řeší route sama. Kdyby přibyla nová routa pod
// takovým prefixem a autentizaci zapomněla, prošla by bez povšimnutí (N12 z
// bezpečnostní revize 30. 9.). Tenhle test prochází VŠECHNY app/api/**/route.ts
// a každou zařadí do jedné z tříd; neznámá routa (nebo veřejný prefix v proxy
// bez zařazení) test shodí. Je to kontrola textu zdrojáku, ne běhu: hlídá, že
// brána v souboru je a že je zařazená. Skutečné chování hlídají testy jednotlivých
// rout (api-key-auth, mail-webhook-route, *-cron, ms-oauth-routes).

const ROOT = join(__dirname, '..')

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (name === 'route.ts') out.push(relative(ROOT, p).split('\\').join('/'))
  }
  return out
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1')
}

const read = (file: string) => stripComments(readFileSync(join(ROOT, file), 'utf8'))

type Guard = { name: string; test: (src: string) => boolean }

const API_KEY: Guard = { name: 'requireApiKey(', test: (s) => /\brequireApiKey\(/.test(s) }
const CRON: Guard = {
  name: 'CRON_SECRET + porovnání v konstantním čase',
  test: (s) => /CRON_SECRET/.test(s) && /(timingSafeEqual|isCronAuthorized)\(/.test(s),
}
const MS_WEBHOOK: Guard = { name: 'ověření clientState', test: (s) => /(assessMailWebhook|clientState)/.test(s) }
const WEB_FORM: Guard = { name: 'ověření Turnstile (formulář veřejného webu)', test: (s) => /turnstile/i.test(s) }
const SESSION: Guard = { name: 'tryRequireUser({ aal2: true })', test: (s) => /(tryRequireUser|requireUser)\(\{\s*aal2:\s*true\s*\}\)/.test(s) }
const UNSUBSCRIBE_TOKEN: Guard = { name: 'podepsaný token odhlášení (verifyUnsubscribeToken)', test: (s) => /\bverifyUnsubscribeToken\(/.test(s) }
// Veřejné záměrně (bez cookie i bez klíče); důvod je u každé položky.
const OPEN = (why: string): Guard => ({ name: `záměrně veřejné: ${why}`, test: () => true })

// Prefix (nebo přesná cesta) → brána, kterou musí mít každá routa pod ním.
// Pořadí: nejdřív přesné cesty, pak prefixy.
const CLASSES: { match: (route: string) => boolean; label: string; guard: Guard; publicInProxy: boolean }[] = [
  { label: '/api/v1', match: (r) => r.startsWith('app/api/v1/'), guard: API_KEY, publicInProxy: true },
  { label: '/api/mcp', match: (r) => r.startsWith('app/api/mcp/'), guard: API_KEY, publicInProxy: true },
  // Odhlášení z obchodních sdělení (P7): odkaz z e-mailu a One-Click POST
  // (RFC 8058) — Turnstile tu být nemůže, bránou je podepsaný HMAC token.
  // (V proxy ji pouští prefix /api/web, vlastní výjimku nemá — proto publicInProxy: false.)
  { label: '/api/web/odhlaseni', match: (r) => r === 'app/api/web/odhlaseni/route.ts', guard: UNSUBSCRIBE_TOKEN, publicInProxy: false },
  // Veřejná API webu (formuláře, balík P6): každá routa ověřuje Turnstile.
  { label: '/api/web', match: (r) => r.startsWith('app/api/web/'), guard: WEB_FORM, publicInProxy: true },
  { label: '/api/cron', match: (r) => r.startsWith('app/api/cron/'), guard: CRON, publicInProxy: true },
  { label: '/api/ms/notifications', match: (r) => r === 'app/api/ms/notifications/route.ts', guard: MS_WEBHOOK, publicInProxy: true },
  { label: '/api/oauth/register', match: (r) => r === 'app/api/oauth/register/route.ts', guard: OPEN('DCR, redirect_uri jen z allowlistu, limit registrací'), publicInProxy: true },
  { label: '/api/oauth/token', match: (r) => r === 'app/api/oauth/token/route.ts', guard: OPEN('výměna kódu/refresh tokenu, ověřuje PKCE a hash'), publicInProxy: true },
  { label: '/api/csp-report', match: (r) => r === 'app/api/csp-report/route.ts', guard: OPEN('prohlížeč posílá CSP hlášení bez session, jen se loguje'), publicInProxy: true },
  // Za přihlášením: proxy + brána v handleru (interní role, AAL2).
  { label: '/api/ares', match: (r) => r === 'app/api/ares/route.ts', guard: SESSION, publicInProxy: false },
  { label: '/api/fx', match: (r) => r === 'app/api/fx/route.ts', guard: SESSION, publicInProxy: false },
  { label: '/api/ms/connect', match: (r) => r === 'app/api/ms/connect/route.ts', guard: SESSION, publicInProxy: false },
  { label: '/api/ms/callback', match: (r) => r === 'app/api/ms/callback/route.ts', guard: SESSION, publicInProxy: false },
]

const routes = walk(join(ROOT, 'app/api')).sort()

describe('brány route handlerů pod app/api (N12)', () => {
  test('každá routa je zařazená a má svou bránu', () => {
    const problems: string[] = []
    for (const route of routes) {
      const cls = CLASSES.find((c) => c.match(route))
      if (!cls) {
        problems.push(`${route}: routa není zařazená v test/route-auth-guard.test.ts (doplň třídu a bránu)`)
        continue
      }
      if (!cls.guard.test(read(route))) problems.push(`${route}: chybí brána „${cls.guard.name}“ (třída ${cls.label})`)
    }
    expect(problems).toEqual([])
  })

  test('nalezeno aspoň to, co dnes v repozitáři je (test neprochází naprázdno)', () => {
    expect(routes.length).toBeGreaterThanOrEqual(20)
    expect(routes).toContain('app/api/mcp/route.ts')
    expect(routes).toContain('app/api/cron/follow-ups/route.ts')
  })

  test('veřejné výjimky v proxy odpovídají třídám bez brány session', () => {
    const proxy = stripComments(readFileSync(join(ROOT, 'lib/supabase/middleware.ts'), 'utf8'))
    const found = new Set<string>()
    for (const m of proxy.matchAll(/matchesSegment\(path, '(\/api\/[^']+)'\)/g)) found.add(m[1])
    for (const m of proxy.matchAll(/path === '(\/api\/[^']+)'/g)) found.add(m[1])
    const expected = new Set(CLASSES.filter((c) => c.publicInProxy).map((c) => c.label))
    // Každá veřejná cesta v proxy musí být ve třídách (jinak by tam byla routa bez zařazení).
    expect([...found].filter((p) => !expected.has(p)).sort()).toEqual([])
    // A obráceně: třída označená jako veřejná musí být v proxy opravdu pouštěná.
    expect([...expected].filter((p) => !found.has(p)).sort()).toEqual([])
  })

  test('tvrdá kontrola: routa pod veřejným prefixem bez brány by test shodila', () => {
    const fake = "export async function GET() { return Response.json({ data: 1 }) }"
    expect(API_KEY.test(stripComments(fake))).toBe(false)
    expect(CRON.test(stripComments(fake))).toBe(false)
    expect(SESSION.test(stripComments(fake))).toBe(false)
  })
})
