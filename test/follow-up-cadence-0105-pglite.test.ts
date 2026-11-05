// Migrace 0105 (balík P4, follow-up cadence) proti CELÉMU řetězu migrací
// (PGlite, bez sítě): follow_up_attempt (UNIQUE, kontroly stavů, RLS, audit),
// follow_up_facts a pravidlo CR002 pro automatickou prohru.
import { readdirSync, readFileSync } from 'node:fs'
import { beforeAll, describe, expect, test } from 'vitest'
import { webInquiryPayload, webInquirySchema } from '@/core/webInquiry'

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

const SALES = 'b1111111-1111-4111-8111-111111111111'
const PM = 'b3333333-3333-4333-8333-333333333333'
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


const inquiry = () => webInquirySchema.parse({
  clientToken: crypto.randomUUID(),
  segment: 'b2b', eventType: 'coffee_break', eventDate: '2026-12-11', guests: 120, venue: 'Praha 2',
  specialRequests: null,
  customer: { name: 'Karel Ukázkový', email: 'karel@alfa.example', phone: null, companyName: 'Firma Alfa s.r.o.', ico: null },
  consent: { processing: true },
  sourcePage: '/catering',
})

describe.skipIf(!PGliteCtor)('0105 follow-up cadence (PGlite, celý řetěz migrací)', () => {
  let db: Db
  let dealId: number
  let contactId: number

  async function as<T = Row>(who: { role: 'authenticated' | 'service_role' | 'anon'; sub?: string }, sql: string, params: unknown[] = []): Promise<T[]> {
    await db.query('BEGIN')
    try {
      await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ role: who.role, aal: 'aal2', ...(who.sub ? { sub: who.sub } : {}) }),
      ])
      await db.query(`SET LOCAL ROLE ${who.role}`)
      const res = await db.query<T>(sql, params)
      await db.query('COMMIT')
      return res.rows
    } catch (e) {
      await db.query('ROLLBACK').catch(() => undefined)
      throw e
    }
  }
  const svc = <T = Row>(sql: string, params: unknown[] = []) => as<T>({ role: 'service_role' }, sql, params)
  const one = async <T = Row>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0]
  const facts = async () => (await svc<Row>(`SELECT * FROM follow_up_facts(ARRAY[$1]::bigint[])`, [dealId]))[0]

  beforeAll(async () => {
    db = new PGliteCtor!()
    await db.exec(STUB)
    for (const f of readdirSync('supabase/migrations').filter((x) => x.endsWith('.sql')).sort()) {
      if (NEEDS_VAULT.has(f)) continue
      try {
        await db.exec(readFileSync(`supabase/migrations/${f}`, 'utf8'))
      } catch (e) {
        await db.exec('ROLLBACK').catch(() => undefined)
        throw new Error(`${f}: ${(e as Error).message}`)
      }
    }
    for (const [id, email, role] of [[SALES, 'obchod@test.example', 'obchodnik'], [PM, 'pm@test.example', 'projektak']]) {
      await db.query(`INSERT INTO auth.users (id, email, raw_user_meta_data, invited_at) VALUES ($1, $2, '{}', now())`, [id, email])
      await db.query(`UPDATE team_member SET role = $2::team_role WHERE id = $1`, [id, role])
    }
    await db.exec(readFileSync('supabase/seed.sql', 'utf8'))
    dealId = (await one<{ id: number }>(`SELECT id FROM deal WHERE title = 'Vánoční večírek 120 hostů'`))!.id
    contactId = (await one<{ id: number }>(`SELECT id FROM contact WHERE email = 'karel@alfa.example'`))!.id
    await db.query(`UPDATE deal SET primary_contact_id = $2, owner_id = $3 WHERE id = $1`, [dealId, contactId, SALES])
  }, 300_000)

  test('0105 je v ledgeru', async () => {
    expect(await one(`SELECT version FROM schema_migration WHERE version = '0105'`)).toEqual({ version: '0105' })
  })

  test('UNIQUE(deal_id, attempt) a kontroly stavů', async () => {
    await svc(`INSERT INTO follow_up_attempt (deal_id, attempt, planned_on, status, template) VALUES ($1, 1, '2026-11-05', 'planned', 'pripominka_1')`, [dealId])
    await expect(svc(`INSERT INTO follow_up_attempt (deal_id, attempt, planned_on, status) VALUES ($1, 1, '2026-11-06', 'planned')`, [dealId]))
      .rejects.toThrow(/follow_up_attempt_deal_attempt_key|duplicate key/)
    // enqueued bez source_ref / s cizím source_ref neprojde
    await expect(svc(`UPDATE follow_up_attempt SET status = 'enqueued' WHERE deal_id = $1 AND attempt = 1`, [dealId]))
      .rejects.toThrow(/follow_up_attempt_enqueued_check/)
    await expect(svc(`UPDATE follow_up_attempt SET status = 'enqueued', enqueued_at = now(), outbox_source_ref = 'followup:999:1' WHERE deal_id = $1 AND attempt = 1`, [dealId]))
      .rejects.toThrow(/follow_up_attempt_source_ref_check/)
    await svc(`UPDATE follow_up_attempt SET status = 'enqueued', enqueued_at = now(), outbox_id = 501, outbox_source_ref = 'followup:' || $1 || ':1' WHERE deal_id = $1 AND attempt = 1`, [dealId])
    // stopped bez důvodu / s volným textem neprojde
    await expect(svc(`INSERT INTO follow_up_attempt (deal_id, attempt, planned_on, status) VALUES ($1, 2, '2026-11-12', 'stopped')`, [dealId]))
      .rejects.toThrow(/follow_up_attempt_stop_reason_required/)
    await expect(svc(`INSERT INTO follow_up_attempt (deal_id, attempt, planned_on, status, stop_reason) VALUES ($1, 2, '2026-11-12', 'stopped', 'Zákazník napsal')`, [dealId]))
      .rejects.toThrow(/follow_up_attempt_stop_reason_check/)
  })

  test('RLS: obchodní role čte, ostatní ne; z klienta nikdo nezapisuje', async () => {
    expect((await as<{ n: number }>({ role: 'authenticated', sub: SALES }, `SELECT count(*)::int AS n FROM follow_up_attempt`))[0].n).toBeGreaterThan(0)
    expect((await as<{ n: number }>({ role: 'authenticated', sub: PM }, `SELECT count(*)::int AS n FROM follow_up_attempt`))[0].n).toBe(0)
    await expect(as({ role: 'authenticated', sub: SALES }, `INSERT INTO follow_up_attempt (deal_id, attempt, planned_on) VALUES ($1, 9, '2026-11-05')`, [dealId]))
      .rejects.toThrow(/permission denied/)
    await expect(as({ role: 'authenticated', sub: SALES }, `UPDATE follow_up_attempt SET status = 'stopped', stop_reason = 'x'`))
      .rejects.toThrow(/permission denied/)
    await expect(as({ role: 'anon' }, `SELECT count(*) FROM follow_up_attempt`)).rejects.toThrow(/permission denied/)
    await expect(as({ role: 'authenticated', sub: SALES }, `SELECT * FROM follow_up_facts(ARRAY[1]::bigint[])`)).rejects.toThrow(/permission denied/)
  })

  test('follow_up_facts: poslední příchozí a odchozí pošta, ruční aktivita, nabídka, datum akce', async () => {
    const before = await facts()
    expect(before).toMatchObject({ deal_id: dealId, last_inbound_at: null, last_human_activity_at: null, contact_do_not_contact: false })
    await db.query(`INSERT INTO mail_event (internet_message_id, direction, occurred_at, account_id, contact_id, match_status)
      VALUES ('<a@x>', 'inbound', '2026-10-30T08:00:00Z', 1, NULL, 'matched'),
             ('<b@x>', 'inbound', '2026-11-03T08:00:00Z', 1, $1, 'matched'),
             ('<c@x>', 'outbound', '2026-11-02T09:00:00Z', 1, $1, 'matched'),
             ('<d@x>', 'inbound', '2026-11-04T08:00:00Z', 2, NULL, 'matched')`, [contactId])
    await db.query(`INSERT INTO deal_scope_version (deal_id, version, status, sent_at, created_by) VALUES ($1, 1, 'sent', '2026-11-02T09:00:00Z', $2)`, [dealId, SALES])
    // Aktivita agenta (bez autora) se nepočítá, ruční ano.
    await db.query(`INSERT INTO sales_activity (deal_id, account_id, kind, subject, occurred_at, source) VALUES ($1, 1, 'email', 'Připomínka', '2026-11-05T09:00:00Z', 'agent:follow_up')`, [dealId])
    const w = (await svc<{ r: { web_inquiry_id: number } }>(`SELECT web_inquiry_submit($1::jsonb) AS r`, [JSON.stringify(webInquiryPayload(inquiry()))]))[0].r
    // Poptávka, ze které obchod vznikl (přišla před nabídkou; pozdější by byla odpověď zákazníka, 0108).
    await db.query(`UPDATE web_inquiry SET deal_id = $2, received_at = '2026-10-29T08:00:00Z' WHERE id = $1`, [w.web_inquiry_id, dealId])

    const f = await facts()
    expect(new Date(f.last_inbound_at as string).toISOString()).toBe('2026-11-03T08:00:00.000Z')
    expect(new Date(f.last_outbound_at as string).toISOString()).toBe('2026-11-02T09:00:00.000Z')
    expect(new Date(f.offer_sent_at as string).toISOString()).toBe('2026-11-02T09:00:00.000Z')
    expect(f.last_human_activity_at).toBeNull()
    expect((await svc<{ d: string }>(`SELECT event_date::text AS d FROM follow_up_facts(ARRAY[$1]::bigint[])`, [dealId]))[0].d).toBe('2026-12-11')

    await db.query(`INSERT INTO sales_activity (deal_id, account_id, kind, subject, occurred_at, created_by) VALUES ($1, 1, 'call', 'Telefonát', '2026-11-04T10:00:00Z', $2)`, [dealId, SALES])
    expect((await facts()).last_human_activity_at).not.toBeNull()

    await db.query(`UPDATE contact SET do_not_contact = true WHERE id = $1`, [contactId])
    expect(await facts()).toMatchObject({ contact_do_not_contact: true, account_opted_out: 1 })
    await db.query(`UPDATE contact SET do_not_contact = false WHERE id = $1`, [contactId])
  })

  test('auto-lost: bez lost_reason odmítnuto (CR002), s důvodem projde', async () => {
    await expect(svc(`UPDATE deal SET stage = 'prohráno' WHERE id = $1`, [dealId])).rejects.toThrow(/CR002|důvod prohry/)
    await svc(`UPDATE deal SET stage = 'prohráno', lost_reason = 'Bez odpovědi', forecast_category = 'closed', closed_at = '2026-11-20',
      probability_pct = 0, next_step = NULL, next_step_due = NULL WHERE id = $1`, [dealId])
    expect(await one(`SELECT stage::text AS stage, lost_reason FROM deal WHERE id = $1`, [dealId])).toEqual({ stage: 'prohráno', lost_reason: 'Bez odpovědi' })
  })

  test('audit pokusů nese jen stavy a čísla (žádný e-mail ani text)', async () => {
    const rows = (await db.query<{ payload: unknown }>(`SELECT to_jsonb(a) AS payload FROM audit_event a WHERE entity_table = 'follow_up_attempt'`)).rows
    expect(rows.length).toBeGreaterThan(0)
    const text = JSON.stringify(rows)
    expect(text).toContain('"status"')
    expect(text).not.toContain('karel@alfa.example')
    expect(text).not.toContain('"outbox_source_ref":"followup')
  })
})
