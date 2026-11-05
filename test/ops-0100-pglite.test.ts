// 0100 proti CELÉMU řetězu skutečných migrací 0001–0100 (PGlite = PostgreSQL
// ve WASM, bez sítě): indexy cizích klíčů na klienta/obchod a denní kontrola
// úloh close_stale_job_runs (visící běh s vypršelým zámkem → failed; jen
// servisní role). Úvodní stub Supabase je stejný jako v
// test/bulk-import-fullchain-pglite.test.ts; migrace s Vaultem se přeskočí.
import { readdirSync, readFileSync } from 'node:fs'
import { beforeAll, describe, expect, test } from 'vitest'
import { API_ACCOUNT_COLUMNS, API_DEAL_COLUMNS } from '@/domain/crm/queries/apiV1'

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

const NEEDS_VAULT = new Set(['0031_encrypt_calendar_tokens.sql', '0032_drop_calendar_token_plaintext.sql'])
const M0100 = readdirSync('supabase/migrations').find((f) => f.startsWith('0100_'))!

const STUB = `
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text, raw_user_meta_data jsonb, raw_app_meta_data jsonb DEFAULT '{}', banned_until timestamptz, invited_at timestamptz);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('request.jwt.claim', true), ''),
                  nullif(current_setting('request.jwt.claims', true), ''))::jsonb $$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE SCHEMA storage;
CREATE TABLE storage.buckets (id text PRIMARY KEY, name text, public boolean DEFAULT false, file_size_limit bigint, allowed_mime_types text[]);
CREATE TABLE storage.objects (id uuid DEFAULT gen_random_uuid() PRIMARY KEY, bucket_id text, name text, owner uuid, metadata jsonb, created_at timestamptz DEFAULT now());
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql AS $$ SELECT string_to_array(name, '/') $$;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO authenticated, service_role, anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated, service_role, anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
`

describe.skipIf(!PGliteCtor)('0100 proti celému řetězu migrací (PGlite)', () => {
  let db: Db
  const files: string[] = []

  async function as<T = Row>(role: 'authenticated' | 'service_role', sql: string): Promise<T[]> {
    await db.query('BEGIN')
    try {
      await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role, aal: 'aal2' })])
      await db.query(`SET LOCAL ROLE ${role}`)
      const res = await db.query<T>(sql)
      await db.query('COMMIT')
      return res.rows
    } catch (e) {
      await db.query('ROLLBACK').catch(() => undefined)
      throw e
    }
  }
  const one = async <T = Row>(sql: string) => (await db.query<T>(sql)).rows[0]

  beforeAll(async () => {
    db = new PGliteCtor!()
    await db.exec(STUB)
    for (const f of readdirSync('supabase/migrations').filter((x) => x.endsWith('.sql')).sort()) {
      if (NEEDS_VAULT.has(f)) continue
      files.push(f)
      try {
        await db.exec(readFileSync(`supabase/migrations/${f}`, 'utf8'))
      } catch (e) {
        await db.exec('ROLLBACK').catch(() => undefined)
        throw new Error(`${f}: ${(e as Error).message}`)
      }
    }
  }, 300_000)

  test('řetěz obsahuje 0100 a 0100 je v ledgeru', async () => {
    expect(files).toContain(M0100)
    expect(await one(`SELECT version FROM schema_migration WHERE version = '0100'`)).toEqual({ version: '0100' })
  })

  test('indexy na account_id / deal_id existují (a nejsou částečné)', async () => {
    const rows = (await db.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = 'public' AND indexname = ANY($1)`,
      [['deal_account_id_idx', 'contact_account_id_idx', 'task_deal_id_idx', 'task_account_id_idx', 'engagement_account_id_idx']],
    )).rows
    expect(rows.map((r) => r.indexname).sort()).toEqual([
      'contact_account_id_idx', 'deal_account_id_idx', 'engagement_account_id_idx', 'task_account_id_idx', 'task_deal_id_idx',
    ])
    for (const r of rows) expect(r.indexdef).not.toMatch(/WHERE/)
  })

  test('migrace jde pustit znovu (idempotentní)', async () => {
    await db.exec(readFileSync(`supabase/migrations/${M0100}`, 'utf8'))
    expect(await one(`SELECT count(*)::int AS n FROM schema_migration WHERE version = '0100'`)).toEqual({ n: 1 })
  })

  test('close_stale_job_runs: uzavře jen běh s vypršelým zámkem (+ rezerva), ostatní nechá', async () => {
    const ids = (await db.query<{ id: number }>(`
      INSERT INTO job_run (job_name, status, locked_until, started_at) VALUES
        ('outlook-mail-sync', 'running', now() - interval '2 hours', now() - interval '2 hours'),
        ('ares-enrich', 'running', now() + interval '1 minute', now()),
        ('weekly-digest', 'running', now() - interval '1 minute', now() - interval '3 minutes')
      RETURNING id`)).rows.map((r) => r.id)
    const [closed] = await as<{ n: number }>('service_role', 'SELECT close_stale_job_runs(300) AS n')
    expect(closed.n).toBe(1)
    const rows = (await db.query<{ id: number; status: string; error: string | null; finished: boolean }>(
      `SELECT id, status, error, finished_at IS NOT NULL AS finished FROM job_run WHERE id = ANY($1) ORDER BY id`, [ids],
    )).rows
    expect(rows.map((r) => [r.status, r.finished])).toEqual([['failed', true], ['running', false], ['running', false]])
    expect(rows[0].error).toMatch(/^Běh nedoběhl/)
    // Bez rezervy se uzavře i běh, kterému zámek vypršel před minutou.
    expect((await as<{ n: number }>('service_role', 'SELECT close_stale_job_runs(0) AS n'))[0].n).toBe(1)
  })

  test('ověřovací SELECT z vložitelného bloku: ledger, 6 indexů, funkce jen pro service_role', async () => {
    const rows = (await db.query<{ co: string; hodnota: string }>(`
      SELECT 'ledger' AS co, version AS hodnota FROM schema_migration WHERE version = '0100'
      UNION ALL
      SELECT 'index', indexname FROM pg_indexes
       WHERE schemaname = 'public'
         AND indexname IN ('deal_account_id_idx', 'contact_account_id_idx', 'task_deal_id_idx', 'task_account_id_idx',
                           'engagement_account_id_idx', 'job_run_problem_idx')
      UNION ALL
      SELECT 'funkce', p.proname || ' authenticated=' || has_function_privilege('authenticated', p.oid, 'EXECUTE')::text
                       || ' service_role=' || has_function_privilege('service_role', p.oid, 'EXECUTE')::text
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = 'close_stale_job_runs'
      ORDER BY 1, 2`)).rows
    expect(rows.filter((r) => r.co === 'index')).toHaveLength(6)
    expect(rows).toContainEqual({ co: 'ledger', hodnota: '0100' })
    expect(rows).toContainEqual({ co: 'funkce', hodnota: 'close_stale_job_runs authenticated=false service_role=true' })
  })

  test('úzký výčet sloupců API (/api/v1, MCP) existuje ve schématu po celém řetězu', async () => {
    // Vnořené zdroje (owner:…, account:…) řeší PostgREST; tady jen holé sloupce.
    const plain = (cols: string) => cols.replace(/\w+:[^(]+\([^)]*\)/g, '').split(',').map((c) => c.trim()).filter(Boolean)
    await db.query(`SELECT ${plain(API_ACCOUNT_COLUMNS).join(', ')} FROM account LIMIT 0`)
    await db.query(`SELECT ${plain(API_DEAL_COLUMNS).join(', ')} FROM deal LIMIT 0`)
    await db.query('SELECT stage, amount_one_time, cogs_one_time, expected_mrr, estimate_md, status_blocker, pillar, phase FROM deal LIMIT 0')
  })

  test('close_stale_job_runs volá jen servisní role, ne přihlášený člověk', async () => {
    await expect(as('authenticated', 'SELECT close_stale_job_runs(300)')).rejects.toThrow(/permission denied/)
    await expect(as('service_role', 'SELECT close_stale_job_runs(-1)')).rejects.toThrow(/p_grace_seconds/)
  })
})
