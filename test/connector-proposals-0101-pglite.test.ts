// 0101 + návrhy zakázek z konektoru proti CELÉMU řetězu migrací 0001–0101
// (PGlite, bez sítě): řádek fronty mail_content_intake přesně v tvaru, který
// zapisuje domain/crm/connectorProposalService.ts (source mcp_connector,
// wait_reason offer_draft), projde všemi CHECKy; schválení (obchod + uzavření
// řádku) i zamítnutí s důvodem (decision_note z 0101) taky; RLS pustí návrh jen
// obchodní roli. Migrace je idempotentní (druhé spuštění projde).
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

describe.skipIf(!PGliteCtor)('0101 návrhy z konektoru proti celému řetězu migrací (PGlite)', () => {
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
  const svc = <T = Row>(actor: string, sql: string, params: unknown[] = []) =>
    as<T>({ role: 'service_role', headers: { 'x-cockpit-audit-actor': actor } }, sql, params)

  const DRAFT = { version: 1, kind: 'connector_deal', info_state: 'ai_suggestion', mode: 'create', fields: { title: 'Školení' } }
  let evidence = 0
  let account = 0
  const proposal = async (key: string) => (await svc<{ id: number }>(`api_key:${SALES}`, `
    INSERT INTO mail_content_intake (source, status, wait_reason, dedupe_key, evidence_id, received_at, subject, excerpt,
      attachment_names, signals, account_id, created_by, offer_proposal_id, offer_draft, offer_pdf_sha256)
    VALUES ('mcp_connector', 'queued', 'offer_draft', $1, $2, now(), 'Nabídka', 'Návrh zakázky od Claude (jménem Obchodník): Školení',
      '[]'::jsonb, '{}', $3, $4, gen_random_uuid(), $5::jsonb, $6) RETURNING id`,
  [`sha256:${key.repeat(64).slice(0, 64)}`, evidence, account, SALES, JSON.stringify(DRAFT), 'b'.repeat(64)]))[0].id

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
    for (const [id, email, role] of [[SALES, 'sales@mummiesdaddies.com', 'obchodnik'], [OWNER, 'owner@mummiesdaddies.com', 'vedeni'], [PM, 'pm@mummiesdaddies.com', 'projektak']]) {
      await db.query(`INSERT INTO auth.users (id, email, raw_user_meta_data, invited_at) VALUES ($1, $2, '{}', now())`, [id, email])
      await db.query(`UPDATE team_member SET role = $2::team_role WHERE id = $1`, [id, role])
    }
    evidence = (await one<{ id: number }>(`INSERT INTO evidence (source_kind, source_id, web_link) VALUES ('email_message', 'mcp-proposal:00000000-0000-4000-8000-000000000001', 'https://outlook.office.com/mail/x') RETURNING id`)).id
    account = (await one<{ id: number }>(`INSERT INTO account (name) VALUES ('Alfa s.r.o.') RETURNING id`)).id
  }, 300_000)

  test('řetěz 0001–0101 projde, 0101 je v ledgeru a jde spustit znovu', async () => {
    expect(skipped).toEqual([...NEEDS_VAULT])
    expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM schema_migration WHERE version = '0101'`)).n).toBe(1)
    await db.exec(readFileSync('supabase/migrations/0101_connector_deal_proposals.sql', 'utf8'))
    expect(await one(`SELECT column_name FROM information_schema.columns WHERE table_name = 'mail_content_intake' AND column_name = 'decision_note'`))
      .toEqual({ column_name: 'decision_note' })
  })

  test('návrh projde CHECKy; vidí ho obchodní role, projekťák ne', async () => {
    const id = await proposal('a')
    expect(await as({ role: 'authenticated', sub: SALES }, `SELECT id FROM mail_content_intake WHERE id = ${id}`)).toHaveLength(1)
    expect(await as({ role: 'authenticated', sub: PM }, `SELECT id FROM mail_content_intake WHERE id = ${id}`)).toHaveLength(0)
    // Klient session sám zapisovat nesmí (jen server).
    await expect(as({ role: 'authenticated', sub: SALES }, `UPDATE mail_content_intake SET status = 'discarded' WHERE id = ${id} RETURNING id`))
      .rejects.toThrow(/permission denied/)
  })

  test('schválení: vyhraný obchod s cestou mail-offer/<uuid> a uzavřený řádek', async () => {
    const id = await proposal('c')
    const uuid = (await one<{ u: string }>(`SELECT offer_proposal_id::text AS u FROM mail_content_intake WHERE id = ${id}`)).u
    const deal = (await svc<{ id: number }>(`user:${OWNER}`, `INSERT INTO deal (account_id, title, revenue_line, revenue_category, stage, probability_pct,
      forecast_category, won_at, closed_at, currency, amount_one_time, owner_id, source_pdf_path)
      VALUES (${account}, 'Školení', 'svatebni_hostina', 'one_time', 'vyhráno', 100, 'closed', current_date, current_date, 'CZK', 120000, '${SALES}', $1)
      RETURNING id`, [`mail-offer/${uuid}`]))[0].id
    expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM engagement WHERE deal_id = ${deal}`)).n).toBe(1)
    await svc(`user:${OWNER}`, `UPDATE mail_content_intake SET status = 'proposed', wait_reason = NULL, offer_draft = NULL, account_id = ${account},
      deal_id = ${deal}, match_method = 'manual', decided_by = 'user:${OWNER}', decided_at = now() WHERE id = ${id} AND status = 'queued'`)
    expect(await one(`SELECT status, deal_id FROM mail_content_intake WHERE id = ${id}`)).toEqual({ status: 'proposed', deal_id: deal })
    // Druhý obchod ze stejného návrhu nevznikne (unikát source_pdf_path, 0070).
    await expect(svc(`user:${OWNER}`, `INSERT INTO deal (account_id, title, revenue_line, revenue_category, owner_id, source_pdf_path)
      VALUES (${account}, 'Dvojče', 'svatebni_hostina', 'one_time', '${SALES}', $1)`, [`mail-offer/${uuid}`])).rejects.toThrow()
  })

  test('zamítnutí s důvodem; prázdný nebo dlouhý důvod CHECK odmítne', async () => {
    const id = await proposal('d')
    const reject = (note: string | null) => svc(`user:${OWNER}`, `UPDATE mail_content_intake SET status = 'discarded', wait_reason = NULL, subject = NULL,
      excerpt = NULL, attachment_names = '[]'::jsonb, offer_draft = NULL, decided_by = 'user:${OWNER}', decided_at = now(), decision_note = $1
      WHERE id = ${id}`, [note])
    await expect(reject('')).rejects.toThrow(/decision_note/)
    await expect(reject('x'.repeat(501))).rejects.toThrow(/decision_note/)
    await reject('duplicita')
    expect(await one(`SELECT status, decision_note, offer_draft FROM mail_content_intake WHERE id = ${id}`))
      .toEqual({ status: 'discarded', decision_note: 'duplicita', offer_draft: null })
  })

  test('stejný klíč idempotence podruhé = 23505 (žádný druhý návrh)', async () => {
    await proposal('e')
    await expect(proposal('e')).rejects.toThrow(/duplicate key|unique/i)
  })
})
