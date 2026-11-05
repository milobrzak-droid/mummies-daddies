#!/usr/bin/env node
// Migrační běhač — konec ručního SQL (kapitola 1, docs/PROVOZ.md).
//
// Doteď vlastník vkládal každou migraci ručně do SQL editoru Supabase a
// předtím se pouštěly přes Management API. Nikde se nekontrolovalo, co už
// proběhlo — komit 474ab27 je záznam toho, jak to selhalo. Tenhle skript
// čte `schema_migration` na cíli, spočítá, co chybí, a aplikuje JEN to,
// v pořadí čísel, každou migraci ve vlastní transakci. Nejdřív staging,
// pak produkce. Běžně se nespouští z počítače, ale z GitHubu
// (.github/workflows/migrate.yml, postup v docs/PROVOZ.md).
//
// POUŽITÍ
//   node scripts/migrate.mjs --target=staging --dry-run       jen vypíše, co chybí (výchozí)
//   node scripts/migrate.mjs --target=staging --apply          aplikuje
//   node scripts/migrate.mjs --target=production --apply --yes-production
//   node scripts/migrate.mjs --target=production --baseline=0090,0092-0094 [--apply --yes-production]
//     BASELINE = zápis řádků do schema_migration BEZ spuštění souborů, pro
//     migrace, které už jsou na cíli aplikované ručně. Bez --apply jen
//     vypíše, co by zapsal. Zapíše jen tehdy, když soubory v repu sedí
//     s evidencí a tabulky, které soubory zakládají, na cíli existují.
//   volitelně: --expect=0060,0061   aplikuj, jen když chybí přesně tohle (jinak nic)
//              --github-output      zapiš plán do výstupu a souhrnu kroku v GitHub Actions
//
// PŘIPOJENÍ — připojovací řetězec Postgresu (Supabase → Connect → Session
// pooler), jen z proměnné prostředí, nikdy z argumentu:
//   staging:  STAGING_DB_URL
//   produkce: SUPABASE_DB_URL   (GitHub secret prostředí production)
// Lokálně se čte i .env.local; proměnné prostředí mají přednost.
//
// TLS — certifikát serveru se ověřuje včetně jména hostu (verify-full).
// Kořenový certifikát Supabase (veřejný, žádné tajemství) leží v repu
// v supabase/certs/*.crt; bez něj se použijí systémové autority a spojení
// se Supabase nejspíš neověří → běh skončí s návodem (docs/PROVOZ.md 1a).
// Jen pro lokální zkoušku proti jinému Postgresu: MIGRATE_DB_TLS_INSECURE=1
// (šifruje, ale neověřuje; vypíše varování).
//
// Proč přímé spojení a ne Management API (předchozí verze): DB URL už
// v GitHubu jako secret je, kdežto management token dosahuje na
// všechny projekty účtu a plán ho doporučuje revokovat (ROZHODNUTI.md 1.3).
// Přímé spojení navíc dává skutečnou transakci s kontrolou uvnitř.
//
// VÝSTUP obsahuje jen čísla verzí a názvy souborů. Připojovací řetězec ani
// jeho části (host, uživatel, heslo) se nevypisují — každá chyba prochází
// redakcí (makeRedactor).
//
// Pojistky:
// - staging nesmí ukazovat na produkční projekt ani na tutéž databázi;
// - produkce: když je nastavený i STAGING_DB_URL, musí staging už mít
//   všechno, co se chystá na produkci („nejdřív staging“); bez něj se to
//   jen ohlásí, protože staging zatím nemusí existovat;
// - díry, přeskočená čísla, neznámé verze v ledgeru → nic se nespustí
//   (výjimka: záměrné mezery 0076–0077, ALLOWED_VERSION_GAPS v migrate-lib.mjs);
// - plán se vždy nejdřív vypíše; jakákoli nesrovnalost mezi evidencí a soubory
//   (aplikovaná migrace chybí v repu, díra v evidenci…) zastaví běh dřív,
//   než se cokoliv změní;
// - první chyba vše zastaví, návratový kód 1 (chybné použití 2).

import fs from 'node:fs'

import {
  ALLOWED_VERSION_GAPS,
  MigrateError,
  TARGETS,
  USAGE,
  checkExpected,
  describeConnectError,
  looksLikeProduction,
  parseProductionRefs,
  makeRedactor,
  parseArgs,
  parseDbUrl,
  sameDatabase,
} from './migrate-lib.mjs'
import { applyBaseline, applyPending, inspect, readLedgerState } from './migrate-runner.mjs'

const MIGRATIONS_DIR = new URL('../supabase/migrations/', import.meta.url)
const CERTS_DIR = new URL('../supabase/certs/', import.meta.url)

let redact = makeRedactor([])

function out(line = '') {
  console.log(redact(line))
}

// .env.local se načítá ručně (v repu není
// dotenv); process.env má přednost, aby v CI platily GitHub secrets.
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
    // .env.local nemusí existovat — typicky v CI.
  }
  return { ...fileEnv, ...process.env }
}

// Kořenové certifikáty z supabase/certs/*.crt spojené do jednoho PEM, nebo null.
function loadCa() {
  let names
  try {
    names = fs.readdirSync(CERTS_DIR).filter((f) => f.endsWith('.crt')).sort()
  } catch {
    return null
  }
  const pem = names.map((f) => fs.readFileSync(new URL(f, CERTS_DIR), 'utf8').trim()).join('\n')
  return pem.includes('BEGIN CERTIFICATE') ? pem + '\n' : null
}

async function loadPg() {
  try {
    const mod = await import('pg')
    return mod.default ?? mod
  } catch {
    throw new MigrateError('Chybí balíček `pg` — spusť nejdřív `npm ci` (je v devDependencies).')
  }
}

async function connect(pg, cfg, label, caLoaded) {
  const client = new pg.Client({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    ssl: cfg.ssl,
    application_name: 'enter-cockpit-migrate',
    connectionTimeoutMillis: 20000,
  })
  // Spadlé spojení mimo běžící dotaz by jinak shodilo proces bez redakce.
  client.on('error', (err) => {
    console.error(redact(`Spojení s ${label} spadlo: ${err?.message ?? err}`))
    process.exit(1)
  })
  client.on('notice', (n) => {
    if (n?.severity === 'WARNING' || n?.severity === 'NOTICE') out(`  (${label}: ${n.message})`)
  })
  try {
    await client.connect()
  } catch (err) {
    throw new MigrateError(`Připojení k ${label} selhalo: ${describeConnectError(err, { caLoaded })}`)
  }
  return client
}

function appendFile(path, text) {
  if (path) fs.appendFileSync(path, text)
}

const describeStep = (f, backfill) =>
  backfill.has(f.version) ? `${f.filename} — jen doplnit řádek do ledgeru (spuštěno dřív ručně, objekt na cíli ověřen)` : f.filename

function writeGithubOutputs(env, target, pending, backfill, mode, baseline = false) {
  const list = pending.map((f) => f.version).join(',')
  appendFile(env.GITHUB_OUTPUT, `pending=${list}\n`)
  const lines = [
    `### ${baseline ? 'Baseline evidence' : 'Migrace'} — ${target} (${mode === 'apply' ? 'zápis' : 'nanečisto'})`,
    '',
    baseline
      ? `Do schema_migration se zapíše ${pending.length} řádků (soubory se nespouštějí):`
      : pending.length
        ? `Chybí ${pending.length}:`
        : 'Nic k aplikování — cíl odpovídá repu.',
    ...pending.map((f) => `- \`${f.version}\` ${baseline ? f.filename : describeStep(f, backfill)}`),
    '',
    `Záměrné mezery v číslování (přeskočeno): ${ALLOWED_VERSION_GAPS.map((n) => String(n).padStart(4, '0')).join(', ')}.`,
    '',
  ]
  appendFile(env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n')
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2))
  if (parsed.error) {
    console.error(`${parsed.error}\n${USAGE}`)
    process.exit(2)
  }
  const opts = parsed.options
  const env = loadEnv()

  const envVar = TARGETS[opts.target].envVar
  const rawUrl = env[envVar]
  if (!rawUrl) {
    throw new MigrateError(
      `Chybí proměnná ${envVar} (připojovací řetězec pro ${opts.target}). ` +
        'V GitHubu: Settings → Secrets and variables → Actions (nebo secret prostředí ' +
        `${opts.target}); lokálně .env.local. Postup v docs/PROVOZ.md, bod 1a.`,
    )
  }
  const ca = loadCa()
  const tlsOpts = { ca, insecureTls: env.MIGRATE_DB_TLS_INSECURE === '1' }
  const cfg = parseDbUrl(rawUrl, tlsOpts)
  const secrets = [...cfg.secrets]

  const stagingRaw = opts.target === 'production' ? env.STAGING_DB_URL : null
  const stagingCfg = stagingRaw ? parseDbUrl(stagingRaw, tlsOpts) : null
  if (stagingCfg) secrets.push(...stagingCfg.secrets)
  redact = makeRedactor(secrets)

  const prodRefs = parseProductionRefs(env.PRODUCTION_PROJECT_REFS)
  if (opts.target === 'staging') {
    if (looksLikeProduction(rawUrl, prodRefs)) {
      throw new MigrateError('STAGING_DB_URL ukazuje na PRODUKČNÍ projekt. Zastaveno.')
    }
    let prodCfg = null
    try {
      prodCfg = env.SUPABASE_DB_URL ? parseDbUrl(env.SUPABASE_DB_URL) : null
    } catch {
      // Nečitelný produkční řetězec tady nevadí — staging se jím neřídí.
    }
    if (prodCfg && sameDatabase(cfg, prodCfg)) {
      throw new MigrateError('STAGING_DB_URL a SUPABASE_DB_URL jsou tatáž databáze. Zastaveno.')
    }
  }
  if (stagingCfg && (looksLikeProduction(stagingRaw, prodRefs) || sameDatabase(cfg, stagingCfg))) {
    throw new MigrateError('STAGING_DB_URL ukazuje na produkci — kontrola „nejdřív staging“ by neměla smysl. Zastaveno.')
  }

  const filenames = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql'))
  const readSql = (filename) => fs.readFileSync(new URL(filename, MIGRATIONS_DIR), 'utf8')

  const pg = await loadPg()
  out(`Cíl: ${opts.target}${opts.mode === 'apply' ? '' : ' — nanečisto, nic se nemění'}`)
  if (tlsOpts.insecureTls) {
    out('POZOR: MIGRATE_DB_TLS_INSECURE=1 — certifikát serveru se NEOVĚŘUJE. Jen pro lokální zkoušku, ne pro Supabase.')
  }
  const client = await connect(pg, cfg, opts.target, Boolean(ca))
  try {
    const plan = await inspect({ client, filenames, readSql, baseline: opts.baseline })
    const { files, state, pending, backfill, sources } = plan
    const last = state.versions.at(-1)
    out(`Na disku: ${files.length} migrací (${files[0]?.version ?? '-'}–${files.at(-1)?.version ?? '-'})`)
    out(`Záměrné mezery v číslování (přeskočeno): ${ALLOWED_VERSION_GAPS.map((n) => String(n).padStart(4, '0')).join(', ')}`)
    out(
      state.hasLedger
        ? `V schema_migration cíle: ${state.versions.length} verzí${last ? ` (poslední ${last})` : ''}`
        : 'Cíl je prázdný projekt (schema_migration ještě neexistuje).',
    )

    if (opts.githubOutput) writeGithubOutputs(env, opts.target, pending, backfill, opts.mode, plan.baseline === true)

    if (plan.baseline) {
      out(`Baseline — do evidence se zapíše ${pending.length} verzí, soubory se NESPOUŠTĚJÍ:`)
      for (const f of pending) {
        const t = plan.tables.get(f.version) ?? []
        out(`  ${f.version}  ${f.filename} — ${t.length ? `tabulky na cíli ověřeny (${t.join(', ')})` : 'na cíli se nedalo nic ověřit (soubor tabulku nezakládá), platí tvrzení vlastníka'}`)
      }
      if (plan.remaining.length) {
        out(`Po baseline pořád chybí (spustí se normální aplikací, ne teď): ${plan.remaining.map((f) => f.version).join(', ')}`)
      }
      const mismatch = checkExpected(pending, opts.expect)
      if (mismatch) throw new MigrateError(mismatch)
      if (opts.mode !== 'apply') {
        out('\nNanečisto — nic se nezměnilo. Pro zápis přidej --apply.')
        return
      }
      out(`\nZapisuji ${pending.length} řádků do schema_migration na ${opts.target}:`)
      const written = await applyBaseline({ client, files, pending, tables: plan.tables, log: out })
      out(`\nHotovo. Do evidence zapsáno ${written.length}: ${written.join(', ')}.`)
      return
    }

    if (!pending.length) {
      out('Nic k aplikování — cíl odpovídá souborům v repu.')
      return
    }
    out(`Chybí (${pending.length}), v tomhle pořadí:`)
    for (const f of pending) out(`  ${f.version}  ${describeStep(f, backfill)}`)

    const mismatch = checkExpected(pending, opts.expect)
    if (mismatch) throw new MigrateError(mismatch)

    // Nejdřív staging, pak produkce.
    if (opts.target === 'production') {
      if (!stagingCfg) {
        out('POZOR: STAGING_DB_URL není nastavený — pořadí „nejdřív staging“ se neověřilo.')
      } else {
        const staging = await connect(pg, stagingCfg, 'staging', Boolean(ca))
        let stagingState
        try {
          await staging.query('BEGIN TRANSACTION READ ONLY')
          stagingState = await readLedgerState(staging)
          await staging.query('ROLLBACK')
        } catch (err) {
          throw new MigrateError(`Čtení ledgeru na stagingu selhalo: ${err?.message ?? err}`)
        } finally {
          await staging.end().catch(() => {})
        }
        const have = new Set(stagingState.versions)
        const notOnStaging = pending.filter((f) => !have.has(f.version)).map((f) => f.version)
        if (notOnStaging.length) {
          throw new MigrateError(
            `Staging ještě nemá ${notOnStaging.join(', ')}. Nejdřív migruj staging, ověř ho, pak produkci.`,
          )
        }
        out('Staging už všechny chybějící verze má — v pořádku.')
      }
    }

    if (opts.mode !== 'apply') {
      out(
        opts.implicitDryRun
          ? '\nNanečisto (výchozí) — nic se nezměnilo. Pro provedení přidej --apply.'
          : '\nNanečisto — nic se nezměnilo.',
      )
      return
    }

    out(`\nAplikuji ${pending.length} na ${opts.target}:`)
    const applied = await applyPending({ client, files, pending, sources, backfill, log: out })
    out(`\nHotovo. Aplikováno ${applied.length}: ${applied.join(', ')}.`)
  } finally {
    await client.end().catch(() => {})
  }
}

try {
  await main()
} catch (err) {
  const msg = err instanceof MigrateError ? err.message : `Neočekávaná chyba: ${err?.message ?? err}`
  console.error(redact(`\n${msg}`))
  process.exit(1)
}
