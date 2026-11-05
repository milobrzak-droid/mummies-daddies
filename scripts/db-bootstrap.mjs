#!/usr/bin/env node
// Založení databáze od nuly (docs/NASAZENI.md, krok 3).
//
// POUŽITÍ
//   node scripts/db-bootstrap.mjs --pglite [--seed]
//       Ověření bez sítě: celý řetěz migrací 0001–posledních na čerstvém
//       PGlite (Postgres ve WASM) TÝMŽ běhačem jako produkce, volitelně
//       ukázková data a závěrečné kontroly. Nic mimo počítač se nemění.
//
//   node scripts/db-bootstrap.mjs --target=staging [--seed]
//   node scripts/db-bootstrap.mjs --target=production
//       Kontrola PO migraci nového projektu Supabase. Migrace samotné jde
//       VŽDY přes scripts/migrate.mjs (plán → --apply), nejdřív staging,
//       pak produkce — tenhle skript je jen doplňuje:
//         --seed  (jen staging) nahraje supabase/seed.sql, a to jen do
//                 databáze bez obchodů; na produkci se odmítne;
//         potom ověří ledger, RLS na všech tabulkách, uzly a enum linek
//         proti config/mummiesDaddies.ts a to, že nikdo není předem správce.
//       Připojení z STAGING_DB_URL / SUPABASE_DB_URL (proměnná prostředí nebo
//       .env.local), TLS verify-full s certifikáty supabase/certs/.
//
// Výstup obsahuje jen čísla verzí, počty a názvy tabulek — nikdy připojovací
// řetězec, hesla ani data. Návratový kód: 0 OK, 1 problém, 2 chybné použití.

import fs from 'node:fs'

import { MigrateError, TARGETS, makeRedactor, parseDbUrl, looksLikeProduction, parseProductionRefs } from './migrate-lib.mjs'
import {
  SUPABASE_STUB_SQL,
  applyAllMigrations,
  pgliteClient,
  readCompanyExpectations,
  readSeed,
  verifyBootstrap,
} from './db-bootstrap-lib.mjs'

const USAGE = `Použití:
  node scripts/db-bootstrap.mjs --pglite [--seed]
  node scripts/db-bootstrap.mjs --target=staging [--seed]
  node scripts/db-bootstrap.mjs --target=production`

let redact = makeRedactor([])
const out = (line = '') => console.log(redact(line))

function parse(argv) {
  const o = { pglite: false, target: null, seed: false }
  for (const a of argv) {
    if (a === '--pglite') o.pglite = true
    else if (a === '--seed') o.seed = true
    else if (a.startsWith('--target=')) o.target = a.slice('--target='.length)
    else if (a === '--help' || a === '-h') return { help: true }
    else return { error: `Neznámý argument: ${a}` }
  }
  if (o.pglite === Boolean(o.target)) return { error: 'Zadej právě jedno z --pglite nebo --target=…' }
  if (o.target && !Object.hasOwn(TARGETS, o.target)) return { error: `Neznámý cíl: ${o.target}` }
  if (o.target === 'production' && o.seed) return { error: 'Ukázková data (--seed) se na produkci nikdy nenahrávají.' }
  return { options: o }
}

function loadEnv() {
  const fileEnv = {}
  try {
    const raw = fs.readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    for (const line of raw.split('\n')) {
      if (!line.includes('=') || line.trim().startsWith('#')) continue
      const i = line.indexOf('=')
      fileEnv[line.slice(0, i).trim()] = line.slice(i + 1).trim()
    }
  } catch {
    // .env.local nemusí existovat.
  }
  return { ...fileEnv, ...process.env }
}

function loadCa() {
  const dir = new URL('../supabase/certs/', import.meta.url)
  try {
    const pem = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.crt'))
      .sort()
      .map((f) => fs.readFileSync(new URL(f, dir), 'utf8').trim())
      .join('\n')
    return pem.includes('BEGIN CERTIFICATE') ? pem + '\n' : null
  } catch {
    return null
  }
}

function expectations() {
  const src = fs.readFileSync(new URL('../config/mummiesDaddies.ts', import.meta.url), 'utf8')
  return readCompanyExpectations(src)
}

async function runPglite(seed) {
  let PGlite, pgcrypto
  try {
    ;({ PGlite } = await import('@electric-sql/pglite'))
    ;({ pgcrypto } = await import('@electric-sql/pglite/contrib/pgcrypto'))
  } catch {
    throw new MigrateError('Chybí @electric-sql/pglite — spusť nejdřív `npm ci` (je v devDependencies).')
  }
  const db = new PGlite({ extensions: { pgcrypto } })
  const client = pgliteClient(db)
  try {
    await db.exec(SUPABASE_STUB_SQL)
    out('PGlite: čistá databáze s náhradou prostředí Supabase (role, auth, storage, vault, pgcrypto).')
    const applied = await applyAllMigrations(client, { log: out })
    out(`Aplikováno ${applied.length} migrací (${applied[0]}–${applied.at(-1)}).`)
    if (seed) {
      await db.exec(readSeed())
      out('Ukázková data supabase/seed.sql nahrána.')
    }
    return await verifyBootstrap(client, expectations(), { seeded: seed, fresh: true })
  } finally {
    await client.end().catch(() => {})
  }
}

async function runTarget(target, seed) {
  const env = loadEnv()
  const raw = env[TARGETS[target].envVar]
  if (!raw) throw new MigrateError(`Chybí proměnná ${TARGETS[target].envVar} (připojovací řetězec pro ${target}).`)
  const cfg = parseDbUrl(raw, { ca: loadCa(), insecureTls: env.MIGRATE_DB_TLS_INSECURE === '1' })
  redact = makeRedactor([...cfg.secrets])
  if (target === 'staging' && looksLikeProduction(raw, parseProductionRefs(env.PRODUCTION_PROJECT_REFS))) {
    throw new MigrateError('STAGING_DB_URL ukazuje na PRODUKČNÍ projekt. Zastaveno.')
  }
  const { default: pg } = await import('pg')
  const client = new pg.Client({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    ssl: cfg.ssl,
    application_name: 'cockpit-db-bootstrap', connectionTimeoutMillis: 20000 })
  try {
    await client.connect()
  } catch (err) {
    throw new MigrateError(`Připojení k ${target} selhalo: ${err?.message ?? err}`)
  }
  try {
    const { rows } = await client.query("select to_regclass('public.schema_migration') is not null as ok")
    if (!rows[0]?.ok) {
      throw new MigrateError(`Na ${target} ještě neproběhly migrace. Nejdřív: node scripts/migrate.mjs --target=${target} --apply`)
    }
    if (seed) {
      const [{ n }] = (await client.query('select count(*)::int as n from public.deal')).rows
      if (n > 0) throw new MigrateError('Staging už obchody má — seed se pouští jen do prázdné databáze.')
      await client.query(readSeed())
      out('Ukázková data supabase/seed.sql nahrána na staging.')
    }
    return await verifyBootstrap(client, expectations(), { seeded: seed, production: target === 'production' })
  } finally {
    await client.end().catch(() => {})
  }
}

async function main() {
  const p = parse(process.argv.slice(2))
  if (p.help) {
    console.log(USAGE)
    return 0
  }
  if (p.error) {
    console.error(`${p.error}\n${USAGE}`)
    return 2
  }
  const { pglite, target, seed } = p.options
  const problems = pglite ? await runPglite(seed) : await runTarget(target, seed)
  if (problems.length) {
    out('\nKontrola po založení NEPROŠLA:')
    for (const pr of problems) out(`  - ${pr}`)
    return 1
  }
  out('\nKontrola po založení prošla: ledger úplný, RLS všude, uzly a obchodní linky sedí s konfigurací firmy.')
  if (!pglite) {
    out('Další krok: první uživatel a správce podle docs/NASAZENI.md (krok 3d).')
  }
  return 0
}

try {
  process.exitCode = await main()
} catch (err) {
  const msg = err instanceof MigrateError ? err.message : `Neočekávaná chyba: ${err?.message ?? err}`
  console.error(redact(`\n${msg}`))
  process.exitCode = 1
}
