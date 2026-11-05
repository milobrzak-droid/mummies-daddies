import { describe, expect, test } from 'vitest'
import {
  ALLOWED_VERSION_GAPS,
  backfillCandidates,
  checkExpected,
  checkMigrationSource,
  createdTables,
  describeConnectError,
  describeProblem,
  findDuplicateVersions,
  findInvalidFilenames,
  formatDbError,
  hasTransactionControl,
  ledgerInsertVersions,
  ledgerMode,
  looksLikeProduction,
  parseProductionRefs,
  makeRedactor,
  parseArgs,
  parseDbUrl,
  parseMigrationFilename,
  parseMigrationFiles,
  parseVersionList,
  planMigrations,
  positionToLine,
  sameDatabase,
} from '../scripts/migrate-lib.mjs'

type MigrationFile = { version: string; description: string; filename: string }
type Problem = { code: string; versions: string[]; filenames?: string[] }

// Souvislá sada 0001..n, jak ji má běhač vidět na disku.
function disk(n: number): MigrationFile[] {
  return parseMigrationFiles(Array.from({ length: n }, (_, i) => `${String(i + 1).padStart(4, '0')}_m.sql`))
}
const versions = (n: number, from = 1) =>
  Array.from({ length: n - from + 1 }, (_, i) => String(i + from).padStart(4, '0'))
const codes = (problems: Problem[]) => problems.map((p) => p.code)

describe('názvy souborů', () => {
  test('rozparsuje platný název', () => {
    expect(parseMigrationFilename('0031_calendar_token_encryption.sql')).toEqual({
      version: '0031',
      description: 'calendar_token_encryption',
      filename: '0031_calendar_token_encryption.sql',
    })
  })

  test('odmítne název bez čísla, jinou příponu i velká písmena', () => {
    expect(parseMigrationFilename('README.sql')).toBeNull()
    expect(parseMigrationFilename('0031_x.md')).toBeNull()
    expect(parseMigrationFilename('0060_Pridat-X.sql')).toBeNull()
  })

  test('řadí numericky, ne podle řetězce', () => {
    const out = parseMigrationFiles(['10000_e.sql', '0002_b.sql', 'notes.txt', '0001_a.sql', '9999_d.sql'])
    expect(out.map((f: MigrationFile) => f.version)).toEqual(['0001', '0002', '9999', '10000'])
  })

  test('neplatné .sql názvy nahlásí (tiché přeskočení by migraci nikdy nespustilo)', () => {
    expect(findInvalidFilenames(['0001_a.sql', '0060_Pridat-X.sql', 'README.md'])).toEqual(['0060_Pridat-X.sql'])
  })

  test('kolize čísel', () => {
    const files = parseMigrationFiles(['0031_calendar_token.sql', '0031_gdpr_erasure.sql', '0032_ok.sql'])
    expect(findDuplicateVersions(files)).toEqual([
      { version: '0031', filenames: ['0031_calendar_token.sql', '0031_gdpr_erasure.sql'] },
    ])
  })
})

describe('planMigrations', () => {
  test('čeká jen souvislé pokračování za ledgerem, v pořadí', () => {
    const { pending, problems } = planMigrations(disk(5), versions(3))
    expect(pending.map((f: MigrationFile) => f.version)).toEqual(['0004', '0005'])
    expect(problems).toEqual([])
  })

  test('všechno aplikované = nic nečeká', () => {
    expect(planMigrations(disk(3), versions(3))).toEqual({ pending: [], backfill: [], problems: [] })
  })

  test('prázdný ledger = čeká všechno', () => {
    const { pending, problems } = planMigrations(disk(3), [])
    expect(pending.map((f: MigrationFile) => f.version)).toEqual(['0001', '0002', '0003'])
    expect(problems).toEqual([])
  })

  test('díra na disku (rezervované číslo jiné větve) se odmítne', () => {
    const files = parseMigrationFiles(['0001_a.sql', '0002_b.sql', '0004_d.sql'])
    const { problems } = planMigrations(files, ['0001'])
    expect(problems).toEqual([{ code: 'gap', versions: ['0003'] }])
  })

  test('verze v ledgeru bez souboru se odmítne', () => {
    const { problems } = planMigrations(disk(3), ['0001', '0002', '0099'])
    expect(problems).toEqual([{ code: 'unknown_applied', versions: ['0099'] }])
  })

  test('díra v ledgeru (mimo pořadí) se odmítne', () => {
    const { problems } = planMigrations(disk(5), ['0001', '0002', '0004'])
    expect(problems).toEqual([{ code: 'out_of_order', versions: ['0003'] }])
  })

  test('díra v ledgeru u ověřené 0029/0030 = jen doplnění řádku, ne problém', () => {
    const applied = versions(59).filter((v) => v !== '0029')
    const first = planMigrations(disk(60), applied)
    expect(first.problems).toEqual([{ code: 'out_of_order', versions: ['0029'] }])
    expect(backfillCandidates(first.problems)).toEqual(['0029'])

    const plan = planMigrations(disk(60), applied, { backfillable: ['0029'] })
    expect(plan.problems).toEqual([])
    expect(plan.backfill.map((f) => f.version)).toEqual(['0029'])
    expect(plan.pending.map((f) => f.version)).toEqual(['0060'])
  })

  test('doplnit smí jen 0029/0030, a jen jako díru pod nejvyšší aplikovanou', () => {
    const applied = versions(59).filter((v) => v !== '0040')
    expect(backfillCandidates(planMigrations(disk(59), applied).problems)).toEqual([])
    const forced = planMigrations(disk(59), applied, { backfillable: ['0040'] })
    expect(forced.problems).toEqual([{ code: 'out_of_order', versions: ['0040'] }])
    expect(forced.backfill).toEqual([])

    // Prázdný projekt: 0029 se normálně spustí, nic se nedoplňuje.
    const fresh = planMigrations(disk(35), versions(28), { backfillable: ['0029'] })
    expect(fresh.backfill).toEqual([])
    expect(fresh.pending.map((f) => f.version)).toEqual(versions(35, 29))
  })

  test('kolize čísel je problém plánu', () => {
    const files = parseMigrationFiles(['0001_a.sql', '0002_b.sql', '0002_c.sql'])
    expect(codes(planMigrations(files, []).problems)).toEqual(['duplicate'])
  })

  test('každý problém má českou hlášku s verzemi', () => {
    const { problems } = planMigrations(disk(5), ['0001', '0004', '0099'])
    const text = problems.map(describeProblem).join('\n')
    expect(text).toContain('0099')
    expect(text).toContain('0002, 0003')
  })
})

describe('záměrné mezery (0076–0077)', () => {
  // Disk jako v repu: 0001–0075 a 0078–0095 (bez záměrných mezer).
  const repoFiles = () =>
    parseMigrationFiles(
      Array.from({ length: 95 }, (_, i) => i + 1)
        .filter((n) => n !== 76 && n !== 77)
        .map((n) => `${String(n).padStart(4, '0')}_m.sql`),
    )
  const applied = (upTo: number) => versions(upTo).filter((v) => v !== '0076' && v !== '0077')

  test('jediný zdroj pravdy obsahuje 76, 77 a 97', () => {
    expect([...ALLOWED_VERSION_GAPS]).toEqual([76, 77, 97])
  })

  test('plán bez předaných mezer je přeskočí sám (výchozí hodnota) — dřívější chyba běhače', () => {
    const plan = planMigrations(repoFiles(), applied(93))
    expect(plan.problems).toEqual([])
    expect(plan.pending.map((f: MigrationFile) => f.version)).toEqual(['0094', '0095'])
  })

  test('mezera mimo seznam se pořád odmítne', () => {
    const files = repoFiles().filter((f: MigrationFile) => f.version !== '0080')
    const { problems } = planMigrations(files, applied(93).filter((v) => v !== '0080'))
    expect(problems).toContainEqual({ code: 'gap', versions: ['0080'] })
  })

  test('prázdný seznam mezer = 0076–0077 jsou díra (kontrola, že se opravdu čte parametr)', () => {
    const { problems } = planMigrations(repoFiles(), applied(93), { allowedGaps: [] })
    expect(problems).toEqual([{ code: 'gap', versions: ['0076', '0077'] }])
  })

  test('přeskočená mezera neznamená, že by ledger směl znát 0076', () => {
    const { problems } = planMigrations(repoFiles(), [...applied(93), '0076'])
    expect(problems).toContainEqual({ code: 'unknown_applied', versions: ['0076'] })
  })

  test('aplikovaná verze chybí v repu → plán se zastaví', () => {
    const { problems } = planMigrations(repoFiles(), [...applied(95), '0096'])
    expect(problems).toEqual([{ code: 'unknown_applied', versions: ['0096'] }])
  })
})

describe('baseline — pomocné funkce', () => {
  test('parseVersionList: výčet, rozsah, řazení, duplicity', () => {
    expect(parseVersionList('0092,0090-0091,0090')).toEqual(['0090', '0091', '0092'])
    expect(parseVersionList('0095')).toEqual(['0095'])
  })

  test('parseVersionList: nesmysl a příliš dlouhý rozsah = null', () => {
    for (const bad of ['', '90', '0090;0091', '0091-0090', '0001-0099', 'abcd', '0090,,0091']) {
      expect(parseVersionList(bad)).toBeNull()
    }
  })

  test('createdTables: zakládané tabulky bez komentářů a s IF NOT EXISTS', () => {
    const sql = `-- CREATE TABLE zrusena (id int);
      CREATE TABLE IF NOT EXISTS public.idoklad_invoice (id int);
      create table Foo_Bar (id int); /* CREATE TABLE ve_slozene (x int) */
      ALTER TABLE jina ADD COLUMN x int;`
    expect(createdTables(sql)).toEqual(['foo_bar', 'idoklad_invoice'])
    expect(createdTables('ALTER TABLE x ADD COLUMN y int;')).toEqual([])
  })

  test('--baseline v příkazové řádce', () => {
    const r = parseArgs(['--target=production', '--baseline=0090,0092-0093'])
    expect(r.options).toMatchObject({ baseline: ['0090', '0092', '0093'], mode: 'dry-run' })
    expect(parseArgs(['--target=staging']).options?.baseline).toBeNull()
    expect(parseArgs(['--target=staging', '--baseline=xx']).error).toMatch(/--baseline/)
    expect(parseArgs(['--target=staging', '--baseline=0090', '--expect=0091']).error).toMatch(/--expect/)
    expect(parseArgs(['--target=staging', '--baseline=0090,0091', '--expect=0090,0091']).error).toBeUndefined()
    // Produkce: zápis do evidence chce stejné potvrzení jako aplikace.
    expect(parseArgs(['--target=production', '--baseline=0090', '--apply']).error).toMatch(/--yes-production/)
  })

  test('každá nová hláška baseline je česky a s verzemi', () => {
    const text = [
      { code: 'baseline_unknown', versions: ['0099'] },
      { code: 'baseline_already', versions: ['0090'] },
      { code: 'baseline_no_ledger', versions: [] },
      { code: 'baseline_object_missing', versions: ['0092'], filenames: ['idoklad_invoice'] },
    ]
      .map(describeProblem)
      .join('\n')
    expect(text).toContain('0099')
    expect(text).toContain('0090')
    expect(text).toContain('schema_migration')
    expect(text).toContain('idoklad_invoice')
  })
})

describe('kontrola obsahu souboru', () => {
  const file = (version: string) => ({ version, description: 'x', filename: `${version}_x.sql` })
  const ok = (v: string) => `CREATE TABLE a (id int);\nINSERT INTO schema_migration (version, note) VALUES ('${v}', 'x') ON CONFLICT (version) DO NOTHING;`

  test('ledgerMode: před ledgerem, historické bez zápisu, ostatní samy', () => {
    expect(ledgerMode('0025')).toBe('pre-ledger')
    expect(ledgerMode('0026')).toBe('self')
    expect(ledgerMode('0029')).toBe('runner')
    expect(ledgerMode('0030')).toBe('runner')
    expect(ledgerMode('0060')).toBe('self')
  })

  test('nová migrace se zápisem do ledgeru projde', () => {
    expect(checkMigrationSource(file('0060'), ok('0060'))).toEqual([])
  })

  test('nová migrace bez zápisu do ledgeru neprojde', () => {
    expect(codes(checkMigrationSource(file('0060'), 'CREATE TABLE a (id int);'))).toEqual(['missing_ledger_insert'])
  })

  test('zápis v komentáři se nepočítá', () => {
    const sql = "-- INSERT INTO schema_migration (version) VALUES ('0060');\nCREATE TABLE a (id int);"
    expect(codes(checkMigrationSource(file('0060'), sql))).toEqual(['missing_ledger_insert'])
  })

  test('cizí verze v zápisu neprojde', () => {
    expect(codes(checkMigrationSource(file('0060'), ok('0060') + ok('0061')))).toEqual(['foreign_ledger_insert'])
  })

  test('vlastní BEGIN/COMMIT v nové migraci neprojde, v 0031/0032 ano', () => {
    const tx = (v: string) => `BEGIN;\n${ok(v)}\nCOMMIT;`
    expect(codes(checkMigrationSource(file('0060'), tx('0060')))).toEqual(['own_transaction'])
    expect(checkMigrationSource(file('0031'), tx('0031'))).toEqual([])
  })

  test('END; z PL/pgSQL ani BEGIN bez středníku nejsou řízení transakce', () => {
    expect(hasTransactionControl('DO $$\nBEGIN\n  PERFORM 1;\nEND;\n$$;')).toBe(false)
    expect(hasTransactionControl('  commit ;')).toBe(true)
    expect(hasTransactionControl('START TRANSACTION;')).toBe(true)
  })

  test('0026 smí zpětně zapsat 0001–0026', () => {
    const sql = "INSERT INTO schema_migration (version, note) VALUES ('0001', null), ('0026', 'x');"
    expect(ledgerInsertVersions(sql)).toEqual(['0001', '0026'])
    expect(checkMigrationSource(file('0026'), sql)).toEqual([])
  })
})

describe('parseArgs', () => {
  test('výchozí je nanečisto', () => {
    expect(parseArgs(['--target=staging']).options).toMatchObject({ mode: 'dry-run', implicitDryRun: true })
  })

  test('staging --apply', () => {
    expect(parseArgs(['--target=staging', '--apply']).options).toMatchObject({ target: 'staging', mode: 'apply' })
  })

  test('produkce bez --yes-production se odmítne, s ním projde', () => {
    expect(parseArgs(['--target=production', '--apply']).error).toMatch(/--yes-production/)
    expect(parseArgs(['--target=production', '--apply', '--yes-production']).options?.mode).toBe('apply')
    expect(parseArgs(['--target=production', '--dry-run']).options?.mode).toBe('dry-run')
  })

  test('--yes-production u stagingu, neznámý cíl, neznámý přepínač a oba režimy = chyba', () => {
    expect(parseArgs(['--target=staging', '--yes-production']).error).toBeTruthy()
    expect(parseArgs(['--target=prod']).error).toBeTruthy()
    expect(parseArgs([]).error).toBeTruthy()
    expect(parseArgs(['--target=staging', '--confirm']).error).toMatch(/Neznámý/)
    expect(parseArgs(['--target=staging', '--dry-run', '--apply']).error).toBeTruthy()
  })

  test('připojovací řetězec v argumentu se odmítne a nevypíše', () => {
    const r = parseArgs(['--target=staging', 'postgresql://u:tajne@h/db'])
    expect(r.error).toBeTruthy()
    expect(r.error).not.toContain('tajne')
  })

  test('--expect: seznam verzí nebo none', () => {
    expect(parseArgs(['--target=staging', '--expect=0060,0061']).options?.expect).toBe('0060,0061')
    expect(parseArgs(['--target=staging', '--expect=none']).options?.expect).toBe('none')
    expect(parseArgs(['--target=staging', '--expect=60;61']).error).toBeTruthy()
  })
})

describe('checkExpected', () => {
  const pending = parseMigrationFiles(['0060_a.sql', '0061_b.sql'])
  test('bez --expect nic nehlídá', () => expect(checkExpected(pending, null)).toBeNull())
  test('shoda projde', () => expect(checkExpected(pending, '0060,0061')).toBeNull())
  test('neshoda se odmítne', () => expect(checkExpected(pending, '0060')).toMatch(/liší/))
  test('none = nic nečeká', () => {
    expect(checkExpected([], 'none')).toBeNull()
    expect(checkExpected(pending, 'none')).toMatch(/liší/)
  })
})

describe('připojení', () => {
  test('rozparsuje Supabase session pooler včetně procent v hesle; vzdáleně TLS', () => {
    const cfg = parseDbUrl('postgresql://postgres.abcdefgh:p%40ss%2Fw0rd@aws-0-eu-central-1.pooler.supabase.com:5432/postgres')
    expect(cfg).toMatchObject({
      host: 'aws-0-eu-central-1.pooler.supabase.com',
      port: 5432,
      user: 'postgres.abcdefgh',
      password: 'p@ss/w0rd',
      database: 'postgres',
      ssl: { rejectUnauthorized: true },
    })
    expect(cfg.secrets).toContain('p@ss/w0rd')
    expect(cfg.secrets).toContain('p%40ss%2Fw0rd')
  })

  test('TLS: ověření certifikátu vždy, s kořenovým certifikátem z repa; sslmode ho nevypne', () => {
    const ca = '-----BEGIN CERTIFICATE-----\nabc\n-----END CERTIFICATE-----\n'
    expect(parseDbUrl('postgresql://u:p@db.example.com/postgres?sslmode=disable', { ca }).ssl).toEqual({
      rejectUnauthorized: true,
      ca,
    })
    expect(parseDbUrl('postgresql://u:p@db.example.com/postgres?sslmode=no-verify').ssl).toEqual({
      rejectUnauthorized: true,
    })
    // Vědomá výjimka pro lokální zkoušku proti jinému Postgresu.
    expect(parseDbUrl('postgresql://u:p@db.example.com/postgres', { ca, insecureTls: true }).ssl).toEqual({
      rejectUnauthorized: false,
    })
  })

  test('neověřitelný certifikát: hláška řekne, co udělat', () => {
    const tls = Object.assign(new Error('self-signed certificate in certificate chain'), { code: 'SELF_SIGNED_CERT_IN_CHAIN' })
    expect(describeConnectError(tls)).toMatch(/V supabase\/certs\/ chybí kořenový certifikát/)
    expect(describeConnectError(tls)).toContain('docs/PROVOZ.md')
    expect(describeConnectError(tls, { caLoaded: true })).toMatch(/k serveru nesedí/)
    const other = Object.assign(new Error('password authentication failed'), { code: '28P01' })
    expect(describeConnectError(other)).toBe('password authentication failed')
  })

  test('localhost bez TLS, výchozí port a databáze', () => {
    expect(parseDbUrl('postgres://u:p@localhost')).toMatchObject({ host: 'localhost', port: 5432, database: 'postgres', ssl: false })
    expect(parseDbUrl('postgres://u:p@[::1]:6000/x')).toMatchObject({ host: '::1', port: 6000, ssl: false })
  })

  test('nečitelný řetězec: chyba bez jeho obsahu', () => {
    for (const bad of ['not a url tajne', 'https://u:tajne@h/db', 'postgresql://u:%E0%A4%A@h/db']) {
      expect(() => parseDbUrl(bad)).toThrow(/nedá přečíst/)
      try {
        parseDbUrl(bad)
      } catch (err) {
        expect(String((err as Error).message)).not.toContain('tajne')
      }
    }
  })

  test('produkční projekty se poznají, staging ne', () => {
    const refs = parseProductionRefs(' prodref0001, ,neplatny ref!')
    expect(refs).toEqual(['prodref0001'])
    expect(looksLikeProduction('postgresql://postgres.prodref0001:x@h/db', refs)).toBe(true)
    expect(looksLikeProduction('postgresql://postgres.stagingref:x@h/db', refs)).toBe(false)
    // Bez nastavené proměnné nic jako produkce nevypadá (žádný ref v repu).
    expect(looksLikeProduction('postgresql://postgres.prodref0001:x@h/db', [])).toBe(false)
  })

  test('sameDatabase porovná host, port, uživatele a db', () => {
    const a = parseDbUrl('postgresql://u:a@Host.example:5432/postgres')
    const b = parseDbUrl('postgresql://u:b@host.example:5432/postgres')
    const c = parseDbUrl('postgresql://v:b@host.example:5432/postgres')
    expect(sameDatabase(a, b)).toBe(true)
    expect(sameDatabase(a, c)).toBe(false)
  })

  test('redakce vymaže heslo, uživatele, host i celé URL', () => {
    const cfg = parseDbUrl('postgresql://postgres.abcdefgh:s3cret@db.example.com:5432/postgres')
    const redact = makeRedactor(cfg.secrets)
    const msg = redact(
      'password authentication failed for user "postgres.abcdefgh" at db.example.com (s3cret) postgres://x:y@z/w',
    )
    expect(msg).not.toMatch(/abcdefgh|s3cret|example\.com|x:y@z/)
    expect(makeRedactor([])('conn postgresql://a:b@c/d failed')).toBe('conn *** failed')
  })
})

describe('chyby databáze', () => {
  const sql = 'CREATE TABLE a (id int);\nCREATE TABLE b (\n  id intt\n);'

  test('pozice → řádek souboru', () => {
    expect(positionToLine(sql, 1)).toBe(1)
    expect(positionToLine(sql, sql.indexOf('intt') + 1)).toBe(3)
    expect(positionToLine(sql, 'x')).toBeNull()
  })

  test('hláška nese kód, řádek a nápovědu, ale ne detail (data řádků)', () => {
    const err = Object.assign(new Error('type "intt" does not exist'), {
      code: '42704',
      position: String(sql.indexOf('intt') + 1),
      hint: 'zkontroluj typ',
      detail: 'Key (email)=(jan@firma.cz) already exists.',
    })
    const out = formatDbError(err, sql)
    expect(out).toContain('42704')
    expect(out).toContain('řádek 3')
    expect(out).toContain('zkontroluj typ')
    expect(out).not.toContain('jan@firma.cz')
  })

  test('data exception (třída 22): hodnota z řádku v message se zakryje', () => {
    const sql2 = 'ALTER TABLE contact ALTER COLUMN phone TYPE bigint USING phone::bigint;'
    const err = Object.assign(new Error('invalid input syntax for type bigint: "+420 777 123 456"'), {
      code: '22P02',
      position: '1',
    })
    const out = formatDbError(err, sql2)
    expect(out).not.toContain('777')
    expect(out).toContain('invalid input syntax for type bigint: "…"')
    expect(out).toContain('SQLSTATE 22P02')
    expect(out).toContain('řádek 1')

    const range = Object.assign(new Error('value "99999999999" is out of range for type integer'), {
      code: '22003',
      hint: 'hodnota "99999999999"',
    })
    expect(formatDbError(range, sql2)).not.toContain('99999999999')
  })

  test('mimo třídu 22 zůstávají názvy omezení a sloupců (potřebné k opravě)', () => {
    const err = Object.assign(new Error('null value in column "phone" of relation "contact" violates not-null constraint'), {
      code: '23502',
      detail: 'Failing row contains (1, jan@firma.cz, null).',
    })
    const out = formatDbError(err, '')
    expect(out).toContain('"phone"')
    expect(out).not.toContain('jan@firma.cz')
  })
})
