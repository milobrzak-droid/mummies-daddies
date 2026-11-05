// Databázová část migračního běhače nad podstrčeným klientem
// (`{ query(text, params?) → { rows } }` — tvar `pg.Client`). Nečte proměnné
// prostředí ani soubory a nic nevypisuje sám — výstup jde přes `log`, obsah
// souborů přes `readSql`. Díky tomu ji test/migrate-runner.test.ts prověří
// s falešným klientem, bez databáze.
//
// Pravidla, která tu platí:
// - Každá migrace běží ve vlastní transakci. Uvnitř se nejdřív vezme
//   transakční advisory zámek a znovu přečte ledger — souběžný běh nebo
//   ruční zásah mezi plánem a aplikací transakci vrátí, ne zdvojí migraci.
//   Transakční (ne session) zámek schválně: funguje i přes transaction pooler.
// - Po souboru se ještě UVNITŘ transakce ověří řádek v schema_migration;
//   chybí-li, transakce se vrátí. Po COMMIT se ověří znovu.
// - První chyba vše zastaví; další migrace se nezkouší.
// - Jediná výjimka ze „soubor spustit“: chybějící řádek historické 0029/0030
//   pod nejvyšší aplikovanou verzí (LEGACY_BACKFILL_PROBES). Soubor se
//   nespouští; řádek se doplní, jen když objekt na cíli existuje — ověřeno
//   nanečisto i znovu uvnitř transakce se zámkem.
// - Baseline (--baseline): zápis řádku do schema_migration BEZ spuštění
//   souboru, pro migrace, které vlastník už pustil ručně. Jen do existujícího
//   ledgeru, jen pro verzi, kterou repo zná a ledger ne; tabulky, které soubor
//   zakládá, musí na cíli existovat (nanečisto i znovu v transakci se zámkem);
//   po zápisu musí být plán sloučený s evidencí bez problémů.

import {
  ALLOWED_VERSION_GAPS,
  LEDGER_BOOTSTRAP_VERSION,
  LEGACY_BACKFILL_PROBES,
  MigrateError,
  backfillCandidates,
  checkMigrationSource,
  createdTables,
  describeProblem,
  findInvalidFilenames,
  formatDbError,
  ledgerMode,
  parseMigrationFiles,
  planMigrations,
} from './migrate-lib.mjs'

// Libovolné, ale pevné číslo zámku migrací Cockpitu.
export const MIGRATION_LOCK_SQL = 'select pg_try_advisory_xact_lock(726011001) as ok'

const RUNNER_LEDGER_NOTE = 'zapsal scripts/migrate.mjs (historický soubor bez vlastního zápisu)'
const BASELINE_LEDGER_NOTE =
  'baseline: zapsal scripts/migrate.mjs --baseline — migrace spuštěna dřív ručně, soubor se znovu nespouštěl'
const BACKFILL_LEDGER_NOTE = 'doplnil scripts/migrate.mjs — spuštěno dřív ručně, objekt na cíli ověřen, řádek chyběl'

// Stav ledgeru na cíli. `otherTables` = počet tabulek v public mimo ledger —
// pro pojistku proti migraci „od nuly“ do cizí neprázdné databáze.
export async function readLedgerState(client) {
  const {
    rows: [r],
  } = await client.query(
    "select to_regclass('public.schema_migration') is not null as has_ledger, " +
      "(select count(*)::int from pg_catalog.pg_tables where schemaname = 'public' and tablename <> 'schema_migration') as other_tables",
  )
  if (!r?.has_ledger) return { hasLedger: false, otherTables: Number(r?.other_tables ?? 0), versions: [] }
  const { rows } = await client.query('select version from public.schema_migration order by version')
  return { hasLedger: true, otherTables: Number(r.other_tables), versions: rows.map((x) => String(x.version)) }
}

// Z kandidátů na doplnění vrátí ty, jejichž objekt na cíli existuje.
async function verifyBackfill(client, versions) {
  const ok = []
  for (const v of versions) {
    const {
      rows: [r],
    } = await client.query(LEGACY_BACKFILL_PROBES[v])
    if (r?.ok === true) ok.push(v)
  }
  return ok
}

function asMigrateError(err, prefix) {
  if (err instanceof MigrateError) return err
  return new MigrateError(`${prefix}${formatDbError(err)}`)
}

// Nanečisto část: přečte ledger (v read-only transakci), spočítá plán
// a staticky zkontroluje čekající soubory. Při jakémkoliv problému hodí
// MigrateError se všemi důvody najednou.
//
// `pending` = kroky v pořadí (doplnění řádků 0029/0030 jsou nižší verze,
// takže jdou první); `backfill` = verze z nich, u kterých se jen doplní řádek.
/**
 * @param {{ client: any, filenames: string[], readSql: (filename: string) => Promise<string> | string,
 *   allowedGaps?: readonly (string | number)[], baseline?: string[] | null }} args
 * @returns {Promise<any>}
 */
export async function inspect({ client, filenames, readSql, allowedGaps = ALLOWED_VERSION_GAPS, baseline = null }) {
  if (baseline) return inspectBaseline({ client, filenames, readSql, allowedGaps, baseline })
  const problems = []
  const invalid = findInvalidFilenames(filenames)
  if (invalid.length) problems.push({ code: 'invalid_filename', versions: [], filenames: invalid })
  const files = parseMigrationFiles(filenames)

  let state
  let verified = []
  try {
    await client.query('BEGIN TRANSACTION READ ONLY')
    try {
      state = await readLedgerState(client)
      const candidates = backfillCandidates(planMigrations(files, state.versions, { allowedGaps }).problems)
      if (candidates.length) verified = await verifyBackfill(client, candidates)
    } finally {
      await client.query('ROLLBACK')
    }
  } catch (err) {
    throw asMigrateError(err, 'Čtení schema_migration na cíli selhalo: ')
  }

  if (state.versions.length === 0 && state.otherTables > 0) {
    throw new MigrateError(
      'Cíl nemá záznam o migracích (schema_migration chybí nebo je prázdná), ale schéma public už tabulky má — ' +
        'tohle není databáze Cockpitu ani prázdný projekt. Zastaveno, nic se nespustilo.',
    )
  }

  const plan = planMigrations(files, state.versions, { allowedGaps, backfillable: verified })
  problems.push(...plan.problems)

  const sources = new Map()
  for (const f of plan.pending) {
    const sql = await readSql(f.filename)
    sources.set(f.version, sql)
    problems.push(...checkMigrationSource(f, sql))
  }

  if (problems.length) {
    throw new MigrateError(
      'Nic se nespustí — plán neprošel kontrolou:\n' + problems.map((p) => `  - ${describeProblem(p)}`).join('\n'),
    )
  }
  return {
    files,
    state,
    pending: [...plan.backfill, ...plan.pending],
    backfill: new Set(plan.backfill.map((f) => f.version)),
    sources,
    allowedGaps,
  }
}

// Kolik z tabulek `tables` v public na cíli existuje → seznam chybějících.
async function missingTables(client, tables) {
  if (!tables.length) return []
  const { rows } = await client.query(
    "select tablename from pg_catalog.pg_tables where schemaname = 'public' and tablename = any($1::text[])",
    [tables],
  )
  const have = new Set(rows.map((r) => String(r.tablename)))
  return tables.filter((t) => !have.has(t))
}

// Nanečisto pro baseline. Nic nespouští; jen ověří, že zapsat řádky do
// evidence je bezpečné. Výsledek má stejný tvar jako inspect (`pending` =
// kroky tohoto běhu), navíc `remaining` = co po baseline pořád chybí a bude
// chtít normální aplikaci, a `unverified` = verze, u kterých se nedalo ověřit
// nic na cíli (soubor nezakládá tabulku).
async function inspectBaseline({ client, filenames, readSql, allowedGaps, baseline }) {
  const problems = []
  const invalid = findInvalidFilenames(filenames)
  if (invalid.length) problems.push({ code: 'invalid_filename', versions: [], filenames: invalid })
  const files = parseMigrationFiles(filenames)
  const byVersion = new Map(files.map((f) => [f.version, f]))

  let state
  const tables = new Map()
  try {
    await client.query('BEGIN TRANSACTION READ ONLY')
    try {
      state = await readLedgerState(client)
      if (state.hasLedger) {
        for (const v of baseline) {
          const f = byVersion.get(v)
          if (!f || state.versions.includes(v)) continue
          const t = createdTables(await readSql(f.filename))
          tables.set(v, t)
          const missing = await missingTables(client, t)
          if (missing.length) problems.push({ code: 'baseline_object_missing', versions: [v], filenames: missing })
        }
      }
    } finally {
      await client.query('ROLLBACK')
    }
  } catch (err) {
    throw asMigrateError(err, 'Čtení schema_migration na cíli selhalo: ')
  }

  if (!state.hasLedger) problems.push({ code: 'baseline_no_ledger', versions: [] })
  const unknown = baseline.filter((v) => !byVersion.has(v))
  if (unknown.length) problems.push({ code: 'baseline_unknown', versions: unknown })
  const already = baseline.filter((v) => state.versions.includes(v))
  if (already.length) problems.push({ code: 'baseline_already', versions: already })

  // Evidence po zápisu: musí sedět se soubory (žádná díra, žádná neznámá verze).
  const after = [...new Set([...state.versions, ...baseline])].sort()
  const plan = planMigrations(files, after, { allowedGaps })
  problems.push(...plan.problems)

  if (problems.length) {
    throw new MigrateError(
      'Nic se nezapíše — baseline neprošel kontrolou:\n' + problems.map((p) => `  - ${describeProblem(p)}`).join('\n'),
    )
  }
  return {
    files,
    state,
    pending: baseline.map((v) => byVersion.get(v)),
    backfill: new Set(),
    sources: new Map(),
    allowedGaps,
    baseline: true,
    remaining: plan.pending,
    unverified: baseline.filter((v) => (tables.get(v) ?? []).length === 0),
    tables,
  }
}

// Verze, které po aplikaci `file` musí být v ledgeru (null = nejde ověřit,
// ledger ještě neexistuje a soubor je starší než 0026).
function requiredVersions(files, file, hasLedger) {
  if (file.version === LEDGER_BOOTSTRAP_VERSION) {
    // 0026 zakládá ledger a zpětně zapisuje 0001–0026.
    return files.filter((f) => Number(f.version) <= Number(file.version)).map((f) => f.version)
  }
  if (ledgerMode(file.version) === 'pre-ledger' && !hasLedger) return null
  return [file.version]
}

async function missingInLedger(client, files, file) {
  const state = await readLedgerState(client)
  const required = requiredVersions(files, file, state.hasLedger)
  if (!required) return []
  const have = new Set(state.versions)
  return required.filter((v) => !have.has(v))
}

// Aplikuje jednu migraci ve vlastní transakci. Viz pravidla v hlavičce.
// `backfill` = verze, u kterých se soubor nespouští a jen doplní řádek.
export async function applyOne({ client, files, file, sql, backfill = new Set(), allowedGaps = ALLOWED_VERSION_GAPS }) {
  const isBackfill = backfill.has(file.version)
  try {
    await client.query('BEGIN')
  } catch (err) {
    throw asMigrateError(err, `${file.version}: nepodařilo se zahájit transakci: `)
  }
  try {
    const {
      rows: [lock],
    } = await client.query(MIGRATION_LOCK_SQL)
    if (!lock?.ok) {
      throw new MigrateError('Jiný běh právě migruje tuhle databázi (zámek je obsazený). Zkus to za chvíli znovu.')
    }

    const state = await readLedgerState(client)
    if (state.hasLedger) {
      const now = planMigrations(files, state.versions, { allowedGaps, backfillable: [...backfill] })
      const next = [...now.backfill, ...now.pending][0]
      if (now.problems.length || next?.version !== file.version) {
        throw new MigrateError(
          `Stav cíle se od plánu změnil (souběžný běh nebo ruční zásah) — ${file.version} už není další na řadě.`,
        )
      }
    } else if (ledgerMode(file.version) !== 'pre-ledger' && file.version !== LEDGER_BOOTSTRAP_VERSION) {
      throw new MigrateError(`Na cíli chybí tabulka schema_migration, ale na řadě je ${file.version}.`)
    }

    if (isBackfill) {
      // Znovu, uvnitř transakce se zámkem: objekt pořád existuje?
      const [ok] = await verifyBackfill(client, [file.version])
      if (ok !== file.version) {
        throw new MigrateError(
          `${file.version}: na cíli není to, co ${file.filename} zakládá — řádek do ledgeru se nedoplní.`,
        )
      }
      await client.query(
        'INSERT INTO public.schema_migration (version, note) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING',
        [file.version, BACKFILL_LEDGER_NOTE],
      )
    } else {
      // Migrace nesmí donekonečna čekat na zámek tabulky (a blokovat za sebou
      // provoz aplikace) ani běžet bez konce.
      await client.query("SET LOCAL lock_timeout = '15s'")
      await client.query("SET LOCAL statement_timeout = '10min'")

      try {
        // Celý soubor jedním dotazem (simple query protokol) — dělení na
        // příkazy řeší server, včetně $$ těl funkcí.
        await client.query(sql)
      } catch (err) {
        throw new MigrateError(`${file.filename}: ${formatDbError(err, sql)}`)
      }
    }

    if (!isBackfill && ledgerMode(file.version) === 'runner') {
      await client.query(
        'INSERT INTO public.schema_migration (version, note) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING',
        [file.version, RUNNER_LEDGER_NOTE],
      )
    }

    const missing = await missingInLedger(client, files, file)
    if (missing.length) {
      throw new MigrateError(
        `${file.filename} proběhl, ale v schema_migration chybí ${missing.join(', ')} — soubor má svůj řádek ` +
          "zapsat sám (INSERT INTO schema_migration … ON CONFLICT (version) DO NOTHING).",
      )
    }

    await client.query('COMMIT')
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch {
      // Spojení mohlo spadnout — server transakci vrátí sám.
    }
    throw asMigrateError(err, `${file.version}: `)
  }

  // Po COMMIT ještě jednou, mimo transakci: opravdu to zůstalo zapsané?
  let missingAfter
  try {
    missingAfter = await missingInLedger(client, files, file)
  } catch (err) {
    throw asMigrateError(err, `${file.version} je zapsaná, ale kontrola po COMMIT selhala: `)
  }
  if (missingAfter.length) {
    throw Object.assign(
      new MigrateError(`${file.version}: COMMIT proběhl, ale v schema_migration chybí ${missingAfter.join(', ')}. Zkontroluj ručně.`),
      { committed: true },
    )
  }
}

// Aplikuje čekající migrace po jedné, v pořadí. První chyba vše zastaví.
// Vrací seznam aplikovaných verzí.
export async function applyPending({ client, files, pending, sources, backfill = new Set(), allowedGaps = ALLOWED_VERSION_GAPS, log }) {
  const done = []
  for (const file of pending) {
    log(`→ ${file.version}  ${file.filename}${backfill.has(file.version) ? '  (jen doplnění řádku do ledgeru)' : ''}`)
    try {
      await applyOne({ client, files, file, sql: sources.get(file.version), backfill, allowedGaps })
    } catch (err) {
      const e = err instanceof MigrateError ? err : asMigrateError(err, '')
      const rest = pending.slice(done.length + 1).map((f) => f.version)
      const tail = e.committed
        ? ''
        : `\nTransakce ${file.version} se vrátila zpět, cíl zůstal ve stavu před ní.`
      throw Object.assign(
        new MigrateError(
          `Zastaveno na ${file.version}: ${e.message}${tail}` +
            (done.length ? `\nAplikované v tomto běhu: ${done.join(', ')}.` : '') +
            (rest.length ? `\nNezkoušené: ${rest.join(', ')}.` : ''),
        ),
        { applied: done },
      )
    }
    done.push(file.version)
    log(`  OK — řádek ${file.version} v schema_migration ověřen`)
  }
  return done
}

// Zapíše řádky baseline po jednom, každý ve vlastní transakci se zámkem.
// Soubor se nespouští. `pending` = soubory z inspect(baseline), `tables` =
// jejich zakládané tabulky (znovu se ověří uvnitř transakce).
export async function applyBaseline({ client, files, pending, tables = new Map(), allowedGaps = ALLOWED_VERSION_GAPS, log }) {
  const done = []
  for (const file of pending) {
    log(`→ ${file.version}  ${file.filename}  (baseline: jen zápis do evidence, soubor se nespouští)`)
    try {
      await baselineOne({ client, files, file, tables: tables.get(file.version) ?? [], allowedGaps, planned: pending.map((f) => f.version) })
    } catch (err) {
      const e = err instanceof MigrateError ? err : asMigrateError(err, '')
      const rest = pending.slice(done.length + 1).map((f) => f.version)
      throw Object.assign(
        new MigrateError(
          `Zastaveno na ${file.version}: ${e.message}` +
            (e.committed ? '' : `\nTransakce ${file.version} se vrátila zpět, cíl zůstal ve stavu před ní.`) +
            (done.length ? `\nZapsané v tomto běhu: ${done.join(', ')}.` : '') +
            (rest.length ? `\nNezkoušené: ${rest.join(', ')}.` : ''),
        ),
        { applied: done },
      )
    }
    done.push(file.version)
    log(`  OK — řádek ${file.version} v schema_migration ověřen`)
  }
  return done
}

async function baselineOne({ client, files, file, tables, allowedGaps, planned }) {
  try {
    await client.query('BEGIN')
  } catch (err) {
    throw asMigrateError(err, `${file.version}: nepodařilo se zahájit transakci: `)
  }
  try {
    const {
      rows: [lock],
    } = await client.query(MIGRATION_LOCK_SQL)
    if (!lock?.ok) {
      throw new MigrateError('Jiný běh právě migruje tuhle databázi (zámek je obsazený). Zkus to za chvíli znovu.')
    }
    const state = await readLedgerState(client)
    if (!state.hasLedger) throw new MigrateError('Na cíli chybí tabulka schema_migration.')
    if (state.versions.includes(file.version)) {
      throw new MigrateError(`Stav cíle se od plánu změnil — ${file.version} už v evidenci je.`)
    }
    const missing = await missingTables(client, tables)
    if (missing.length) {
      throw new MigrateError(`na cíli chybí tabulka ${missing.join(', ')}, kterou ${file.filename} zakládá.`)
    }
    await client.query('INSERT INTO public.schema_migration (version, note) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING', [
      file.version,
      BASELINE_LEDGER_NOTE,
    ])
    const now = await readLedgerState(client)
    if (!now.versions.includes(file.version)) {
      throw new MigrateError(`řádek ${file.version} se do schema_migration nezapsal.`)
    }
    // Zbytek baseline se ještě zapíše, takže se počítá, jako by už v evidenci byl.
    const problems = planMigrations(files, [...new Set([...now.versions, ...planned])].sort(), { allowedGaps }).problems
    if (problems.length) {
      throw new MigrateError(
        'evidence by po zápisu nesedělo se soubory:\n' + problems.map((p) => `  - ${describeProblem(p)}`).join('\n'),
      )
    }
    await client.query('COMMIT')
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch {
      // Spojení mohlo spadnout — server transakci vrátí sám.
    }
    throw asMigrateError(err, `${file.version}: `)
  }
}
