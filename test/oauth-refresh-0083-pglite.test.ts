// 0083 v opravdovém Postgresu (PGlite = PostgreSQL ve WASM), bez sítě a bez
// živé DB. PGlite je v devDependencies, v bráně (build:release) i v CI běží;
// kdyby chyběl, červeně selže test/pglite-dependency.test.ts.
// Ověřuje idempotenci,
// omezení sloupců, kaskády a hlavně to, že klientské role (anon,
// authenticated) k refresh tokenům nemají přístup, jen service_role.
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

const MIG = readFileSync('supabase/migrations/0083_oauth_refresh_token.sql', 'utf8')
const U1 = '11111111-1111-4111-8111-111111111111'
const FAM = '33333333-3333-4333-8333-333333333333'

const SCHEMA = `
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
-- Supabase dává novým tabulkám v public plná práva; migrace je má omezit sama.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
CREATE TABLE schema_migration (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now(), note text);
CREATE TABLE team_member (id uuid PRIMARY KEY, full_name text);
INSERT INTO team_member VALUES ('${U1}', 'A');
CREATE TABLE api_key (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, name text, scope text NOT NULL DEFAULT 'full');
CREATE TABLE oauth_client (client_id text PRIMARY KEY, client_name text, redirect_uris text[] NOT NULL);
CREATE TABLE oauth_code (
  code text PRIMARY KEY,
  client_id text NOT NULL REFERENCES oauth_client(client_id) ON DELETE CASCADE,
  redirect_uri text NOT NULL, code_challenge text NOT NULL, expires_at timestamptz NOT NULL
);
INSERT INTO oauth_client VALUES ('c1', 'Claude', ARRAY['https://claude.ai/cb']);
INSERT INTO oauth_code VALUES ('old', 'c1', 'https://claude.ai/cb', 'ch', now());
`

describe.skipIf(!PGliteCtor)('0083 oauth_refresh_token v Postgresu (PGlite)', () => {
  let db: Db
  const asRole = async (role: string, sql: string) => {
    await db.exec(`BEGIN; SET LOCAL ROLE ${role};`)
    try {
      return await db.exec(sql)
    } finally {
      await db.exec('ROLLBACK')
    }
  }
  const insert = (hash: string, extra = '') =>
    `INSERT INTO oauth_refresh_token (token_hash, family_id, client_id, approved_by, expires_at${extra ? ', ' + extra.split('=')[0] : ''})
     VALUES ('${hash}', '${FAM}', 'c1', '${U1}', now() + interval '180 days'${extra ? ', ' + extra.split('=')[1] : ''})`

  beforeAll(async () => {
    db = new PGliteCtor!()
    await db.exec(SCHEMA)
    await db.exec(MIG)
    await db.exec(MIG) // idempotence
  }, 60_000)

  test('ledger nese 0083 právě jednou', async () => {
    expect((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM schema_migration WHERE version = '0083'`)).rows[0].n).toBe(1)
  })

  test('stávající kód dostane scope read, neplatný scope CHECK odmítne', async () => {
    expect((await db.query<{ scope: string }>(`SELECT scope FROM oauth_code WHERE code = 'old'`)).rows[0].scope).toBe('read')
    await expect(db.exec(`UPDATE oauth_code SET scope = 'admin'`)).rejects.toThrow()
    await db.exec(`UPDATE oauth_code SET scope = 'full' WHERE code = 'old'`)
  })

  test('refresh token: výchozí scope read, scope CHECK, unikátní hash', async () => {
    await db.exec(insert('h1'))
    expect((await db.query<{ scope: string; used_at: unknown }>(`SELECT scope, used_at FROM oauth_refresh_token WHERE token_hash = 'h1'`)).rows[0]).toEqual({ scope: 'read', used_at: null })
    await expect(db.exec(insert('h1'))).rejects.toThrow(/unique|duplicate/i)
    await expect(db.exec(insert('h2', `scope='admin'`))).rejects.toThrow()
    await db.exec(insert('h3', `scope='full'`))
  })

  test('anon a authenticated nemají k tabulce přístup, service_role ano', async () => {
    for (const role of ['anon', 'authenticated']) {
      await expect(asRole(role, 'SELECT * FROM oauth_refresh_token')).rejects.toThrow(/permission denied/i)
      await expect(asRole(role, insert('hx'))).rejects.toThrow(/permission denied/i)
    }
    await asRole('service_role', `${insert('hs')}; SELECT * FROM oauth_refresh_token; UPDATE oauth_refresh_token SET used_at = now()`)
  })

  test('RLS je zapnuté a bez politik', async () => {
    expect((await db.query<{ relrowsecurity: boolean }>(`SELECT relrowsecurity FROM pg_class WHERE relname = 'oauth_refresh_token'`)).rows[0].relrowsecurity).toBe(true)
    expect((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_policies WHERE tablename = 'oauth_refresh_token'`)).rows[0].n).toBe(0)
  })

  test('kaskády: smazání klienta nebo člena smaže refresh tokeny; smazání klíče jen vynuluje odkaz', async () => {
    await db.exec(`INSERT INTO api_key (name) VALUES ('k')`)
    const keyId = (await db.query<{ id: number }>(`SELECT id FROM api_key LIMIT 1`)).rows[0].id
    await db.exec(`UPDATE oauth_refresh_token SET api_key_id = ${keyId} WHERE token_hash = 'h1'`)
    await db.exec(`DELETE FROM api_key WHERE id = ${keyId}`)
    expect((await db.query<{ api_key_id: unknown }>(`SELECT api_key_id FROM oauth_refresh_token WHERE token_hash = 'h1'`)).rows[0].api_key_id).toBeNull()

    await db.exec(`DELETE FROM team_member WHERE id = '${U1}'`)
    expect((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM oauth_refresh_token`)).rows[0].n).toBe(0)

    await db.exec(`INSERT INTO team_member VALUES ('${U1}', 'A')`)
    await db.exec(insert('h9'))
    await db.exec(`DELETE FROM oauth_client WHERE client_id = 'c1'`)
    expect((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM oauth_refresh_token`)).rows[0].n).toBe(0)
  })

  test('guard: bez api_key.scope migrace skončí česky srozumitelnou chybou', async () => {
    const bare = new PGliteCtor!()
    await bare.exec(SCHEMA.replace(`, scope text NOT NULL DEFAULT 'full'`, ''))
    await expect(bare.exec(MIG)).rejects.toThrow(/0043_api_key_scope/)
  })
})
