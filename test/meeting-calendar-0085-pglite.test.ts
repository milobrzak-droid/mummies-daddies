// 0085 v opravdovém Postgresu (PGlite = PostgreSQL ve WASM), bez sítě a bez
// živé DB. PGlite NENÍ závislost projektu: bez `npm i -D @electric-sql/pglite`
// se celý soubor přeskočí (statické kontroly téže migrace běží vždy, viz
// test/meeting-calendar-migration.test.ts). Ověřuje idempotenci a strážce
// původu termínu milníku: přihlášený člověk vazbu „termín převzatý ze
// schůzky" nenastaví a změnou termínu ji zruší; server (bez auth.uid()) smí.
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

const MIG = readFileSync('supabase/migrations/0085_meeting_calendar_sync.sql', 'utf8')
const USER = '11111111-1111-4111-8111-111111111111'

// Jen to, na čem 0085 stojí (0020, 0022, 0042, 0026) — ve zkrácené podobě.
const SCHEMA = `
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid $$;
CREATE TABLE schema_migration (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now(), note text);
CREATE TYPE sales_activity_outcome AS ENUM ('completed', 'no_answer', 'follow_up', 'cancelled', 'planned');
CREATE TABLE engagement (id bigserial PRIMARY KEY);
CREATE TABLE sales_activity (
  id bigserial PRIMARY KEY, account_id bigint, kind text NOT NULL DEFAULT 'meeting',
  outcome sales_activity_outcome NOT NULL DEFAULT 'completed', subject text NOT NULL DEFAULT 's',
  occurred_at timestamptz NOT NULL DEFAULT now(), created_by uuid, ms_event_id text
);
CREATE TABLE engagement_milestone (
  id bigserial PRIMARY KEY, engagement_id bigint NOT NULL REFERENCES engagement(id) ON DELETE CASCADE,
  title text NOT NULL, status text NOT NULL DEFAULT 'pripraveno', due_on date
);
INSERT INTO engagement DEFAULT VALUES;
INSERT INTO sales_activity (outcome, ms_event_id) VALUES ('planned', 'ev-1'), ('planned', 'ev-2');
INSERT INTO engagement_milestone (engagement_id, title, due_on) VALUES (1, 'Workshop', NULL), (1, 'Procesní mapa', '2026-10-05');
`

describe.skipIf(!PGliteCtor)('0085 v Postgresu (PGlite)', () => {
  let db: Db

  /** Jako přihlášený člověk (auth.uid() = USER). */
  async function asUser(sql: string) {
    const claims = JSON.stringify({ role: 'authenticated', aal: 'aal2', sub: USER })
    try {
      await db.exec(`BEGIN;\nSELECT set_config('request.jwt.claims', '${claims}', true);\n${sql};\nCOMMIT;`)
    } catch (e) {
      await db.exec('ROLLBACK').catch(() => undefined)
      throw e
    }
  }
  const milestone = async (id: number) =>
    (await db.query<{ due_on: string | null; due_from_activity_id: number | null }>(
      "SELECT to_char(due_on, 'YYYY-MM-DD') AS due_on, due_from_activity_id FROM engagement_milestone WHERE id = $1", [id])).rows[0]

  beforeAll(async () => {
    db = new PGliteCtor!()
    await db.exec(SCHEMA)
    await db.exec(MIG)
    await db.exec(MIG) // idempotence
  }, 60_000)

  test('ledger nese 0085 právě jednou, sloupce a CHECK existují jednou', async () => {
    expect((await db.query("SELECT count(*)::int AS n FROM schema_migration WHERE version = '0085'")).rows[0]).toEqual({ n: 1 })
    const cols = (await db.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE column_name IN ('milestone_id', 'note_received_at', 'due_from_activity_id') ORDER BY 1, 2`)).rows
    expect(cols).toEqual([
      { table_name: 'engagement_milestone', column_name: 'due_from_activity_id' },
      { table_name: 'sales_activity', column_name: 'milestone_id' },
      { table_name: 'sales_activity', column_name: 'note_received_at' },
    ])
    expect((await db.query("SELECT count(*)::int AS n FROM pg_constraint WHERE conname = 'engagement_milestone_due_from_activity_check'")).rows[0]).toEqual({ n: 1 })
  })

  test('server (bez auth.uid()) nastaví převzatý termín; CHECK: převzatý termín musí existovat', async () => {
    await db.exec("UPDATE engagement_milestone SET due_on = '2026-10-01', due_from_activity_id = 1 WHERE id = 1")
    expect(await milestone(1)).toEqual({ due_on: '2026-10-01', due_from_activity_id: 1 })
    // Posun serverem (kontrola kalendáře) vazbu nechá.
    await db.exec("UPDATE engagement_milestone SET due_on = '2026-10-03' WHERE id = 1 AND due_from_activity_id = 1")
    expect(await milestone(1)).toEqual({ due_on: '2026-10-03', due_from_activity_id: 1 })
    await expect(db.exec('UPDATE engagement_milestone SET due_on = NULL WHERE id = 1')).rejects.toThrow(/due_from_activity_check|check constraint/)
  })

  test('přihlášený člověk vazbu nenastaví (INSERT ani UPDATE)', async () => {
    await expect(asUser("INSERT INTO engagement_milestone (engagement_id, title, due_on, due_from_activity_id) VALUES (1, 'X', '2026-10-01', 2)"))
      .rejects.toThrow(/nastavuje jen Cockpit/)
    await expect(asUser('UPDATE engagement_milestone SET due_from_activity_id = 2 WHERE id = 2')).rejects.toThrow(/nastavuje jen Cockpit/)
    expect(await milestone(2)).toEqual({ due_on: '2026-10-05', due_from_activity_id: null })
  })

  test('člověk změní termín → už není převzatý ze schůzky; změna stavu vazbu nechá', async () => {
    await asUser("UPDATE engagement_milestone SET status = 'v_praci' WHERE id = 1")
    expect((await milestone(1)).due_from_activity_id).toBe(1)
    await asUser("UPDATE engagement_milestone SET due_on = '2026-10-10' WHERE id = 1")
    expect(await milestone(1)).toEqual({ due_on: '2026-10-10', due_from_activity_id: null })
    // Zrušit vazbu člověk smí.
    await db.exec('UPDATE engagement_milestone SET due_from_activity_id = 2 WHERE id = 1')
    await asUser('UPDATE engagement_milestone SET due_from_activity_id = NULL WHERE id = 1')
    expect((await milestone(1)).due_from_activity_id).toBeNull()
  })

  test('smazání schůzky vazbu vynuluje (ON DELETE SET NULL)', async () => {
    await db.exec('UPDATE engagement_milestone SET due_from_activity_id = 2 WHERE id = 2')
    await db.exec('UPDATE sales_activity SET milestone_id = 2 WHERE id = 2')
    await db.exec('DELETE FROM sales_activity WHERE id = 2')
    expect((await milestone(2)).due_from_activity_id).toBeNull()
    await db.exec('DELETE FROM engagement_milestone WHERE id = 2')
    expect((await db.query('SELECT count(*)::int AS n FROM sales_activity WHERE milestone_id IS NOT NULL')).rows[0]).toEqual({ n: 0 })
  })
})
