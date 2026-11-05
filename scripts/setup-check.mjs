#!/usr/bin/env node
// Kontrola nasazení na účtech klienta (docs/NASAZENI.md, krok 9).
//
// POUŽITÍ
//   node scripts/setup-check.mjs              proměnné + Supabase, Turnstile, Gmail OAuth (bez placených volání)
//   node scripts/setup-check.mjs --live       navíc Anthropic (mini dotaz, max_tokens 1) a Mapy.com (1 geokódování)
//   node scripts/setup-check.mjs --offline    jen proměnné, žádná síť
//   node scripts/setup-check.mjs --env-file=.env.production.local
//   node scripts/setup-check.mjs --write-env-example   přegeneruje .env.example z katalogu
//
// Hodnoty se čtou z .env.local (nebo --env-file) a z prostředí (prostředí má
// přednost). Produkční hodnoty z Vercelu: `vercel env pull .env.production.local
// --environment=production`, pak --env-file=.env.production.local a soubor
// po kontrole smazat.
//
// Výstup NIKDY neobsahuje hodnotu tajemství: zprávy jsou pevné texty a celý
// výstup navíc prochází redakcí všech tajných hodnot z katalogu.
// Návratový kód: 0 = bez chyb (varování nevadí), 1 = chyba, 2 = chybné použití.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { makeRedactor } from './migrate-lib.mjs'
import { renderEnvExample } from './env-catalog.mjs'
import { runChecks, secretValues } from './setup-check-lib.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function parseEnvFile(file) {
  const out = {}
  let raw
  try {
    raw = fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#') || !t.includes('=')) continue
    const i = t.indexOf('=')
    let v = t.slice(i + 1).trim()
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1)
    out[t.slice(0, i).trim()] = v
  }
  return out
}

function latestMigration() {
  const files = fs.readdirSync(path.join(ROOT, 'supabase', 'migrations')).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort()
  return files.at(-1)?.slice(0, 4) ?? null
}

const ICON = { ok: 'OK      ', warn: 'POZOR   ', error: 'CHYBA   ', skip: 'vynech. ' }

async function main(argv) {
  const opts = { live: false, offline: false, envFile: null, writeExample: false }
  for (const a of argv) {
    if (a === '--live') opts.live = true
    else if (a === '--offline') opts.offline = true
    else if (a === '--write-env-example') opts.writeExample = true
    else if (a.startsWith('--env-file=')) opts.envFile = a.slice('--env-file='.length)
    else {
      console.error(`Neznámý argument: ${a.slice(0, 40)}\nPoužití: node scripts/setup-check.mjs [--live | --offline] [--env-file=soubor] [--write-env-example]`)
      return 2
    }
  }
  if (opts.live && opts.offline) {
    console.error('--live a --offline nejdou spolu.')
    return 2
  }
  if (opts.writeExample) {
    fs.writeFileSync(path.join(ROOT, '.env.example'), renderEnvExample())
    console.log('.env.example přegenerován ze scripts/env-catalog.mjs.')
    return 0
  }

  const file = opts.envFile ? path.resolve(opts.envFile) : path.join(ROOT, '.env.local')
  const fileEnv = parseEnvFile(file)
  if (opts.envFile && !fileEnv) {
    console.error(`Soubor ${opts.envFile} nejde přečíst.`)
    return 2
  }
  const env = { ...(fileEnv ?? {}), ...process.env }
  const redact = makeRedactor(secretValues(env))
  const say = (s) => console.log(redact(s))

  say(`Kontrola nasazení — ${opts.offline ? 'jen proměnné' : opts.live ? 'proměnné, služby a placené pingy' : 'proměnné a služby'}`)
  say(`Zdroj: ${fileEnv ? path.relative(ROOT, file) || file : 'jen proměnné prostředí'} + prostředí\n`)

  const results = await runChecks(env, { offline: opts.offline, live: opts.live, latestVersion: latestMigration() })
  for (const r of results) say(`${ICON[r.level]}${r.name}: ${r.message}`)

  const errors = results.filter((r) => r.level === 'error').length
  const warns = results.filter((r) => r.level === 'warn').length
  say(`\nVýsledek: ${errors} chyb, ${warns} varování.${errors ? ' Opravit podle docs/NASAZENI.md.' : ''}`)
  return errors ? 1 : 0
}

process.exitCode = await main(process.argv.slice(2))
