// scripts/migrate-runner.mjs proti falešnému klientovi Postgresu. PGlite
// v repu není, proto fake: umí transakce (snímek ledgeru při BEGIN, návrat
// při ROLLBACK), advisory zámek, to_regclass a „spuštění“ souboru — zápisy
// INSERT INTO schema_migration z obsahu souboru, CREATE TABLE ledgeru
// a chybu na značce FAIL (s pozicí jako skutečný Postgres).
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { LEGACY_BACKFILL_PROBES, MigrateError } from '../scripts/migrate-lib.mjs'
import { MIGRATION_LOCK_SQL, applyBaseline, applyPending, inspect } from '../scripts/migrate-runner.mjs'

type Rows = { rows: Record<string, unknown>[] }

class FakePg {
  ledger: Set<string> | null
  otherTables: number
  lockFree = true
  // Verze, jejíž INSERT do ledgeru se „nepovede“ (soubor ho má jen naoko).
  swallowInsertFor: string | null = null
  // Po COMMIT tahle verze z ledgeru zmizí (kontrola po COMMIT).
  loseOnCommit: string | null = null
  // Zavolá se před každým BEGIN (ne read-only) — simulace souběžného běhu.
  beforeBegin: ((db: FakePg) => void) | null = null
  // Historické verze, jejichž objekt (connector_state, sloupce account) na cíli existuje.
  objects = new Set<string>()
  // Tabulky v public (kromě ledgeru), které na cíli existují.
  tables = new Set<string>()
  statements: string[] = []
  executedFiles: string[] = []
  private snapshot: { ledger: Set<string> | null; otherTables: number } | null = null

  constructor(ledger: string[] | null, otherTables = 0) {
    this.ledger = ledger ? new Set(ledger) : null
    this.otherTables = otherTables
  }

  async query(text: string, params?: unknown[]): Promise<Rows> {
    const t = text.trim()
    this.statements.push(t.split('\n')[0])
    if (t === 'BEGIN' || t === 'BEGIN TRANSACTION READ ONLY') {
      if (t === 'BEGIN') this.beforeBegin?.(this)
      this.snapshot = { ledger: this.ledger ? new Set(this.ledger) : null, otherTables: this.otherTables }
      return { rows: [] }
    }
    if (t === 'COMMIT') {
      this.snapshot = null
      if (this.loseOnCommit) this.ledger?.delete(this.loseOnCommit)
      return { rows: [] }
    }
    if (t === 'ROLLBACK') {
      if (this.snapshot) {
        this.ledger = this.snapshot.ledger
        this.otherTables = this.snapshot.otherTables
      }
      this.snapshot = null
      return { rows: [] }
    }
    if (t === MIGRATION_LOCK_SQL) return { rows: [{ ok: this.lockFree }] }
    for (const [v, probe] of Object.entries(LEGACY_BACKFILL_PROBES)) {
      if (t === probe) return { rows: [{ ok: this.objects.has(v) }] }
    }
    if (t.startsWith('select tablename from pg_catalog.pg_tables')) {
      const wanted = (params?.[0] ?? []) as string[]
      return { rows: wanted.filter((n) => this.tables.has(n)).map((tablename) => ({ tablename })) }
    }
    if (t.startsWith('select to_regclass')) {
      return { rows: [{ has_ledger: this.ledger !== null, other_tables: this.otherTables }] }
    }
    if (t.startsWith('select version from public.schema_migration')) {
      return { rows: [...(this.ledger ?? [])].sort().map((version) => ({ version })) }
    }
    if (t.startsWith('SET LOCAL')) return { rows: [] }
    if (t.startsWith('INSERT INTO public.schema_migration')) {
      this.requireLedger()
      this.ledger!.add(String(params?.[0]))
      return { rows: [] }
    }
    return this.runFile(text)
  }

  private requireLedger() {
    if (!this.ledger) throw Object.assign(new Error('relation "schema_migration" does not exist'), { code: '42P01' })
  }

  private runFile(sql: string): Rows {
    const version = /-- file (\d+)/.exec(sql)?.[1] ?? '?'
    this.executedFiles.push(version)
    const fail = sql.indexOf('FAIL')
    if (fail >= 0) {
      throw Object.assign(new Error('syntax error at or near "FAIL"'), {
        code: '42601',
        position: String(fail + 1),
        detail: 'Key (email)=(jan@firma.cz) already exists.',
      })
    }
    if (sql.includes('CREATE TABLE IF NOT EXISTS schema_migration')) this.ledger ??= new Set()
    this.otherTables += (sql.match(/CREATE TABLE t_/g) ?? []).length
    const insert = sql.indexOf('INSERT INTO schema_migration')
    if (insert >= 0 && this.swallowInsertFor !== version) {
      this.requireLedger()
      for (const m of sql.slice(insert).matchAll(/\('(\d{4})'/g)) this.ledger!.add(m[1])
    }
    return { rows: [] }
  }
}

const pad = (n: number) => String(n).padStart(4, '0')
const own = (v: string) => `INSERT INTO schema_migration (version, note) VALUES ('${v}', 'x') ON CONFLICT (version) DO NOTHING;`

// Obsah souboru podle verze — napodobuje skutečnou historii repa:
// < 0026 bez ledgeru, 0026 ho založí a zpětně zapíše, 0029/0030 bez
// vlastního zápisu, 0031/0032 s vlastním BEGIN/COMMIT, ostatní se zápisem.
function defaultSql(n: number): string {
  const v = pad(n)
  const head = `-- file ${v}\n`
  if (n < 26) return `${head}CREATE TABLE t_${v} (id int);`
  if (n === 26) {
    const all = Array.from({ length: 26 }, (_, i) => `('${pad(i + 1)}', null)`).join(', ')
    return `${head}CREATE TABLE IF NOT EXISTS schema_migration (version text PRIMARY KEY);\nINSERT INTO schema_migration (version, note) VALUES ${all} ON CONFLICT (version) DO NOTHING;`
  }
  if (n === 29 || n === 30) return `${head}CREATE TABLE t_${v} (id int);`
  if (n === 31 || n === 32) return `${head}BEGIN;\nALTER TABLE t_0001 ADD COLUMN c${v} int;\n${own(v)}\nCOMMIT;`
  return `${head}ALTER TABLE t_0001 ADD COLUMN c${v} int;\n${own(v)}`
}

function repo(n: number, overrides: Record<string, string> = {}) {
  const sql: Record<string, string> = {}
  for (let i = 1; i <= n; i++) sql[`${pad(i)}_m${i}.sql`] = defaultSql(i)
  Object.assign(sql, overrides)
  return {
    filenames: Object.keys(sql),
    readSql: async (f: string) => {
      if (!(f in sql)) throw new Error(`no file ${f}`)
      return sql[f]
    },
  }
}

const upTo = (n: number) => Array.from({ length: n }, (_, i) => pad(i + 1))

async function run(db: FakePg, r: ReturnType<typeof repo>) {
  const log: string[] = []
  const plan = await inspect({ client: db, filenames: r.filenames, readSql: r.readSql })
  const applied = await applyPending({ client: db, ...plan, log: (l: string) => log.push(l) })
  return { plan, applied, log }
}

async function failure(p: Promise<unknown>): Promise<MigrateError & { applied?: string[] }> {
  try {
    await p
  } catch (err) {
    expect(err).toBeInstanceOf(MigrateError)
    return err as MigrateError
  }
  throw new Error('čekala se chyba')
}

describe('nanečisto (inspect)', () => {
  test('jen čte v read-only transakci a vrátí chybějící v pořadí', async () => {
    const db = new FakePg(upTo(33), 10)
    const r = repo(35)
    const plan = await inspect({ client: db, filenames: r.filenames, readSql: r.readSql })
    expect(plan.pending.map((f: { version: string }) => f.version)).toEqual(['0034', '0035'])
    expect(db.statements[0]).toBe('BEGIN TRANSACTION READ ONLY')
    expect(db.statements.at(-1)).toBe('ROLLBACK')
    expect(db.executedFiles).toEqual([])
  })

  test('aktuální cíl: nic nečeká', async () => {
    const r = repo(35)
    const plan = await inspect({ client: new FakePg(upTo(35), 10), filenames: r.filenames, readSql: r.readSql })
    expect(plan.pending).toEqual([])
  })

  test('díra na disku, neznámá verze v ledgeru i díra v ledgeru → nic se nespustí', async () => {
    const r = repo(35)
    const gap = { ...r, filenames: r.filenames.filter((f) => !f.startsWith('0034')) }
    expect((await failure(inspect({ client: new FakePg(upTo(33), 10), ...gap }))).message).toMatch(/chybí migrace 0034/)

    const unknown = new FakePg([...upTo(35), '0099'], 10)
    expect((await failure(inspect({ client: unknown, ...r }))).message).toMatch(/0099/)

    const hole = new FakePg(upTo(35).filter((v) => v !== '0030'), 10)
    expect((await failure(inspect({ client: hole, ...r }))).message).toMatch(/chybí 0030.*díra v ledgeru/)
  })

  test('nová migrace bez zápisu do ledgeru nebo s vlastním COMMIT neprojde už nanečisto', async () => {
    const noInsert = repo(35, { '0035_m35.sql': '-- file 0035\nCREATE TABLE t_x (id int);' })
    expect((await failure(inspect({ client: new FakePg(upTo(34), 10), ...noInsert }))).message).toMatch(
      /0035: soubor nezapisuje svůj řádek/,
    )
    const ownTx = repo(35, { '0035_m35.sql': `-- file 0035\nBEGIN;\n${own('0035')}\nCOMMIT;` })
    expect((await failure(inspect({ client: new FakePg(upTo(34), 10), ...ownTx }))).message).toMatch(/vlastní BEGIN/)
  })

  test('soubor s neplatným názvem se nepřeskočí potichu', async () => {
    const r = repo(3)
    const bad = { ...r, filenames: [...r.filenames, '0004_Nova-Vec.sql'] }
    expect((await failure(inspect({ client: new FakePg(null), ...bad }))).message).toMatch(/0004_Nova-Vec\.sql/)
  })

  test('cizí neprázdná databáze bez ledgeru se odmítne', async () => {
    const r = repo(3)
    expect((await failure(inspect({ client: new FakePg(null, 76), ...r }))).message).toMatch(/není databáze Cockpitu/)
  })
})

describe('aplikace', () => {
  test('doplní jen chybějící, každou ve vlastní transakci se zámkem a kontrolou ledgeru', async () => {
    const db = new FakePg(upTo(33), 40)
    const { applied, log } = await run(db, repo(35))
    expect(applied).toEqual(['0034', '0035'])
    expect(db.executedFiles).toEqual(['0034', '0035'])
    expect([...db.ledger!].sort()).toEqual(upTo(35))
    const writes = db.statements.filter((s) => ['BEGIN', 'COMMIT', MIGRATION_LOCK_SQL].includes(s))
    expect(writes).toEqual(['BEGIN', MIGRATION_LOCK_SQL, 'COMMIT', 'BEGIN', MIGRATION_LOCK_SQL, 'COMMIT'])
    expect(log.join('\n')).toContain('0035_m35.sql')
  })

  test('prázdný projekt: 0001–0025 bez ledgeru, 0026 ho založí, 0029/0030 doplní běhač', async () => {
    const db = new FakePg(null)
    const { applied } = await run(db, repo(35))
    expect(applied).toEqual(upTo(35))
    expect([...db.ledger!].sort()).toEqual(upTo(35))
  })

  test('chyba v souboru: transakce zpět, řádek souboru v hlášce, další se nezkouší, detail se nevypíše', async () => {
    const db = new FakePg(upTo(33), 40)
    const r = repo(36, { '0035_m35.sql': `-- file 0035\nALTER TABLE t_0001\n  FAIL;\n${own('0035')}` })
    const err = await failure(run(db, r))
    expect(err.message).toMatch(/Zastaveno na 0035/)
    expect(err.message).toMatch(/SQLSTATE 42601/)
    expect(err.message).toMatch(/řádek 3/)
    expect(err.message).toMatch(/vrátila zpět/)
    expect(err.message).toMatch(/Aplikované v tomto běhu: 0034/)
    expect(err.message).toMatch(/Nezkoušené: 0036/)
    expect(err.message).not.toContain('jan@firma.cz')
    expect(err.applied).toEqual(['0034'])
    expect(db.executedFiles).toEqual(['0034', '0035'])
    expect([...db.ledger!].sort()).toEqual(upTo(34))
  })

  test('soubor řádek do ledgeru reálně nezapsal → ROLLBACK, nic dalšího', async () => {
    const db = new FakePg(upTo(33), 40)
    db.swallowInsertFor = '0034'
    const err = await failure(run(db, repo(35)))
    expect(err.message).toMatch(/v schema_migration chybí 0034/)
    expect(db.statements).toContain('ROLLBACK')
    expect(db.executedFiles).toEqual(['0034'])
    expect([...db.ledger!].sort()).toEqual(upTo(33))
  })

  test('obsazený zámek (jiný běh) → nic se nespustí', async () => {
    const db = new FakePg(upTo(33), 40)
    db.lockFree = false
    const err = await failure(run(db, repo(35)))
    expect(err.message).toMatch(/Jiný běh právě migruje/)
    expect(db.executedFiles).toEqual([])
  })

  test('mezi plánem a aplikací ji aplikoval někdo jiný → vrátí se, nezdvojí', async () => {
    const db = new FakePg(upTo(33), 40)
    db.beforeBegin = (d) => {
      d.ledger!.add('0034')
      d.beforeBegin = null
    }
    const err = await failure(run(db, repo(35)))
    expect(err.message).toMatch(/Stav cíle se od plánu změnil/)
    expect(db.executedFiles).toEqual([])
  })

  test('produkce bez řádku 0029 (spuštěno ručně): řádek se doplní, soubor se nespustí, pak 0060', async () => {
    const db = new FakePg(upTo(59).filter((v) => v !== '0029'), 60)
    db.objects.add('0029')
    const r = repo(60)
    const plan = await inspect({ client: db, filenames: r.filenames, readSql: r.readSql })
    expect(plan.pending.map((f: { version: string }) => f.version)).toEqual(['0029', '0060'])
    expect([...plan.backfill]).toEqual(['0029'])
    expect(db.executedFiles).toEqual([])

    const log: string[] = []
    const applied = await applyPending({ client: db, ...plan, log: (l: string) => log.push(l) })
    expect(applied).toEqual(['0029', '0060'])
    expect(db.executedFiles).toEqual(['0060'])
    expect([...db.ledger!].sort()).toEqual(upTo(60))
    expect(log.join('\n')).toContain('jen doplnění řádku')
  })

  test('chybí i 0030 a oba objekty existují → doplní oba v pořadí', async () => {
    const db = new FakePg(upTo(59).filter((v) => v !== '0029' && v !== '0030'), 60)
    db.objects.add('0029').add('0030')
    const { applied } = await run(db, repo(59))
    expect(applied).toEqual(['0029', '0030'])
    expect(db.executedFiles).toEqual([])
    expect([...db.ledger!].sort()).toEqual(upTo(59))
  })

  test('chybí řádek 0029 a connector_state na cíli není → díra v ledgeru, nic se nespustí', async () => {
    const db = new FakePg(upTo(59).filter((v) => v !== '0029'), 60)
    const r = repo(60)
    const err = await failure(inspect({ client: db, filenames: r.filenames, readSql: r.readSql }))
    expect(err.message).toMatch(/chybí 0029.*díra v ledgeru/)
    expect(db.executedFiles).toEqual([])
  })

  test('objekt mezi plánem a aplikací zmizel → doplnění se vrátí, dál nic', async () => {
    const db = new FakePg(upTo(59).filter((v) => v !== '0029'), 60)
    db.objects.add('0029')
    const r = repo(60)
    const plan = await inspect({ client: db, filenames: r.filenames, readSql: r.readSql })
    db.objects.clear()
    const err = await failure(applyPending({ client: db, ...plan, log: () => {} }))
    expect(err.message).toMatch(/0029: na cíli není to, co/)
    expect(err.message).toMatch(/Nezkoušené: 0060/)
    expect(db.executedFiles).toEqual([])
    expect(db.ledger!.has('0029')).toBe(false)
  })

  test('řádek po COMMIT zmizel → chyba bez tvrzení, že se transakce vrátila', async () => {
    const db = new FakePg(upTo(34), 40)
    db.loseOnCommit = '0035'
    const err = await failure(run(db, repo(35)))
    expect(err.message).toMatch(/COMMIT proběhl/)
    expect(err.message).not.toMatch(/vrátila zpět/)
  })
})

// Repo jako v produkci: 0001–0075 a 0078–n (0076–0077 jsou záměrné mezery).
function repoWithGaps(n: number, overrides: Record<string, string> = {}) {
  const r = repo(n, overrides)
  return { ...r, filenames: r.filenames.filter((f) => !f.startsWith('0076_') && !f.startsWith('0077_')) }
}
const upToWithGaps = (n: number) => upTo(n).filter((v) => v !== '0076' && v !== '0077')

describe('záměrné mezery 0076–0077 v běhači', () => {
  test('nanečisto nad produkcí s mezerou projde a vypíše jen skutečně chybějící', async () => {
    const db = new FakePg(upToWithGaps(93), 90)
    const r = repoWithGaps(95)
    const plan = await inspect({ client: db, filenames: r.filenames, readSql: r.readSql })
    expect(plan.pending.map((f: { version: string }) => f.version)).toEqual(['0094', '0095'])
    expect(db.executedFiles).toEqual([])
  })

  test('aplikace přes mezeru doběhne a kontrola uvnitř transakce ji nepovažuje za změnu stavu', async () => {
    const db = new FakePg(upToWithGaps(93), 90)
    const { applied } = await run(db, repoWithGaps(95))
    expect(applied).toEqual(['0094', '0095'])
    expect([...db.ledger!].sort()).toEqual(upToWithGaps(95))
  })

  test('bez záměrných mezer (allowedGaps: []) by stejný stav odmítl — mezera je opravdu parametr', async () => {
    const db = new FakePg(upToWithGaps(93), 90)
    const r = repoWithGaps(95)
    const err = await failure(inspect({ client: db, filenames: r.filenames, readSql: r.readSql, allowedGaps: [] }))
    expect(err.message).toMatch(/chybí migrace 0076, 0077/)
  })

  test('jiná mezera na disku se odmítne i s mezerami 76–77', async () => {
    const r = repoWithGaps(95)
    const gap = { ...r, filenames: r.filenames.filter((f) => !f.startsWith('0090_')) }
    const db = new FakePg(upToWithGaps(89), 90)
    expect((await failure(inspect({ client: db, ...gap }))).message).toMatch(/chybí migrace 0090/)
  })

  test('skutečné soubory z repa: běhač je přijme nad produkcí bez 0095', async () => {
    const dir = join(__dirname, '..', 'supabase', 'migrations')
    const filenames = readdirSync(dir).filter((f) => f.endsWith('.sql'))
    const all = filenames.map((f) => f.slice(0, 4)).sort()
    const last = all.at(-1)!
    const db = new FakePg(all.slice(0, -1), 90)
    const plan = await inspect({
      client: db,
      filenames,
      readSql: async (f: string) => readFileSync(join(dir, f), 'utf8'),
    })
    expect(plan.pending.map((f: { version: string }) => f.version)).toEqual([last])
    expect(all).not.toContain('0076')
    expect(all).not.toContain('0077')
  })

  test('verze v evidenci, kterou repo nezná (aplikováno mimo repo) → nic se nespustí', async () => {
    const db = new FakePg([...upToWithGaps(95), '0096'], 90)
    const r = repoWithGaps(95)
    expect((await failure(inspect({ client: db, ...r }))).message).toMatch(/zná verzi 0096.*není soubor/)
  })
})

describe('baseline (zápis do evidence bez spuštění)', () => {
  // Ledger po ručním vložení 0090–0092 bez řádků; 0093 a dál soubory zapisují samy.
  const tablesSql = (v: string, table: string) =>
    `-- file ${v}\nCREATE TABLE IF NOT EXISTS ${table} (id int);\n${own(v)}`

  function setup(ledgerUpTo: number, repoTo = 93) {
    const db = new FakePg(upToWithGaps(ledgerUpTo), 90)
    const r = repoWithGaps(repoTo, {
      '0090_m90.sql': tablesSql('0090', 'tab_a'),
      '0091_m91.sql': tablesSql('0091', 'tab_b'),
      '0092_m92.sql': `-- file 0092\nALTER TABLE t_0001 ADD COLUMN x int;\n${own('0092')}`,
    })
    return { db, r }
  }

  test('nanečisto vypíše, co zapíše, a nic nemění ani nespouští', async () => {
    const { db, r } = setup(89)
    db.tables.add('tab_a').add('tab_b')
    const plan = await inspect({ client: db, filenames: r.filenames, readSql: r.readSql, baseline: ['0090', '0091', '0092'] })
    expect(plan.baseline).toBe(true)
    expect(plan.pending.map((f: { version: string }) => f.version)).toEqual(['0090', '0091', '0092'])
    expect(plan.remaining.map((f: { version: string }) => f.version)).toEqual(['0093'])
    expect(plan.unverified).toEqual(['0092'])
    expect(db.executedFiles).toEqual([])
    expect([...db.ledger!].sort()).toEqual(upToWithGaps(89))
  })

  test('zápis: jen řádky v evidenci, soubory se nespouštějí, každý ve vlastní transakci se zámkem', async () => {
    const { db, r } = setup(89)
    db.tables.add('tab_a').add('tab_b')
    const plan = await inspect({ client: db, filenames: r.filenames, readSql: r.readSql, baseline: ['0090', '0091', '0092'] })
    const log: string[] = []
    const done = await applyBaseline({ client: db, ...plan, log: (l: string) => log.push(l) })
    expect(done).toEqual(['0090', '0091', '0092'])
    expect(db.executedFiles).toEqual([])
    expect([...db.ledger!].sort()).toEqual(upToWithGaps(92))
    const tx = db.statements.filter((x) => ['BEGIN', 'COMMIT', MIGRATION_LOCK_SQL].includes(x))
    expect(tx).toEqual(['BEGIN', MIGRATION_LOCK_SQL, 'COMMIT', 'BEGIN', MIGRATION_LOCK_SQL, 'COMMIT', 'BEGIN', MIGRATION_LOCK_SQL, 'COMMIT'])
    expect(log.join('\n')).toContain('soubor se nespouští')
  })

  test('baseline může zaplnit díru pod nejvyšší aplikovanou verzí (0091 chybí, 0093 už je)', async () => {
    const { db, r } = setup(93)
    db.ledger!.delete('0091')
    db.tables.add('tab_b')
    // Bez baseline je to díra v ledgeru a běhač nespustí nic.
    expect((await failure(inspect({ client: db, filenames: r.filenames, readSql: r.readSql }))).message).toMatch(/chybí 0091/)
    const plan = await inspect({ client: db, filenames: r.filenames, readSql: r.readSql, baseline: ['0091'] })
    await applyBaseline({ client: db, ...plan, log: () => {} })
    expect([...db.ledger!].sort()).toEqual(upToWithGaps(93))
    expect(db.executedFiles).toEqual([])
  })

  test('tabulka, kterou soubor zakládá, na cíli chybí → nic se nezapíše', async () => {
    const { db, r } = setup(89)
    db.tables.add('tab_a') // tab_b chybí
    const err = await failure(inspect({ client: db, filenames: r.filenames, readSql: r.readSql, baseline: ['0090', '0091'] }))
    expect(err.message).toMatch(/0091: na cíli chybí tabulka tab_b/)
    expect([...db.ledger!].sort()).toEqual(upToWithGaps(89))
  })

  test('verze už v evidenci je, verze bez souboru v repu, baseline do prázdného projektu → odmítnuto', async () => {
    const { db, r } = setup(90)
    db.tables.add('tab_a').add('tab_b')
    expect((await failure(inspect({ client: db, filenames: r.filenames, readSql: r.readSql, baseline: ['0090'] }))).message).toMatch(
      /Baseline 0090: řádek už/,
    )
    expect((await failure(inspect({ client: db, filenames: r.filenames, readSql: r.readSql, baseline: ['0099'] }))).message).toMatch(
      /Baseline 0099: v repu k tomu není soubor/,
    )
    const fresh = new FakePg(null)
    expect((await failure(inspect({ client: fresh, filenames: r.filenames, readSql: r.readSql, baseline: ['0001'] }))).message).toMatch(
      /není tabulka schema_migration/,
    )
  })

  test('baseline by po zápisu nechal jinou díru → odmítnuto celé (ledger zná 0093, chybí 0091 i 0092)', async () => {
    const { db, r } = setup(93)
    db.ledger!.delete('0091')
    db.ledger!.delete('0092')
    db.tables.add('tab_b')
    const err = await failure(inspect({ client: db, filenames: r.filenames, readSql: r.readSql, baseline: ['0091'] }))
    expect(err.message).toMatch(/chybí 0092.*díra v ledgeru/)
  })

  test('nesouhlasí evidence s repem (0096 v evidenci, v repu není) → baseline se zastaví', async () => {
    const { db, r } = setup(89)
    db.ledger!.add('0096')
    db.tables.add('tab_a')
    const err = await failure(inspect({ client: db, filenames: r.filenames, readSql: r.readSql, baseline: ['0090'] }))
    expect(err.message).toMatch(/zná verzi 0096/)
  })

  test('objekt mezi plánem a zápisem zmizel → transakce zpět, evidence beze změny', async () => {
    const { db, r } = setup(89)
    db.tables.add('tab_a').add('tab_b')
    const plan = await inspect({ client: db, filenames: r.filenames, readSql: r.readSql, baseline: ['0090', '0091'] })
    db.tables.delete('tab_b')
    const err = await failure(applyBaseline({ client: db, ...plan, log: () => {} }))
    expect(err.message).toMatch(/Zastaveno na 0091.*chybí tabulka tab_b/)
    expect(db.ledger!.has('0090')).toBe(true)
    expect(db.ledger!.has('0091')).toBe(false)
  })

  test('souběžný zásah (řádek mezitím přibyl) → vrátí se, nezdvojí', async () => {
    const { db, r } = setup(89)
    db.tables.add('tab_a')
    const plan = await inspect({ client: db, filenames: r.filenames, readSql: r.readSql, baseline: ['0090'] })
    db.beforeBegin = (d) => {
      d.ledger!.add('0090')
      d.beforeBegin = null
    }
    const err = await failure(applyBaseline({ client: db, ...plan, log: () => {} }))
    expect(err.message).toMatch(/už v evidenci je/)
  })

  test('obsazený zámek → nic se nezapíše', async () => {
    const { db, r } = setup(89)
    db.tables.add('tab_a')
    const plan = await inspect({ client: db, filenames: r.filenames, readSql: r.readSql, baseline: ['0090'] })
    db.lockFree = false
    expect((await failure(applyBaseline({ client: db, ...plan, log: () => {} }))).message).toMatch(/Jiný běh právě migruje/)
    expect(db.ledger!.has('0090')).toBe(false)
  })
})
