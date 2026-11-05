// Čistá logika migračního běhače — žádné I/O, žádná síť, proto testovatelná
// bez databáze (test/migrate-lib.test.ts). Databázovou část (transakce,
// ledger, zámek) má scripts/migrate-runner.mjs nad podstrčeným klientem,
// scripts/migrate.mjs dodává jen efekty: proměnné prostředí, soubory, `pg`.

const FILENAME_RE = /^(\d{4,})_([a-z0-9_]+)\.sql$/

// Kam se migruje a odkud se bere připojovací řetězec. Názvy jsou tytéž,
// které už znají GitHub secrets (docs/PROVOZ.md, migrate.yml).
export const TARGETS = {
  staging: { envVar: 'STAGING_DB_URL' },
  production: { envVar: 'SUPABASE_DB_URL' },
}

// Ref(y) produkčního Supabase projektu. V repu žádný není (nový systém nemá
// natvrdo zapsanou produkci); nastavují se proměnnou prostředí
// PRODUCTION_PROJECT_REFS (čárkami oddělené), kterou migrate.mjs předá
// funkci looksLikeProduction. Staging na produkci nesmí ukazovat ani omylem.
export function parseProductionRefs(raw) {
  return String(raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => /^[a-z0-9]{8,40}$/.test(s))
}

// 0026 zakládá tabulku schema_migration a zpětně do ní zapisuje 0001–0026.
// Starší soubory svůj řádek zapsat nemohly — ledger ještě neexistoval.
export const LEDGER_BOOTSTRAP_VERSION = '0026'

// Historické soubory bez vlastního INSERT INTO schema_migration (ověřeno
// grepem). Jen pro ně zapíše řádek běhač sám; každý jiný soubor >= 0027 ho
// musí mít (hlídá to i test/migrations-lint.test.ts). Neměnit — nové
// migrace sem nepatří.
export const LEGACY_NO_LEDGER_INSERT = new Set(['0029', '0030'])

// Úzká výjimka pro tytéž dva historické soubory: v produkci byly spuštěné
// ručně, takže jejich řádek v ledgeru může chybět, i když objekty existují
// (docs/PROVOZ.md, „0029 — unconfirmed“). Když takový řádek chybí POD
// nejvyšší aplikovanou verzí, běhač soubor znovu nespouští — jen ověří, že
// na cíli je to, co soubor zakládá, a teprve pak řádek doplní. Když objekt
// chybí, zůstává to „díra v ledgeru“ a nespustí se nic. Nic dalšího sem
// nepatří.
export const LEGACY_BACKFILL_PROBES = {
  '0029': "select to_regclass('public.connector_state') is not null as ok",
  '0030':
    'select count(*) = 8 as ok from information_schema.columns ' +
    "where table_schema = 'public' and table_name = 'account' and column_name in " +
    "('nace', 'legal_form', 'founded_on', 'profile', 'last_inbound_at', 'last_outbound_at', 'nudged_on', 'snooze_until')",
}

// Historické soubory s vlastním top-level BEGIN/COMMIT (spuštěné ručně dřív,
// než běhač obaloval transakcí). Vnořený BEGIN jen vydá varování, vlastní
// COMMIT na konci souboru uzavře i vnější transakci — obsah souboru včetně
// zápisu do ledgeru je pořád jedna transakce. Nové migrace sem nepatří.
export const LEGACY_OWN_TRANSACTION = new Set(['0031', '0032'])

// Záměrné mezery v číslování migrací — JEDINÝ zdroj pravdy. Čte ho běhač
// (planMigrations je výchozí hodnota `allowedGaps`, takže ho nejde zapomenout
// předat) i test/migrations-lint.test.ts; seznam se proto nemůže rozejít.
// 0076, 0077 a 0097 byla rezervovaná čísla souběžných větví, které se nikdy
// nesloučily (0097 nemá žádnou migraci); v produkci nejsou a nikdy nebudou.
// Test hlídá obojí směrem:
// mezera v repu musí být tady, a číslo tady nesmí mít soubor (jinak je
// seznam zastaralý). Přidat sem číslo = vědomé rozhodnutí s komentářem proč.
export const ALLOWED_VERSION_GAPS = Object.freeze([76, 77, 97])

export class MigrateError extends Error {
  constructor(message) {
    super(message)
    this.name = 'MigrateError'
  }
}

const num = (version) => Number(version)

/** @typedef {{ version: string, description: string, filename: string }} MigrationFile */

// Rozparsuje jeden název souboru migrace do { version, description, filename }.
// Vrátí null, když název neodpovídá konvenci `NNNN_popis.sql`.
/** @returns {MigrationFile | null} */
export function parseMigrationFilename(filename) {
  const m = FILENAME_RE.exec(filename)
  if (!m) return null
  return { version: m[1], description: m[2], filename }
}

// Platné soubory seřazené podle čísla verze vzestupně — v tomhle pořadí se
// aplikují. Neplatné názvy vypadnou; findInvalidFilenames je nahlásí.
/** @returns {MigrationFile[]} */
export function parseMigrationFiles(filenames) {
  return filenames
    .map(parseMigrationFilename)
    .filter((m) => m !== null)
    .sort((a, b) => num(a.version) - num(b.version) || (a.filename < b.filename ? -1 : 1))
}

// .sql soubory, které konvenci neodpovídají. Tiché přeskočení by znamenalo,
// že se migrace s překlepem v názvu (0060_Pridat-X.sql) nikdy nespustí.
/** @returns {string[]} */
export function findInvalidFilenames(filenames) {
  return filenames.filter((f) => f.endsWith('.sql') && !parseMigrationFilename(f)).sort()
}

// Verze, které se objevují ve víc než jednom souboru — kolize čísel,
// typicky dva souběžní agenti se stejným číslem (komit 72f81be).
/** @returns {{ version: string, filenames: string[] }[]} */
export function findDuplicateVersions(files) {
  const byVersion = new Map()
  for (const f of files) {
    const list = byVersion.get(f.version) ?? []
    list.push(f.filename)
    byVersion.set(f.version, list)
  }
  return [...byVersion.entries()]
    .filter(([, filenames]) => filenames.length > 1)
    .map(([version, filenames]) => ({ version, filenames }))
}

// Jádro rozhodování — čistá funkce nad dvěma seznamy.
//
//   files           — parseMigrationFiles() výstup (co je na disku)
//   appliedVersions — verze zapsané v `schema_migration` na cíli
//
// Aplikovat se smí jen souvislé pokračování: ledger musí být přesně prvních
// k souborů z disku a zbytek disku je `pending`. Cokoliv jiného je problém,
// kvůli kterému se nespustí nic:
//   duplicate       — dva soubory se stejným číslem
//   gap             — na disku chybí číslo, které NENÍ v ALLOWED_VERSION_GAPS
//                     (rezervované číslo jiné větve, která ještě nedorazila;
//                     aplikovat další by rozbilo pořadí). Záměrné mezery
//                     (0076–0077) se přeskočí.
//   unknown_applied — ledger zná verzi, ke které na disku není soubor
//                     (komit 474ab27: migrace proběhla, soubor se do repa nedostal)
//   out_of_order    — soubor s nižším číslem, než je nejvyšší aplikovaná verze,
//                     na cíli chybí (díra v ledgeru)
//
// `backfillable` — historické verze (LEGACY_BACKFILL_PROBES), u kterých běhač
// na cíli ověřil, že objekt existuje. Když jsou dírou v ledgeru, nejsou
// problémem, ale krokem `backfill` (doplnit jen řádek, soubor nespouštět).
/**
 * @param {MigrationFile[]} files
 * @param {string[]} appliedVersions
 * @param {{ allowedGaps?: readonly (string | number)[], backfillable?: string[] }} [options]
 * @returns {{ pending: MigrationFile[], backfill: MigrationFile[], problems: { code: string, versions: string[], filenames?: string[] }[] }}
 */
export function planMigrations(files, appliedVersions, { allowedGaps = ALLOWED_VERSION_GAPS, backfillable = [] } = {}) {
  const problems = []

  for (const d of findDuplicateVersions(files)) {
    problems.push({ code: 'duplicate', versions: [d.version], filenames: d.filenames })
  }

  const onDisk = new Set(files.map((f) => f.version))
  const diskNums = [...new Set(files.map((f) => num(f.version)))].sort((a, b) => a - b)
  const allowed = new Set(allowedGaps.map(Number))
  const gaps = []
  if (diskNums.length) {
    for (let v = 1; v < diskNums[diskNums.length - 1]; v++) {
      if (!diskNums.includes(v) && !allowed.has(v)) gaps.push(String(v).padStart(4, '0'))
    }
  }
  if (gaps.length) problems.push({ code: 'gap', versions: gaps })

  const applied = new Set(appliedVersions)
  const unknown = [...applied].filter((v) => !onDisk.has(v)).sort()
  if (unknown.length) problems.push({ code: 'unknown_applied', versions: unknown })

  const known = [...applied].filter((v) => onDisk.has(v))
  const maxApplied = known.length ? Math.max(...known.map(num)) : 0
  const verified = new Set(backfillable.filter((v) => Object.hasOwn(LEGACY_BACKFILL_PROBES, v)))
  const holeFiles = files.filter((f) => !applied.has(f.version) && num(f.version) < maxApplied)
  const backfill = holeFiles.filter((f) => verified.has(f.version))
  const holes = holeFiles.filter((f) => !verified.has(f.version)).map((f) => f.version)
  if (holes.length) problems.push({ code: 'out_of_order', versions: [...new Set(holes)] })

  const pending = files.filter((f) => !applied.has(f.version) && !backfill.includes(f))
  return { pending, backfill, problems }
}

// Díry v ledgeru, které smí běhač zkusit doplnit (po ověření objektu na cíli).
/** @returns {string[]} */
export function backfillCandidates(problems) {
  const holes = problems.find((p) => p.code === 'out_of_order')?.versions ?? []
  return holes.filter((v) => Object.hasOwn(LEGACY_BACKFILL_PROBES, v))
}

// Česká hláška k problému z planMigrations / checkMigrationSource.
export function describeProblem(p) {
  const list = p.versions.join(', ')
  switch (p.code) {
    case 'duplicate':
      return `Kolize čísel: verze ${list} je ve více souborech (${(p.filenames ?? []).join(', ')}). Přečísluj jeden z nich.`
    case 'gap':
      return (
        `Na disku chybí migrace ${list}. Typicky rezervované číslo jiné větve, která ještě nedorazila — ` +
        'nejdřív musí přijít ona, jinak by se pořadí rozbilo.'
      )
    case 'unknown_applied':
      return (
        `Ledger cíle zná verzi ${list}, ke které v repu není soubor. Cíl je napřed před repem ` +
        '(nebo je to jiná databáze) — nic se nespustí, dokud se to nevysvětlí.'
      )
    case 'out_of_order':
      return (
        `Na cíli chybí ${list}, ale vyšší verze už aplikované jsou (díra v ledgeru). ` +
        'Aplikovat mimo pořadí se nebude — ověř ručně, jestli migrace ve skutečnosti proběhla a jen chybí řádek. ' +
        '(U 0029/0030 běhač řádek doplní sám, pokud na cíli najde to, co soubor zakládá — tady to nenašel.)'
      )
    case 'baseline_unknown':
      return `Baseline ${list}: v repu k tomu není soubor migrace — zapisovat do evidence se dá jen verze, kterou repo zná.`
    case 'baseline_already':
      return `Baseline ${list}: řádek už v schema_migration je — nic k zapsání. Vyřaď ji ze seznamu.`
    case 'baseline_no_ledger':
      return 'Baseline: na cíli není tabulka schema_migration. Zapisovat do evidence se dá jen do existující — na prázdný projekt patří normální aplikace.'
    case 'baseline_object_missing':
      return (
        `Baseline ${list}: na cíli chybí tabulka ${(p.filenames ?? []).join(', ')}, kterou soubor zakládá — ` +
        'migrace tedy zjevně neproběhla a řádek do evidence se nezapíše. Pusť ji normální aplikací.'
      )
    case 'invalid_filename':
      return `Soubor neodpovídá konvenci NNNN_popis.sql (malá písmena, číslice, podtržítka): ${(p.filenames ?? []).join(', ')}`
    case 'own_transaction':
      return `${list}: soubor má vlastní BEGIN/COMMIT/ROLLBACK — běhač každou migraci obaluje transakcí sám, vlastní řízení transakce do souboru nepatří.`
    case 'missing_ledger_insert':
      return `${list}: soubor nezapisuje svůj řádek (INSERT INTO schema_migration … VALUES ('${p.versions[0]}', …) ON CONFLICT DO NOTHING).`
    case 'foreign_ledger_insert':
      return `${list}: soubor zapisuje do schema_migration cizí verzi (${(p.filenames ?? []).join(', ')}).`
    default:
      return `${p.code}: ${list}`
  }
}

// Odstraní `-- …` a `/* … */` komentáře, ať nechytáme zmínky v prose.
// Hrubé (neřeší `--` uvnitř řetězců), ale pro tyhle soubory stačí.
export function stripSqlComments(sql) {
  return sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '')
}

// Top-level řízení transakce na začátku řádku. `END;` se nehledá — to je
// konec PL/pgSQL bloku, ne COMMIT.
export function hasTransactionControl(sql) {
  return /^\s*(BEGIN|COMMIT|ROLLBACK|START\s+TRANSACTION)\s*;/im.test(stripSqlComments(sql))
}

// Verze, které soubor vkládá do schema_migration.
/** @returns {string[]} */
export function ledgerInsertVersions(sql) {
  const out = []
  // Všechny n-tice z VALUES (0026 jich zapisuje 26 najednou). Hrubé: `;`
  // uvnitř poznámky zkrátí výčet, první n-tice ale projde vždy.
  for (const m of stripSqlComments(sql).matchAll(/INSERT INTO\s+(?:public\.)?schema_migration\b[^;]*?VALUES([^;]*)/gi)) {
    for (const t of m[1].matchAll(/\(\s*'(\d+)'/g)) out.push(t[1])
  }
  return out
}

// Jak se po aplikaci ověří řádek v ledgeru:
//   pre-ledger — < 0026, tabulka ještě nemusí existovat (0026 je zapíše zpětně)
//   runner     — historický soubor bez vlastního zápisu, řádek doplní běhač
//   self       — soubor si řádek zapisuje sám; běhač jen ověří, že tam je
/** @returns {'pre-ledger' | 'runner' | 'self'} */
export function ledgerMode(version) {
  if (num(version) < num(LEDGER_BOOTSTRAP_VERSION)) return 'pre-ledger'
  if (LEGACY_NO_LEDGER_INSERT.has(version)) return 'runner'
  return 'self'
}

// Statická kontrola obsahu jednoho souboru před spuštěním — ať nanečisto
// běh odhalí chybu dřív, než kdokoliv schválí aplikaci.
export function checkMigrationSource(file, sql) {
  const problems = []
  if (!LEGACY_OWN_TRANSACTION.has(file.version) && hasTransactionControl(sql)) {
    problems.push({ code: 'own_transaction', versions: [file.version] })
  }
  const inserted = ledgerInsertVersions(sql)
  const foreign = [...new Set(inserted.filter((v) => v !== file.version))]
  // 0026 zpětně zapisuje 0001–0026, to je jeho účel.
  if (file.version !== LEDGER_BOOTSTRAP_VERSION && foreign.length) {
    problems.push({ code: 'foreign_ledger_insert', versions: [file.version], filenames: foreign })
  }
  if (ledgerMode(file.version) === 'self' && !inserted.includes(file.version)) {
    problems.push({ code: 'missing_ledger_insert', versions: [file.version] })
  }
  return problems
}

// Tabulky, které soubor zakládá (CREATE TABLE [IF NOT EXISTS] [public.]x).
// Slouží jako jediná automatická pojistka baseline: řádek do evidence se
// nezapíše, když na cíli některá z nich chybí. Migrace, které tabulku
// nezakládají (jen ALTER, funkce, politiky), takhle ověřit nejdou — baseline
// je pak výslovné tvrzení vlastníka a plán to vypíše jako „neověřeno“.
/** @returns {string[]} */
export function createdTables(sql) {
  const out = new Set()
  for (const m of stripSqlComments(sql).matchAll(/CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?([a-z_][a-z0-9_]*)"?/gi)) {
    out.add(m[1].toLowerCase())
  }
  return [...out].sort()
}

// „0090,0092-0094“ → ['0090', '0092', '0093', '0094'] (seřazené, unikátní).
// Vrací null u čehokoliv, co takhle nevypadá; rozsah je omezený, ať překlep
// nezapíše do evidence půlku historie.
/** @returns {string[] | null} */
export function parseVersionList(text) {
  if (typeof text !== 'string' || !text) return null
  const out = new Set()
  for (const part of text.split(',')) {
    const m = /^(\d{4})(?:-(\d{4}))?$/.exec(part.trim())
    if (!m) return null
    const from = Number(m[1])
    const to = m[2] ? Number(m[2]) : from
    if (to < from || to - from >= 50) return null
    for (let v = from; v <= to; v++) out.add(String(v).padStart(4, '0'))
  }
  return [...out].sort()
}

// ---------------------------------------------------------------------------
// Příkazová řádka

export const USAGE =
  'Použití: node scripts/migrate.mjs --target=staging|production [--dry-run | --apply] ' +
  '[--baseline=0090,0092-0094] [--yes-production] [--expect=0060,0061|none] [--github-output]'

// Vrací { options } nebo { error }. Neznámý přepínač je chyba — překlep
// nesmí tiše změnit význam běhu.
export function parseArgs(argv) {
  const options = {
    target: null,
    mode: null,
    implicitDryRun: false,
    yesProduction: false,
    expect: null,
    baseline: null,
    githubOutput: false,
  }
  for (const arg of argv) {
    if (arg.includes('://')) {
      return { error: 'Připojovací řetězec se nepředává argumentem — patří do proměnné prostředí (viz docs/PROVOZ.md).' }
    }
    if (arg.startsWith('--target=')) options.target = arg.slice('--target='.length)
    else if (arg === '--dry-run' || arg === '--apply') {
      const mode = arg.slice(2)
      if (options.mode && options.mode !== mode) return { error: '--dry-run a --apply nejdou spolu.' }
      options.mode = mode
    } else if (arg === '--yes-production') options.yesProduction = true
    else if (arg.startsWith('--expect=')) options.expect = arg.slice('--expect='.length)
    else if (arg.startsWith('--baseline=')) {
      const list = parseVersionList(arg.slice('--baseline='.length))
      if (!list) {
        return { error: '--baseline čeká verze čtyřmístně, oddělené čárkou, případně rozsah (např. 0090,0092-0094).' }
      }
      options.baseline = list
    } else if (arg === '--github-output') options.githubOutput = true
    else return { error: `Neznámý přepínač ${arg.slice(0, 40)}.` }
  }
  if (!options.target || !Object.hasOwn(TARGETS, options.target)) {
    return { error: 'Chybí nebo nesedí --target (staging | production).' }
  }
  if (!options.mode) {
    options.mode = 'dry-run'
    options.implicitDryRun = true
  }
  if (options.yesProduction && options.target !== 'production') {
    return { error: '--yes-production patří jen k --target=production.' }
  }
  if (options.target === 'production' && options.mode === 'apply' && !options.yesProduction) {
    return { error: 'Cíl je PRODUKCE — aplikace vyžaduje navíc --yes-production.' }
  }
  if (options.baseline && options.expect !== null && options.expect !== options.baseline.join(',')) {
    return { error: 'U --baseline musí --expect obsahovat přesně stejný seznam verzí.' }
  }
  if (options.expect !== null && options.expect !== 'none' && !/^\d{4,}(,\d{4,})*$/.test(options.expect)) {
    return { error: '--expect čeká seznam verzí oddělený čárkami (např. 0060,0061) nebo none.' }
  }
  return { options }
}

// --expect: aplikuje se přesně to, co ukázal nanečisto běh a co někdo
// schválil. Vrací hlášku při neshodě, jinak null.
export function checkExpected(pending, expect) {
  if (expect === null) return null
  const want = expect === 'none' ? '' : expect
  const got = pending.map((f) => f.version).join(',')
  if (want === got) return null
  return (
    `Plán se liší od schváleného: čekalo se [${want || 'nic'}], na cíli teď chybí [${got || 'nic'}]. ` +
    'Nic se nespustilo — pusť znovu nanečisto a schval nový plán.'
  )
}

// ---------------------------------------------------------------------------
// Připojení

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1'])

// Připojovací řetězec → konfigurace pro `pg.Client` + seznam řetězců, které
// se nikdy nesmí objevit ve výstupu. Hodnota se v chybě nevypisuje nikdy.
//
// TLS: vzdálený host vždy šifrovaně A s ověřeným certifikátem včetně jména
// hostu (verify-full). Běhač se hlásí rolí vlastníka databáze a spouští DDL —
// bez ověření by se mezi něj a databázi mohl vložit kdokoliv na cestě
// (podvržené DNS, cizí Wi-Fi). `ca` = kořenový certifikát Supabase
// (supabase/certs/*.crt, načítá scripts/migrate.mjs); bez něj platí systémové
// kořenové autority. `insecureTls` je vědomá výjimka jen pro lokální zkoušku
// proti jinému Postgresu (MIGRATE_DB_TLS_INSECURE=1) — šifruje, ale neověřuje.
// `sslmode` v řetězci se ignoruje, aby se ověření nedalo potichu vypnout
// konfigurací. Localhost (lokální zkouška) bez TLS.
/**
 * @param {string} raw
 * @param {{ ca?: string | null, insecureTls?: boolean }} [options]
 */
export function parseDbUrl(raw, { ca = null, insecureTls = false } = {}) {
  const unreadable = new MigrateError(
    'Připojovací řetězec se nedá přečíst (čeká se postgresql://uživatel:heslo@host:port/databáze). ' +
      'Hodnota se z bezpečnostních důvodů nevypisuje.',
  )
  let u
  try {
    u = new URL(raw)
  } catch {
    throw unreadable
  }
  if (u.protocol !== 'postgres:' && u.protocol !== 'postgresql:') throw unreadable
  const host = u.hostname.replace(/^\[|\]$/g, '')
  if (!host) throw unreadable
  let user, password, database
  try {
    user = decodeURIComponent(u.username)
    password = decodeURIComponent(u.password)
    database = decodeURIComponent(u.pathname.replace(/^\//, '')) || 'postgres'
  } catch {
    throw unreadable
  }
  const port = u.port ? Number(u.port) : 5432
  const ssl = LOCAL_HOSTS.has(host)
    ? false
    : insecureTls
      ? { rejectUnauthorized: false }
      : { rejectUnauthorized: true, ...(ca ? { ca } : {}) }
  const secrets = [raw, u.password, password, u.username, user, u.hostname, host].filter((s) => s && s.length >= 3)
  return { host, port, user, password, database, ssl, secrets: [...new Set(secrets)] }
}

// Totožnost databáze (host+port+uživatel+db) — pro pojistku, že staging
// není tatáž databáze jako produkce.
export function sameDatabase(a, b) {
  return (
    a.host.toLowerCase() === b.host.toLowerCase() && a.port === b.port && a.user === b.user && a.database === b.database
  )
}

export function looksLikeProduction(raw, refs = parseProductionRefs(process.env.PRODUCTION_PROJECT_REFS)) {
  return refs.some((ref) => raw.includes(ref))
}

// Chyby TLS z Node, když certifikát serveru nejde ověřit.
const TLS_VERIFY_CODES = new Set([
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'CERT_HAS_EXPIRED',
  'CERT_UNTRUSTED',
  'ERR_TLS_CERT_ALTNAME_INVALID',
])

// Hláška k selhanému připojení; u neověřitelného certifikátu řekne, co dělat.
/**
 * @param {any} err
 * @param {{ caLoaded?: boolean }} [options]
 */
export function describeConnectError(err, { caLoaded = false } = {}) {
  const base = String(err?.message ?? err)
  if (!TLS_VERIFY_CODES.has(err?.code)) return base
  return (
    `${base}\nCertifikát serveru se nepodařilo ověřit, spojení se proto nenavázalo. ` +
    (caLoaded
      ? 'Kořenový certifikát v supabase/certs/ k serveru nesedí (jiný projekt, nebo ho Supabase vyměnil) — stáhni aktuální.'
      : 'V supabase/certs/ chybí kořenový certifikát Supabase (Project Settings → Database → SSL Configuration → Download certificate).') +
    ' Postup: docs/PROVOZ.md, oddíl 1a.'
  )
}

// Vrátí funkci, která z textu vymaže všechna tajemství i cokoliv, co
// vypadá jako připojovací řetězec. Každá chyba jde ven jen přes ni.
export function makeRedactor(secrets) {
  const sorted = [...new Set(secrets.filter(Boolean))].sort((a, b) => b.length - a.length)
  return (text) => {
    let out = String(text)
    for (const s of sorted) out = out.split(s).join('***')
    return out.replace(/postgres(?:ql)?:\/\/\S+/gi, '***')
  }
}

// ---------------------------------------------------------------------------
// Chyby databáze

// Postgres hlásí pozici chyby jako 1-based index znaku v dotazu. Soubor se
// posílá beze změny, takže index míří přímo do souboru.
export function positionToLine(sql, position) {
  const p = Number(position)
  if (!Number.isFinite(p) || p < 1) return null
  return sql.slice(0, p - 1).split('\n').length
}

// Hláška z chyby `pg`. `detail` se schválně nevypisuje — u porušení
// unikátnosti obsahuje hodnoty řádků (osobní údaje by skončily v logu CI).
// U třídy 22 (data exception: 22P02 neplatný vstup, 22003 mimo rozsah,
// 22007/22008 datum…) dává Postgres hodnotu z existujícího řádku přímo do
// `message` v uvozovkách („invalid input syntax for type bigint: "+420 …"“),
// proto se tam všechno v uvozovkách zakryje. Třída 23 (omezení) má hodnoty
// jen v `detail`, v `message` jsou názvy omezení a sloupců — ty zůstávají,
// jsou potřeba k opravě migrace.
export function formatDbError(err, sql) {
  const dataException = typeof err?.code === 'string' && err.code.startsWith('22')
  const mask = (text) => (dataException ? String(text).replace(/"(?:[^"]|"")*"/g, '"…"') : String(text))
  const parts = [mask(err?.message ?? err)]
  if (err?.code) parts.push(`[SQLSTATE ${err.code}]`)
  const line = sql && err?.position ? positionToLine(sql, err.position) : null
  if (line) parts.push(`(řádek ${line})`)
  let out = parts.join(' ')
  if (err?.hint) out += `\nNápověda: ${mask(err.hint)}`
  return out
}
