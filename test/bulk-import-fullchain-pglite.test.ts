// Hromadný import zakázek proti CELÉMU řetězu skutečných migrací 0001–0098
// (PGlite = PostgreSQL ve WASM, bez sítě). Na rozdíl od
// test/bulk-import-0098-pglite.test.ts, který staví zjednodušené schéma, tady
// běží všechny triggery, RLS a omezení produkce najednou (0035, 0052, 0058,
// 0064, 0072, 0080, 0082, 0084, 0086, 0095 …): zakázka z importu musí projít
// všemi a vrácení importu nesmí narazit na žádné omezení.
// Supabase-specifické zůstává jen v úvodním stubu (role, auth, storage); dvě
// migrace potřebující Vault (0031, 0032; šifrování tokenů kalendáře) se
// přeskočí, k importu se nevztahují.
import { readdirSync, readFileSync } from 'node:fs'
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

const SALES = 'a1111111-1111-4111-8111-111111111111'
const OWNER = 'a2222222-2222-4222-8222-222222222222'
const PM = 'a3333333-3333-4333-8333-333333333333'
const NEEDS_VAULT = new Set(['0031_encrypt_calendar_tokens.sql', '0032_drop_calendar_token_plaintext.sql'])

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

function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    import_keys: [`row:${Math.random().toString(36).slice(2)}`],
    account_id: null,
    new_account: { name: 'Nová firma s.r.o.', ico: null, industry: null, region: null },
    title: 'Datová platforma', revenue_line: 'svatebni_hostina', revenue_category: 'one_time', pillar: 'cheesecaky', phase: 'realizovano',
    stage: 'vyhráno', probability_pct: 100, currency: 'CZK', amount: 580000, fx_rate: null, cogs: 100000, owner_id: OWNER,
    started_on: '2026-03-01', due_on: '2026-12-31', expected_close: null, invoiced: 300000, received: 100000,
    estimate_md: 20, scope: null, note: null, source_pdf_path: null, evidence_id: null,
    ...over,
  }
}

describe.skipIf(!PGliteCtor)('0098 proti celému řetězu migrací (PGlite)', () => {
  let db: Db
  const skipped: string[] = []

  async function as<T = Row>(
    who: { role: 'authenticated' | 'service_role'; sub?: string; headers?: Record<string, string> },
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    await db.query('BEGIN')
    try {
      await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ role: who.role, aal: 'aal2', ...(who.sub ? { sub: who.sub } : {}) }),
      ])
      if (who.headers) await db.query(`SELECT set_config('request.headers', $1, true)`, [JSON.stringify(who.headers)])
      await db.query(`SET LOCAL ROLE ${who.role}`)
      const res = await db.query<T>(sql, params)
      await db.query('COMMIT')
      return res.rows
    } catch (e) {
      await db.query('ROLLBACK').catch(() => undefined)
      throw e
    }
  }
  const one = async <T = Row>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0]
  const count = async (table: string, where = 'true') => (await one<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`)).n
  const svc = <T = Row>(actor: string, sql: string, params: unknown[] = []) =>
    as<T>({ role: 'service_role', headers: { 'x-cockpit-audit-actor': `user:${actor}` } }, sql, params)
  const openBatch = async () => (await svc<{ id: number }>(SALES, `SELECT import_open_batch($1::uuid, 'csv', 'test') AS id`, [SALES]))[0].id
  const apply = async (batch: number, r: Record<string, unknown>) =>
    (await svc<{ r: Record<string, number | string | boolean | null> }>(SALES, `SELECT import_apply_row($1::uuid, $2::bigint, $3::jsonb) AS r`, [SALES, batch, JSON.stringify(r)]))[0].r
  const revert = async (batch: number) =>
    (await svc<{ r: Record<string, unknown> }>(SALES, `SELECT import_revert_batch($1::uuid, $2::bigint) AS r`, [SALES, batch]))[0].r

  beforeAll(async () => {
    db = new PGliteCtor!()
    await db.exec(STUB)
    for (const f of readdirSync('supabase/migrations').filter((x) => x.endsWith('.sql')).sort()) {
      if (NEEDS_VAULT.has(f)) { skipped.push(f); continue }
      try {
        await db.exec(readFileSync(`supabase/migrations/${f}`, 'utf8'))
      } catch (e) {
        await db.exec('ROLLBACK').catch(() => undefined)
        throw new Error(`${f}: ${(e as Error).message}`)
      }
    }
    for (const [id, email, role] of [[SALES, 'sales@mummiesdaddies.com', 'obchodnik'], [OWNER, 'owner@mummiesdaddies.com', 'projektak'], [PM, 'pm@mummiesdaddies.com', 'projektak']]) {
      await db.query(`INSERT INTO auth.users (id, email, raw_user_meta_data, invited_at) VALUES ($1, $2, '{}', now())`, [id, email])
      await db.query(`UPDATE team_member SET role = $2::team_role WHERE id = $1`, [id, role])
    }
  }, 300_000)

  test('řetěz 0001–0098 se aplikuje a 0098 je v ledgeru', async () => {
    expect(skipped).toEqual([...NEEDS_VAULT])
    expect(await count('schema_migration', "version = '0098'")).toBe(1)
  })

  let batch = 0
  let won: Record<string, number | string | boolean | null>

  test('vyhraná zakázka projde všemi triggery produkce: obchod, přijatá verze, dodávka, finance', async () => {
    batch = await openBatch()
    won = await apply(batch, row({ import_keys: ['row:full-1'] }))
    expect(won).toMatchObject({ status: 'created', account_created: true, records: 3 })
    const d = await one<Row>(`SELECT stage::text AS stage, forecast_category, import_batch_id, owner_id, amount_one_time::float8 AS amount, won_at::text AS won FROM deal WHERE id = ${won.deal_id}`)
    expect(d).toEqual({ stage: 'vyhráno', forecast_category: 'closed', import_batch_id: batch, owner_id: OWNER, amount: 580000, won: '2026-03-01' })
    expect(await one(`SELECT status FROM deal_scope_version WHERE deal_id = ${won.deal_id}`)).toEqual({ status: 'accepted' })
    const e = await one<Row>(`SELECT origin, owner_id, started_on::text AS started, due_on::text AS due FROM engagement WHERE deal_id = ${won.deal_id}`)
    expect(e).toEqual({ origin: 'auto_deal_won', owner_id: OWNER, started: '2026-03-01', due: '2026-12-31' })
    expect(await count('engagement_milestone', `engagement_id = ${won.engagement_id}`)).toBeGreaterThan(0)
  })

  test('historická zakázka nemá falešný úkol ani aktivitu; běžná výhra ano', async () => {
    expect(await count('task', `deal_id = ${won.deal_id}`)).toBe(0)
    expect(await count('sales_activity', `deal_id = ${won.deal_id}`)).toBe(0)
    const acc = (await one<{ id: number }>(`INSERT INTO account (name) VALUES ('Běžný klient') RETURNING id`)).id
    const d = (await one<{ id: number }>(`INSERT INTO deal (account_id, title, revenue_line, revenue_category, owner_id) VALUES (${acc}, 'Ruční', 'svatebni_hostina', 'one_time', '${SALES}') RETURNING id`)).id
    await as({ role: 'authenticated', sub: SALES }, `UPDATE deal SET stage = 'vyhráno' WHERE id = ${d}`)
    expect(await count('task', `deal_id = ${d} AND title = 'Naplánovat realizaci akce'`)).toBe(1)
  })

  test('finanční záznamy: zdroj import, jen Nasmlouváno potvrzeno; obchodní role je vidí, projekťák ne', async () => {
    const f = await as<Row>({ role: 'authenticated', sub: SALES }, `SELECT kind, status, source FROM financial_record WHERE deal_id = ${won.deal_id} ORDER BY kind`)
    expect(f).toEqual([
      { kind: 'contracted', status: 'confirmed', source: 'import' },
      { kind: 'invoiced', status: 'draft', source: 'import' },
      { kind: 'received', status: 'draft', source: 'import' },
    ])
    expect(await as({ role: 'authenticated', sub: PM }, `SELECT id FROM financial_record WHERE deal_id = ${won.deal_id}`)).toHaveLength(0)
    expect(await as({ role: 'authenticated', sub: SALES }, `SELECT id FROM import_batch WHERE id = ${batch}`)).toHaveLength(1)
    expect(await as({ role: 'authenticated', sub: PM }, `SELECT id FROM import_batch WHERE id = ${batch}`)).toHaveLength(0)
  })

  test('audit: aktér je člověk z hlavičky, události importu jsou v audit_event', async () => {
    const ev = await one<Row>(`SELECT actor_type, actor_id, info_state FROM audit_event WHERE action = 'deal.bulk_imported' AND entity_id = ${won.deal_id}`)
    expect(ev).toEqual({ actor_type: 'user', actor_id: SALES, info_state: 'human_confirmed' })
    const rows = await as<Row>({ role: 'authenticated', sub: SALES }, `SELECT DISTINCT actor_id FROM audit_event WHERE entity_table = 'engagement' AND entity_id = ${won.engagement_id}`)
    expect(rows).toEqual([{ actor_id: SALES }])
  })

  test('stejný klíč podruhé = duplicita, ne druhá zakázka', async () => {
    expect(await apply(batch, row({ import_keys: ['row:full-1'] }))).toMatchObject({ status: 'duplicate', deal_id: won.deal_id })
    expect(await count('deal', "title = 'Datová platforma' AND import_batch_id IS NOT NULL")).toBe(1)
  })

  test('nabídka odeslána a rozjednáno projdou (Rozsah/nabídka a Upřesnění bez dodávky)', async () => {
    const sent = await apply(batch, row({ import_keys: ['row:full-sent'], title: 'Nabídka', stage: 'rozsah_nabidka', probability_pct: 55, invoiced: null, received: null }))
    const draft = await apply(batch, row({ import_keys: ['row:full-draft'], title: 'Jednání', stage: 'diagnostika', probability_pct: 30, amount: 0, invoiced: null, received: null }))
    expect(await one(`SELECT stage::text AS s FROM deal WHERE id = ${sent.deal_id}`)).toEqual({ s: 'rozsah_nabidka' })
    expect(await one(`SELECT stage::text AS s FROM deal WHERE id = ${draft.deal_id}`)).toEqual({ s: 'diagnostika' })
    expect(await count('engagement', `deal_id IN (${sent.deal_id}, ${draft.deal_id})`)).toBe(0)
  })

  test('vrácení dávky: čistá dávka zmizí celá, včetně nového klienta; zakázka s prací zůstane', async () => {
    const b = await openBatch()
    const clean = await apply(b, row({ import_keys: ['row:full-c'], title: 'Čistá', new_account: { name: 'Čistý klient', ico: null } }))
    const worked = await apply(b, row({ import_keys: ['row:full-w'], title: 'Rozpracovaná', new_account: { name: 'Klient s prací', ico: null } }))
    await as({ role: 'authenticated', sub: SALES }, `INSERT INTO task (title, deal_id, account_id) VALUES ('Zavolat', ${worked.deal_id}, ${worked.account_id})`)
    const res = await revert(b) as { deals_reverted: number; deals_kept: { deal_id: number; reason: string }[]; accounts_deleted: number; status: string }
    expect(res).toMatchObject({ deals_reverted: 1, accounts_deleted: 1, status: 'partial' })
    expect(res.deals_kept).toEqual([{ deal_id: worked.deal_id, reason: 'linked_work' }])
    expect(await count('deal', `id = ${clean.deal_id}`)).toBe(0)
    expect(await count('account', `id = ${clean.account_id}`)).toBe(0)
    expect(await count('deal', `id = ${worked.deal_id}`)).toBe(1)
    expect(await count('account', `id = ${worked.account_id}`)).toBe(1)
  })

  test('celou první dávku jde vrátit a nezůstane po ní nic', async () => {
    const res = await revert(batch) as { status: string; deals_reverted: number }
    expect(res).toMatchObject({ status: 'reverted', deals_reverted: 3 })
    expect(await count('deal', `import_batch_id = ${batch}`)).toBe(0)
    expect(await count('financial_record', "source = 'import' AND deal_id IS NOT NULL AND deal_id = " + won.deal_id)).toBe(0)
    expect(await count('engagement', `id = ${won.engagement_id}`)).toBe(0)
  })
})
