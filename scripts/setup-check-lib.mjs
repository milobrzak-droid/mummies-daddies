// Kontrola nasazení — logika pro scripts/setup-check.mjs (testovatelná bez sítě:
// fetch se předává). Výsledek je seznam { level, name, message }; hodnoty
// tajemství se do zpráv NIKDY nedostanou (zprávy jsou pevné texty, k tomu
// výstup prochází redakcí všech tajných hodnot).

import { ENV_CATALOG, isRequired } from './env-catalog.mjs'

/** @typedef {{ level: 'ok' | 'warn' | 'error' | 'skip', name: string, message: string }} CheckResult */

export const ANTHROPIC_PING_MODEL = 'claude-opus-5-5'
const TIMEOUT_MS = 15_000

const ok = (name, message) => ({ level: 'ok', name, message })
const warn = (name, message) => ({ level: 'warn', name, message })
const error = (name, message) => ({ level: 'error', name, message })
const skip = (name, message) => ({ level: 'skip', name, message })

const has = (env, k) => typeof env[k] === 'string' && env[k].trim() !== ''

/** Tajné hodnoty z env (pro redakci výstupu). */
export function secretValues(env) {
  return ENV_CATALOG.filter((v) => v.secret && has(env, v.name)).map((v) => env[v.name].trim()).filter((s) => s.length >= 4)
}

function httpsUrl(raw) {
  try {
    const u = new URL(raw)
    return u.protocol === 'https:' ? u : null
  } catch {
    return null
  }
}

/** 1) Proměnné: povinné, formát, nebezpečná nastavení. Bez sítě. */
export function checkEnv(env) {
  /** @type {CheckResult[]} */
  const out = []
  for (const v of ENV_CATALOG) {
    if (isRequired(v, env) && !has(env, v.name)) {
      const why = v.required.startsWith('if:') ? ` (zapnuto ${v.required.slice(3)})` : ''
      out.push(error(v.name, `chybí povinná proměnná${why} — ${v.where}`))
    }
  }

  if (has(env, 'SUPABASE_URL')) {
    const u = httpsUrl(env.SUPABASE_URL)
    if (!u) out.push(error('SUPABASE_URL', 'není platná https adresa'))
    else if (!u.hostname.endsWith('.supabase.co')) out.push(warn('SUPABASE_URL', 'nekončí na .supabase.co — opravdu správný projekt?'))
    else out.push(ok('SUPABASE_URL', 'nastaveno'))
  }
  if (has(env, 'SUPABASE_PUBLISHABLE_KEY') && !env.SUPABASE_PUBLISHABLE_KEY.startsWith('sb_publishable_')) {
    out.push(warn('SUPABASE_PUBLISHABLE_KEY', 'nezačíná sb_publishable_ (starý anon JWT funguje, ale doporučený je nový klíč)'))
  }
  if (has(env, 'SUPABASE_SECRET_KEY')) {
    if (has(env, 'SUPABASE_PUBLISHABLE_KEY') && env.SUPABASE_SECRET_KEY.trim() === env.SUPABASE_PUBLISHABLE_KEY.trim()) {
      out.push(error('SUPABASE_SECRET_KEY', 'je stejný jako publishable klíč — zaměněné hodnoty'))
    } else if (env.SUPABASE_SECRET_KEY.startsWith('sb_publishable_')) {
      out.push(error('SUPABASE_SECRET_KEY', 'obsahuje publishable klíč místo secret'))
    }
  }
  if (has(env, 'APP_URL')) {
    const u = httpsUrl(env.APP_URL)
    if (!u) out.push(error('APP_URL', 'musí být https adresa'))
    else out.push(ok('APP_URL', `veřejná adresa ${u.origin}`))
  }
  if (has(env, 'CRON_SECRET') && env.CRON_SECRET.trim().length < 32) {
    out.push(error('CRON_SECRET', 'je kratší než 32 znaků — vygenerovat: openssl rand -hex 32'))
  }
  if (env.MFA_ENFORCED === 'false') out.push(error('MFA_ENFORCED', 'dvoufázové přihlášení je VYPNUTÉ — v produkci nepřípustné'))
  if (has(env, 'ALERT_WEBHOOK_URL') && !httpsUrl(env.ALERT_WEBHOOK_URL)) out.push(error('ALERT_WEBHOOK_URL', 'musí být https adresa'))
  if (env.OPS_ALARM_ENABLED !== 'true') out.push(warn('OPS_ALARM_ENABLED', 'alarm do 15 minut je vypnutý (docs/PROVOZ.md)'))

  for (const legacy of ['NEXT_PUBLIC_SUPABASE_URL', 'NEXT_PUBLIC_SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']) {
    if (has(env, legacy)) out.push(warn(legacy, 'starý název proměnné — nahradit novým (viz docs/NASAZENI.md)'))
  }
  for (const graph of ['OUTLOOK_MAIL_SYNC_ENABLED', 'OUTLOOK_MAIL_WEBHOOK_ENABLED', 'DIGEST_SEND_ENABLED', 'SHAREPOINT_DOC_SYNC_ENABLED', 'MAIL_CONTENT_INTAKE_ENABLED', 'MAIL_OFFER_ATTACHMENT_ENABLED', 'CAPABILITY_AUTO_INTAKE_ENABLED']) {
    if (env[graph] === 'true') out.push(warn(graph, 'zapnutá integrace Microsoft 365 — klient má Google Workspace, vypnout'))
  }
  if (env.AGENT_OUTBOX_ENABLED === 'true' && env.INQUIRY_AGENT_ENABLED !== 'true') {
    out.push(warn('AGENT_OUTBOX_ENABLED', 'outbox je zapnutý bez agenta — odchází jen follow-upy a web'))
  }
  return out
}

async function timedFetch(fetchImpl, url, init = {}) {
  return fetchImpl(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) })
}

async function readJson(res) {
  try {
    return await res.json()
  } catch {
    return null
  }
}

/** 2a) Supabase: Auth odpovídá, servisní klíč čte ledger, poslední migrace = repo. */
export async function checkSupabase(env, fetchImpl, latestVersion) {
  if (!has(env, 'SUPABASE_URL') || !httpsUrl(env.SUPABASE_URL)) return [skip('Supabase', 'bez platné SUPABASE_URL')]
  const base = env.SUPABASE_URL.replace(/\/$/, '')
  const out = []
  try {
    if (has(env, 'SUPABASE_PUBLISHABLE_KEY')) {
      const res = await timedFetch(fetchImpl, `${base}/auth/v1/health`, { headers: { apikey: env.SUPABASE_PUBLISHABLE_KEY.trim() } })
      out.push(res.ok ? ok('Supabase Auth', 'odpovídá') : error('Supabase Auth', `HTTP ${res.status} — špatný projekt nebo publishable klíč`))
    }
    if (has(env, 'SUPABASE_SECRET_KEY')) {
      const key = env.SUPABASE_SECRET_KEY.trim()
      const res = await timedFetch(fetchImpl, `${base}/rest/v1/schema_migration?select=version&order=version.desc&limit=1`, {
        headers: { apikey: key, authorization: `Bearer ${key}` },
      })
      if (res.status === 401 || res.status === 403) {
        out.push(error('Supabase DB', `HTTP ${res.status} — servisní klíč neplatí`))
      } else if (res.status === 404 || res.status === 400) {
        out.push(error('Supabase DB', 'tabulka schema_migration chybí — databáze ještě není založená (docs/NASAZENI.md, krok 3)'))
      } else if (!res.ok) {
        out.push(error('Supabase DB', `HTTP ${res.status}`))
      } else {
        const rows = await readJson(res)
        const v = Array.isArray(rows) ? rows[0]?.version : null
        if (!v) out.push(error('Supabase DB', 'ledger migrací je prázdný'))
        else if (latestVersion && v !== latestVersion) out.push(warn('Supabase DB', `poslední migrace ${v}, v repu ${latestVersion} — spustit scripts/migrate.mjs`))
        else out.push(ok('Supabase DB', `dotaz prošel, poslední migrace ${v}`))
      }
    }
  } catch (e) {
    out.push(error('Supabase', `nedostupné (${e?.name === 'TimeoutError' ? 'časový limit' : 'síťová chyba'})`))
  }
  return out
}

/** 2b) Turnstile: tajemství ověří siteverify s prázdnou odpovědí. */
export async function checkTurnstile(env, fetchImpl) {
  if (!has(env, 'TURNSTILE_SECRET_KEY')) return [skip('Turnstile', 'TURNSTILE_SECRET_KEY chybí')]
  try {
    const res = await timedFetch(fetchImpl, 'https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY.trim(), response: 'setup-check' }).toString(),
    })
    const body = await readJson(res)
    const codes = Array.isArray(body?.['error-codes']) ? body['error-codes'] : []
    if (codes.includes('invalid-input-secret') || codes.includes('missing-input-secret')) {
      return [error('Turnstile', 'tajný klíč Cloudflare neplatí')]
    }
    return [ok('Turnstile', 'tajný klíč přijat')]
  } catch {
    return [error('Turnstile', 'Cloudflare neodpovídá')]
  }
}

const GMAIL_SCOPES = ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send']

/**
 * 2c) Gmail OAuth: klient se ověří výměnou neplatného refresh tokenu
 * (invalid_grant = klient v pořádku, invalid_client = špatné ID/tajemství).
 * S GMAIL_CHECK_REFRESH_TOKEN se token schránky opravdu obnoví a zkontrolují
 * rozsahy gmail.readonly + gmail.send. Přístupový token se nikam neukládá.
 */
export async function checkGmail(env, fetchImpl) {
  if (!has(env, 'GMAIL_CLIENT_ID') || !has(env, 'GMAIL_CLIENT_SECRET')) {
    return [env.INQUIRY_AGENT_ENABLED === 'true' ? error('Gmail OAuth', 'chybí GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET') : skip('Gmail OAuth', 'klient není nastavený (agent vypnutý)')]
  }
  const real = has(env, 'GMAIL_CHECK_REFRESH_TOKEN')
  try {
    const res = await timedFetch(fetchImpl, 'https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: env.GMAIL_CLIENT_ID.trim(),
        client_secret: env.GMAIL_CLIENT_SECRET.trim(),
        refresh_token: real ? env.GMAIL_CHECK_REFRESH_TOKEN.trim() : 'setup-check-invalid',
      }).toString(),
    })
    const body = await readJson(res)
    const err = typeof body?.error === 'string' ? body.error : null
    if (err === 'invalid_client' || err === 'unauthorized_client') return [error('Gmail OAuth', 'Google odmítl klienta (špatné ID / tajemství nebo smazaný klient)')]
    if (!real) {
      return [err === 'invalid_grant' ? ok('Gmail OAuth', 'klient platí (token schránky neověřen — GMAIL_CHECK_REFRESH_TOKEN)') : warn('Gmail OAuth', `nečekaná odpověď Google (HTTP ${res.status})`)]
    }
    if (err === 'invalid_grant') return [error('Gmail OAuth', 'token schránky je neplatný nebo odvolaný — schránku znovu autorizovat')]
    if (!res.ok || typeof body?.access_token !== 'string') return [error('Gmail OAuth', `obnova tokenu selhala (HTTP ${res.status})`)]
    const scopes = String(body.scope ?? '').split(/\s+/)
    const missing = GMAIL_SCOPES.filter((s) => !scopes.includes(s))
    return [missing.length ? error('Gmail OAuth', `token nemá rozsahy: ${missing.map((s) => s.split('/').pop()).join(', ')}`) : ok('Gmail OAuth', 'token schránky platí, rozsahy gmail.readonly + gmail.send')]
  } catch {
    return [error('Gmail OAuth', 'Google neodpovídá')]
  }
}

/** 3a) Anthropic (jen --live): minimální dotaz, max_tokens 1 (zlomek haléře). */
export async function checkAnthropic(env, fetchImpl) {
  if (!has(env, 'ANTHROPIC_API_KEY')) return [skip('Anthropic', 'ANTHROPIC_API_KEY chybí')]
  try {
    const res = await timedFetch(fetchImpl, 'https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_API_KEY.trim(), 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: ANTHROPIC_PING_MODEL, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }),
    })
    if (res.ok) return [ok('Anthropic', `klíč platí, model ${ANTHROPIC_PING_MODEL} odpovídá`)]
    const body = await readJson(res)
    const msg = String(body?.error?.message ?? '')
    if (res.status === 401) return [error('Anthropic', 'klíč neplatí')]
    if (/credit balance|billing/i.test(msg)) return [error('Anthropic', 'vyčerpaný kredit — dobít v console.anthropic.com → Billing')]
    if (res.status === 429) return [warn('Anthropic', 'limit požadavků / útraty dosažen')]
    if (res.status === 404) return [error('Anthropic', `model ${ANTHROPIC_PING_MODEL} není pro účet dostupný`)]
    return [error('Anthropic', `HTTP ${res.status}`)]
  } catch {
    return [error('Anthropic', 'API neodpovídá')]
  }
}

/** 3b) Mapy.com (jen --live): jedno geokódování (spotřebuje 1 kredit). */
export async function checkMapy(env, fetchImpl) {
  if (!has(env, 'MAPY_API_KEY')) return [skip('Mapy.com', 'MAPY_API_KEY chybí')]
  try {
    const url = new URL('https://api.mapy.com/v1/geocode')
    url.searchParams.set('query', 'Praha')
    url.searchParams.set('lang', 'cs')
    url.searchParams.set('limit', '1')
    // Klíč jde parametrem apikey (adresa se nikam nevypisuje).
    url.searchParams.set('apikey', env.MAPY_API_KEY.trim())
    const res = await timedFetch(fetchImpl, url.toString())
    if (res.ok) return [ok('Mapy.com', 'klíč platí, geokódování odpovídá')]
    if (res.status === 401 || res.status === 403) return [error('Mapy.com', 'klíč neplatí nebo nemá povolené API')]
    return [error('Mapy.com', `HTTP ${res.status}`)]
  } catch {
    return [error('Mapy.com', 'API neodpovídá')]
  }
}

/** Všechny kontroly. offline = jen proměnné; live = navíc placené pingy. */
export async function runChecks(env, { fetchImpl = fetch, offline = false, live = false, latestVersion = null } = {}) {
  const results = checkEnv(env)
  if (offline) return results
  results.push(...(await checkSupabase(env, fetchImpl, latestVersion)))
  results.push(...(await checkTurnstile(env, fetchImpl)))
  results.push(...(await checkGmail(env, fetchImpl)))
  if (live) {
    results.push(...(await checkAnthropic(env, fetchImpl)))
    results.push(...(await checkMapy(env, fetchImpl)))
  } else {
    results.push(skip('Anthropic, Mapy.com', 'placené pingy jen s --live'))
  }
  return results
}
