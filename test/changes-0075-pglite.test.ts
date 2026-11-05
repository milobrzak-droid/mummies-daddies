// 0075 v opravdovém Postgresu (PGlite = PostgreSQL ve WASM), bez sítě a bez
// živé DB. PGlite je v devDependencies, v bráně (build:release) i v CI běží;
// kdyby chyběl, červeně selže test/pglite-dependency.test.ts.
// (Statické kontroly téže migrace běží také,
// viz test/changes-0075.test.ts). Ověřuje hlavně pravidlo návštěvy v RPC
// touch_changes_view() a to, že klient nemůže zapsat čas za jiného člověka.
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, test } from 'vitest'

type Row = Record<string, unknown>
type Db = {
  exec: (sql: string) => Promise<unknown>
  query: <T = Row>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>
}

const PGLITE_MODULE = '@electric-sql/pglite'
let PGliteCtor: (new () => Db) | null = null
try {
  const mod = (await import(/* @vite-ignore */ PGLITE_MODULE)) as { PGlite: new () => Db }
  PGliteCtor = mod.PGlite
} catch {
  PGliteCtor = null
}

const MIG = readFileSync('supabase/migrations/0075_changes_view.sql', 'utf8')
const U1 = '11111111-1111-4111-8111-111111111111'
const U2 = '22222222-2222-4222-8222-222222222222'
const STRANGER = '99999999-9999-4999-8999-999999999999'

const SCHEMA = `
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid $$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claims', true), '')::jsonb $$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
-- Supabase dává novým tabulkám v public plná práva; migrace je má omezit sama.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
CREATE TABLE schema_migration (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now(), note text);
CREATE TABLE team_member (id uuid PRIMARY KEY, full_name text);
INSERT INTO team_member VALUES ('${U1}', 'A'), ('${U2}', 'B');
CREATE FUNCTION is_team_member() RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM team_member WHERE id = auth.uid()) $$;
`

describe.skipIf(!PGliteCtor)('0075 changes_view v Postgresu (PGlite)', () => {
  let db: Db

  async function as(sub: string | null, aal: string, sql: string) {
    const claims = JSON.stringify({ role: 'authenticated', aal, ...(sub ? { sub } : {}) })
    try {
      await db.exec(`BEGIN;\nSELECT set_config('request.jwt.claims', '${claims}', true);\nSET LOCAL ROLE authenticated;\n${sql}\nCOMMIT;`)
    } catch (e) {
      await db.exec('ROLLBACK').catch(() => undefined)
      throw e
    }
  }
  async function touch(sub: string, aal = 'aal2') {
    const claims = JSON.stringify({ role: 'authenticated', aal, sub })
    await db.exec(`BEGIN;\nSELECT set_config('request.jwt.claims', '${claims}', true);\nSET LOCAL ROLE authenticated;`)
    try {
      return (await db.query<{ seen_baseline: string | null; seen_last_open: string }>('SELECT * FROM touch_changes_view()')).rows[0]
    } finally {
      await db.exec('COMMIT')
    }
  }
  const row = async (id: string) =>
    (await db.query<{ baseline_at: string | null; last_open_at: string }>('SELECT baseline_at, last_open_at FROM changes_view WHERE member_id = $1', [id])).rows[0]
  const setOpen = (id: string, baseline: string | null, lastOpen: string) =>
    db.exec(`UPDATE changes_view SET baseline_at = ${baseline ? `'${baseline}'` : 'NULL'}, last_open_at = '${lastOpen}' WHERE member_id = '${id}'`)

  beforeAll(async () => {
    db = new PGliteCtor!()
    await db.exec(SCHEMA)
    await db.exec(MIG)
    await db.exec(MIG) // idempotence
    await db.exec('GRANT USAGE ON SCHEMA public TO authenticated')
  }, 60_000)

  test('ledger nese 0075 právě jednou', async () => {
    expect((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM schema_migration WHERE version = '0075'`)).rows[0].n).toBe(1)
  })

  test('první otevření: baseline je NULL (první návštěva), last_open je teď', async () => {
    const r = await touch(U1)
    expect(r.seen_baseline).toBeNull()
    expect(r.seen_last_open).toBeTruthy()
    expect((await row(U1)).baseline_at).toBeNull()
  })

  test('další otevření uvnitř návštěvy baseline nemění (F5 nevyprázdní seznam)', async () => {
    await setOpen(U1, '2026-09-20 08:00+00', new Date(Date.now() - 30 * 60_000).toISOString())
    const r = await touch(U1)
    expect(new Date(r.seen_baseline!).toISOString()).toBe('2026-09-20T08:00:00.000Z')
  })

  test('po pauze delší než 240 minut se baseline posune na předchozí otevření', async () => {
    const previous = new Date(Date.now() - 300 * 60_000).toISOString()
    await setOpen(U1, '2026-09-20 08:00+00', previous)
    const r = await touch(U1)
    expect(new Date(r.seen_baseline!).toISOString()).toBe(previous)
    expect(new Date(r.seen_last_open).getTime()).toBeGreaterThan(new Date(previous).getTime())
  })

  test('pauza těsně pod hranicí je pořád jedna návštěva', async () => {
    await setOpen(U1, '2026-09-20 08:00+00', new Date(Date.now() - 239 * 60_000).toISOString())
    expect(new Date((await touch(U1)).seen_baseline!).toISOString()).toBe('2026-09-20T08:00:00.000Z')
  })

  test('každý si zapisuje jen svůj řádek', async () => {
    await touch(U2)
    expect((await db.query<{ n: number }>('SELECT count(*)::int AS n FROM changes_view')).rows[0].n).toBe(2)
    expect((await row(U2)).baseline_at).toBeNull()
  })

  test('bez AAL2, bez přihlášení a jako cizí (ne člen týmu) RPC odmítne', async () => {
    await expect(touch(U1, 'aal1')).rejects.toThrow(/AAL2/)
    await expect(touch(STRANGER)).rejects.toThrow(/člen týmu/)
    await expect(as(null, 'aal2', 'SELECT * FROM touch_changes_view();')).rejects.toThrow(/přihlášený/)
  })

  test('klient nemůže zapisovat přímo (INSERT/UPDATE/DELETE) ani měnit cizí čas', async () => {
    await expect(as(U1, 'aal2', `INSERT INTO changes_view (member_id) VALUES ('${U2}');`)).rejects.toThrow(/permission denied/)
    await expect(as(U1, 'aal2', `UPDATE changes_view SET last_open_at = now() WHERE member_id = '${U2}';`)).rejects.toThrow(/permission denied/)
    await expect(as(U1, 'aal2', 'DELETE FROM changes_view;')).rejects.toThrow(/permission denied/)
  })

  test('čtení: každý vidí jen svůj řádek a bez AAL2 nic', async () => {
    await db.exec('BEGIN;')
    await db.exec(`SELECT set_config('request.jwt.claims', '${JSON.stringify({ role: 'authenticated', aal: 'aal2', sub: U1 })}', true); SET LOCAL ROLE authenticated;`)
    const own = (await db.query<{ member_id: string }>('SELECT member_id FROM changes_view')).rows
    await db.exec('COMMIT;')
    expect(own.map((r) => r.member_id)).toEqual([U1])

    await db.exec('BEGIN;')
    await db.exec(`SELECT set_config('request.jwt.claims', '${JSON.stringify({ role: 'authenticated', aal: 'aal1', sub: U1 })}', true); SET LOCAL ROLE authenticated;`)
    const none = (await db.query('SELECT * FROM changes_view')).rows
    await db.exec('COMMIT;')
    expect(none).toEqual([])
  })

  test('odchod člena týmu smaže jeho řádek', async () => {
    await db.exec(`DELETE FROM team_member WHERE id = '${U2}'`)
    expect(await row(U2)).toBeUndefined()
  })
})
