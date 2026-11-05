// Statická kontrola supabase/migrations/*.sql — bez databáze, bez sítě.
// Hlídá konvence, které se jinak ověřují jen očima při recenzi: číslování,
// žádné vlastní BEGIN/COMMIT (scripts/migrate.mjs každý soubor obaluje sám),
// RLS + RESTRICTIVE AAL2 na nových tabulkách, search_path u SECURITY DEFINER,
// zápis vlastní verze do schema_migration (běhač ho po aplikaci ověřuje)
// a platné názvy souborů. Výjimky pro historické soubory sdílí se samotným
// běhačem (scripts/migrate-lib.mjs), aby lint a běhač nemohly nesouhlasit.
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  ALLOWED_VERSION_GAPS,
  LEGACY_NO_LEDGER_INSERT,
  LEGACY_OWN_TRANSACTION,
  checkMigrationSource,
  describeProblem,
  findDuplicateVersions,
  findInvalidFilenames,
  parseMigrationFiles,
  stripSqlComments,
} from '../scripts/migrate-lib.mjs'

const DIR = join(__dirname, '..', 'supabase', 'migrations')
type Migration = { version: string; filename: string; n: number; sql: string }
const sqlFilenames = readdirSync(DIR).filter((f) => f.endsWith('.sql'))
const parsed: { version: string; description: string; filename: string }[] = parseMigrationFiles(sqlFilenames)
const raw = new Map(parsed.map((f) => [f.version, readFileSync(join(DIR, f.filename), 'utf8')]))
const files: Migration[] = parsed.map((f) => ({
  ...f,
  n: Number(f.version),
  sql: stripSqlComments(raw.get(f.version) ?? ''),
}))

// Záměrné mezery v číslování (0076, 0077 — rezervovaná čísla větví, které se
// nikdy nesloučily) žijí na jediném místě, ALLOWED_VERSION_GAPS v
// scripts/migrate-lib.mjs. Čte je běhač migrací i tenhle test, takže se
// seznam nemůže rozejít: běhač mezery přeskočí, test hlídá, že skutečné
// mezery v repu jsou přesně tyhle. Dočasná čísla nesloučených větví sem
// nepatří — ta vyřeší merge větve, ne výjimka.
const ALLOWED_VERSION_GAPS_LIST: number[] = [...ALLOWED_VERSION_GAPS]

// Historické soubory s vlastním top-level BEGIN/COMMIT (0031, 0032) — seznam
// a zdůvodnění v scripts/migrate-lib.mjs (LEGACY_OWN_TRANSACTION). Neměnit.
const ALLOWED_TOP_LEVEL_TX: Set<string> = LEGACY_OWN_TRANSACTION

// Tabulky (>= 0028) s RLS, ale bez RESTRICTIVE AAL2 politiky.
//   job_lock (0040): RLS bez politik + REVOKE ALL FROM anon, authenticated —
//     čistě serverový zámek, klient k němu nemá přístup vůbec.
//   connector_state (0029): RLS bez politik (vzor api_key z 0024), čte/píše
//     jen service role (core/connectorState.ts přes admin klienta). REVOKE
//     ALL FROM anon, authenticated doplnila až 0044 — proto se REVOKE hledá
//     v kterékoli migraci, ne jen v té, která tabulku zakládá.
const ALLOWED_NO_AAL2 = new Map<string, { revokeRequired: boolean }>([
  ['job_lock', { revokeRequired: true }],
  ['connector_state', { revokeRequired: true }],
  // mfa_failure (0069): počítadlo neúspěšných TOTP, jen service role.
  ['mfa_failure', { revokeRequired: true }],
  // oauth_refresh_token (0083): hashe refresh tokenů konektoru, jen service role.
  ['oauth_refresh_token', { revokeRequired: true }],
])

describe('supabase/migrations lint', () => {
  test('každý .sql soubor odpovídá konvenci NNNN_popis.sql', () => {
    expect(findInvalidFilenames(sqlFilenames)).toEqual([])
  })

  test('verze jsou unikátní a souvislé', () => {
    expect(findDuplicateVersions(files)).toEqual([])
    const nums = files.map((f) => f.n)
    expect(nums[0]).toBe(1)
    const gaps: number[] = []
    for (let v = nums[0]; v <= nums[nums.length - 1]; v++) if (!nums.includes(v)) gaps.push(v)
    expect(gaps).toEqual(ALLOWED_VERSION_GAPS_LIST)
  })

  test('záměrná mezera nemá soubor (jinak je seznam zastaralý)', () => {
    const present = ALLOWED_VERSION_GAPS_LIST.filter((n) => files.some((f) => f.n === n))
    expect(present).toEqual([])
  })

  test('žádný top-level BEGIN/COMMIT (mimo whitelist)', () => {
    const offenders = files
      .filter((f) => /^\s*(BEGIN|COMMIT)\s*;/im.test(f.sql))
      .map((f) => f.version)
    expect(offenders.sort()).toEqual([...ALLOWED_TOP_LEVEL_TX].sort())
  })

  test('každá CREATE TABLE (>= 0028) má RLS a RESTRICTIVE AAL2 politiku', () => {
    const problems: string[] = []
    for (const f of files.filter((x) => x.n >= 28)) {
      const tables = [...f.sql.matchAll(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(?:public\.)?(\w+)/gi)].map((m) =>
        m[1].toLowerCase(),
      )
      // 0039 zapíná RLS a politiky dynamicky v DO bloku přes
      // FOREACH t IN ARRAY ARRAY['a', 'b', …] + format('… %I …').
      const loopTables = new Set<string>()
      const doLoop = /ARRAY\s*\[([^\]]*)\][\s\S]*?ENABLE ROW LEVEL SECURITY[\s\S]*?AS RESTRICTIVE[\s\S]*?aal2/i.exec(f.sql)
      if (doLoop) for (const m of doLoop[1].matchAll(/'(\w+)'/g)) loopTables.add(m[1].toLowerCase())

      for (const t of tables) {
        if (loopTables.has(t)) continue
        const rls = new RegExp(`ALTER TABLE\\s+(?:public\\.)?${t}\\s+ENABLE ROW LEVEL SECURITY`, 'i').test(f.sql)
        const aal2 = new RegExp(
          `CREATE POLICY\\s+\\w+\\s+ON\\s+(?:public\\.)?${t}\\s+AS RESTRICTIVE[^;]*aal2`,
          'i',
        ).test(f.sql)
        if (!rls) problems.push(`${f.filename}: ${t} bez ENABLE ROW LEVEL SECURITY`)
        if (aal2) continue
        const allowed = ALLOWED_NO_AAL2.get(t)
        if (!allowed) {
          problems.push(`${f.filename}: ${t} bez RESTRICTIVE AAL2 politiky`)
        } else if (allowed.revokeRequired) {
          const revoked = new RegExp(`REVOKE ALL ON\\s+(?:public\\.)?${t}\\s+FROM[^;]*anon[^;]*authenticated`, 'i')
          if (!files.some((g) => revoked.test(g.sql))) problems.push(`${f.filename}: ${t} bez politik, ale i bez REVOKE klientům`)
        }
      }
    }
    expect(problems).toEqual([])
  })

  test('každá SECURITY DEFINER funkce (>= 0028) nastavuje search_path', () => {
    const problems: string[] = []
    for (const f of files.filter((x) => x.n >= 28)) {
      // Rozsekat na CREATE FUNCTION až po začátek těla ($$ nebo AS $tag$).
      for (const m of f.sql.matchAll(/CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+([\w.]+)([\s\S]*?)\$\w*\$/gi)) {
        const header = m[2]
        if (/SECURITY DEFINER/i.test(header) && !/SET\s+search_path/i.test(header)) {
          problems.push(`${f.filename}: ${m[1]}`)
        }
      }
    }
    expect(problems).toEqual([])
  })

  test('každá migrace >= 0027 zapisuje svůj řádek do schema_migration', () => {
    // Běhač po aplikaci ověří řádek a bez něj transakci vrátí. Výjimky jsou
    // jen historické 0029/0030 (LEGACY_NO_LEDGER_INSERT) — za ně řádek
    // zapíše běhač.
    const missing = files
      .filter((f) => f.n >= 27 && !LEGACY_NO_LEDGER_INSERT.has(f.version))
      .filter((f) => !new RegExp(`INSERT INTO\\s+(?:public\\.)?schema_migration\\b[^;]*?VALUES\\s*\\(\\s*'${f.version}'`, 'i').test(f.sql))
      .map((f) => f.filename)
    expect(missing).toEqual([])
  })

  test('běhač by přijal každý soubor v repu (prázdný projekt od 0001)', () => {
    const problems = parsed.flatMap((f) => checkMigrationSource(f, raw.get(f.version) ?? '').map(describeProblem))
    expect(problems).toEqual([])
  })

  test('INSERT INTO schema_migration (>= 0026) nese verzi ze jména souboru', () => {
    // 0026 zakládá ledger a zpětně do něj zapisuje 0001–0026 (backfill),
    // proto je vyjmutá.
    const problems: string[] = []
    for (const f of files.filter((x) => x.n >= 27)) {
      for (const m of f.sql.matchAll(/INSERT INTO\s+(?:public\.)?schema_migration\b[^;]*?VALUES\s*\(\s*'(\d+)'/gi)) {
        if (m[1] !== f.version) problems.push(`${f.filename}: vkládá '${m[1]}'`)
      }
    }
    expect(problems).toEqual([])
  })
})
