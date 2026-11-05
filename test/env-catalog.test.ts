// @vitest-environment node
// Katalog proměnných (scripts/env-catalog.mjs) a kontrola nasazení
// (scripts/setup-check-lib.mjs) — balík P8. Bez sítě: fetch je mock.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ENV_CATALOG, PLATFORM_VARS, renderEnvExample } from '../scripts/env-catalog.mjs'
import {
  checkAnthropic,
  checkEnv,
  checkGmail,
  checkSupabase,
  checkTurnstile,
  runChecks,
  secretValues,
} from '../scripts/setup-check-lib.mjs'

const ROOT = join(__dirname, '..')
const names = new Set(ENV_CATALOG.map((v) => v.name))

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(ts|tsx|mjs)$/.test(name)) out.push(p)
  }
  return out
}

describe('katalog proměnných', () => {
  it('každá proměnná, kterou kód čte, je v katalogu (nebo ji nastavuje platforma)', () => {
    const files = ['app', 'lib', 'core', 'domain', 'connectors', 'config', 'worker', 'scripts', 'components']
      .flatMap((d) => walk(join(ROOT, d)))
      .concat([join(ROOT, 'proxy.ts'), join(ROOT, 'next.config.ts')])
    const used = new Set<string>()
    for (const f of files) {
      const src = readFileSync(f, 'utf8')
      for (const m of src.matchAll(/(?:process\.env|\benv\??)\.([A-Z][A-Z0-9_]{2,})/g)) used.add(m[1])
      for (const m of src.matchAll(/(?:process\.env|\benv)\[['"]([A-Z][A-Z0-9_]{2,})['"]\]/g)) used.add(m[1])
    }
    // Názvy přes konstanty (connectors/idoklad: IDOKLAD_ENV).
    for (const m of readFileSync(join(ROOT, 'connectors/idoklad/index.ts'), 'utf8').matchAll(/'(IDOKLAD_[A-Z_]+)'/g)) used.add(m[1])
    const missing = [...used].filter((n) => !names.has(n) && !PLATFORM_VARS.has(n)).sort()
    expect(missing).toEqual([])
    expect(used.size).toBeGreaterThan(30)
  })

  it('jména jsou unikátní a podmínky odkazují na existující přepínač', () => {
    expect(names.size).toBe(ENV_CATALOG.length)
    for (const v of ENV_CATALOG) {
      expect(['always', 'no'].includes(v.required) || v.required.startsWith('if:'), v.name).toBe(true)
      if (v.required.startsWith('if:')) expect(names.has(v.required.slice(3)), v.name).toBe(true)
      expect(v.purpose.length, v.name).toBeGreaterThan(3)
    }
  })

  it('.env.example je vygenerovaný z katalogu (node scripts/setup-check.mjs --write-env-example)', () => {
    expect(readFileSync(join(ROOT, '.env.example'), 'utf8')).toBe(renderEnvExample())
  })

  it('tabulka v docs/NASAZENI.md obsahuje každou proměnnou mimo původní integrace', () => {
    const doc = readFileSync(join(ROOT, 'docs/NASAZENI.md'), 'utf8')
    for (const v of ENV_CATALOG) {
      if (v.group.startsWith('Původní')) continue
      expect(doc, v.name).toContain(`\`${v.name}\``)
    }
  })
})

const GOOD = {
  SUPABASE_URL: 'https://abcd.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_xyz',
  SUPABASE_SECRET_KEY: 'sb_secret_TOPSECRET123',
  APP_URL: 'https://www.mummiesdaddies.com',
  CRON_SECRET: 'c'.repeat(64),
  TURNSTILE_SECRET_KEY: '0xTURNSTILESECRET',
  NEXT_PUBLIC_TURNSTILE_SITE_KEY: '0xSITE',
  OPS_ALARM_ENABLED: 'true',
  ALERT_WEBHOOK_URL: 'https://hook.example/abc',
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

describe('checkEnv', () => {
  it('kompletní nastavení bez chyb', () => {
    expect(checkEnv(GOOD).filter((r) => r.level === 'error')).toEqual([])
  })

  it('chybějící povinné, podmíněně povinné a nebezpečné hodnoty = chyba', () => {
    const r = checkEnv({ ...GOOD, CRON_SECRET: 'kratke', MFA_ENFORCED: 'false', INQUIRY_AGENT_ENABLED: 'true', SUPABASE_SECRET_KEY: GOOD.SUPABASE_PUBLISHABLE_KEY })
    const errs = r.filter((x) => x.level === 'error').map((x) => x.name)
    expect(errs).toEqual(expect.arrayContaining(['CRON_SECRET', 'MFA_ENFORCED', 'ANTHROPIC_API_KEY', 'GMAIL_CLIENT_ID', 'GMAIL_CLIENT_SECRET', 'SUPABASE_SECRET_KEY']))
  })

  it('žádná zpráva neobsahuje hodnotu tajemství', () => {
    const all = JSON.stringify(checkEnv({ ...GOOD, CRON_SECRET: 'x'.repeat(10) }))
    for (const s of secretValues(GOOD)) expect(all).not.toContain(s)
  })

  it('zapnutá integrace Microsoft 365 = varování', () => {
    expect(checkEnv({ ...GOOD, OUTLOOK_MAIL_SYNC_ENABLED: 'true' }).find((r) => r.name === 'OUTLOOK_MAIL_SYNC_ENABLED')?.level).toBe('warn')
  })
})

describe('kontroly služeb (mock fetch)', () => {
  it('Supabase: Auth i ledger; jiná poslední migrace = varování, chybějící ledger = chyba', async () => {
    const f = vi.fn(async (url: string) => (url.includes('/auth/') ? json(200, {}) : json(200, [{ version: '0106' }])))
    expect((await checkSupabase(GOOD, f, '0106')).map((r) => r.level)).toEqual(['ok', 'ok'])
    expect((await checkSupabase(GOOD, f, '0107'))[1].level).toBe('warn')
    const calls = f.mock.calls.map((c) => String(c[0]))
    expect(calls.some((u) => u.includes('TOPSECRET'))).toBe(false)
    const missing = vi.fn(async (url: string) => (url.includes('/auth/') ? json(200, {}) : json(404, { code: 'PGRST205' })))
    expect((await checkSupabase(GOOD, missing, '0106'))[1]).toMatchObject({ level: 'error', message: expect.stringMatching(/není založená/) })
  })

  it('Turnstile: neplatné tajemství = chyba, neplatná odpověď = klíč OK', async () => {
    expect((await checkTurnstile(GOOD, async () => json(200, { success: false, 'error-codes': ['invalid-input-secret'] })))[0].level).toBe('error')
    expect((await checkTurnstile(GOOD, async () => json(200, { success: false, 'error-codes': ['invalid-input-response'] })))[0].level).toBe('ok')
  })

  it('Gmail: invalid_grant s testovacím tokenem = klient OK; invalid_client = chyba; rozsahy tokenu', async () => {
    const env = { ...GOOD, GMAIL_CLIENT_ID: 'id.apps.googleusercontent.com', GMAIL_CLIENT_SECRET: 'GOCSPX-secret' }
    expect((await checkGmail(env, async () => json(400, { error: 'invalid_grant' })))[0].level).toBe('ok')
    expect((await checkGmail(env, async () => json(401, { error: 'invalid_client' })))[0].level).toBe('error')
    const withToken = { ...env, GMAIL_CHECK_REFRESH_TOKEN: '1//refresh' }
    expect((await checkGmail(withToken, async () => json(400, { error: 'invalid_grant' })))[0].message).toMatch(/znovu autorizovat/)
    const scopes = 'https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/gmail.send'
    expect((await checkGmail(withToken, async () => json(200, { access_token: 'ya29', scope: scopes })))[0].level).toBe('ok')
    expect((await checkGmail(withToken, async () => json(200, { access_token: 'ya29', scope: scopes.split(' ')[0] })))[0].message).toMatch(/gmail\.send/)
  })

  it('Anthropic: kredit, neplatný klíč, OK', async () => {
    const env = { ...GOOD, ANTHROPIC_API_KEY: 'sk-ant-xyz' }
    expect((await checkAnthropic(env, async () => json(200, { content: [] })))[0].level).toBe('ok')
    expect((await checkAnthropic(env, async () => json(401, { error: { message: 'invalid x-api-key' } })))[0].message).toMatch(/neplatí/)
    expect((await checkAnthropic(env, async () => json(400, { error: { message: 'Your credit balance is too low' } })))[0].message).toMatch(/kredit/)
  })

  it('bez --live se placené služby nevolají; --offline nevolá nic', async () => {
    const f = vi.fn(async () => json(200, []))
    await runChecks({ ...GOOD, ANTHROPIC_API_KEY: 'sk-ant', MAPY_API_KEY: 'm' }, { fetchImpl: f, latestVersion: '0106' } as never)
    const urls = f.mock.calls.map((c) => String((c as unknown[])[0]))
    expect(urls.some((u) => u.includes('anthropic') || u.includes('mapy'))).toBe(false)
    const g = vi.fn()
    await runChecks(GOOD, { fetchImpl: g, offline: true })
    expect(g).not.toHaveBeenCalled()
  })
})
