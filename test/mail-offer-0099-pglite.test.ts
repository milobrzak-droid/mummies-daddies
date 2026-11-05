// 0099 v opravdovém Postgresu (PGlite = PostgreSQL ve WASM), bez sítě a bez živé DB:
// návrh zakázky z nabídky v příloze e-mailu na řádku fronty mail_content_intake
// (stavové CHECKy, unikát id návrhu, RLS, audit bez hodnoty, retence maže návrh).
// Statické kontroly migrace: test/mail-content-migration.test.ts; PGlite je v
// devDependencies, kdyby chyběl, červeně selže test/pglite-dependency.test.ts.
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, test } from 'vitest'
import { AUDIT_SCHEMA as SCHEMA, U_PM, U_SALES } from './helpers/auditPgliteSchema'

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

const M0064 = readFileSync('supabase/migrations/0064_audit_coverage.sql', 'utf8')
const M0082 = readFileSync('supabase/migrations/0082_audit_gaps_partner_lockdown.sql', 'utf8')
const M0035 = readFileSync('supabase/migrations/0035_deal_audit_hardening.sql', 'utf8')
  .replace(/DO \$\$\nDECLARE\n  v_sig text;[\s\S]*?END \$\$;/, '')
  .replace(/INSERT INTO schema_migration[\s\S]*$/, '')
const M0091 = readFileSync('supabase/migrations/0091_mail_content_intake.sql', 'utf8')
const M0099 = readFileSync('supabase/migrations/0099_mail_offer_attachment.sql', 'utf8')

const U_PARTNER = '44444444-4444-4444-8444-444444444444'
const U_LEKTOR = '55555555-5555-4555-8555-555555555555'
const U_GONE = '66666666-6666-4666-8666-666666666666'
const U_ADMIN_PARTNER = '77777777-7777-4777-8777-777777777777'

const EXTRA = `
ALTER ROLE service_role BYPASSRLS; -- jako v Supabase: servisní klíč RLS obchází
ALTER TABLE team_member ADD COLUMN email text, ADD COLUMN is_admin boolean NOT NULL DEFAULT false,
  ADD COLUMN manager_id uuid, ADD COLUMN deactivated_at timestamptz, ADD COLUMN weekly_capacity_hours numeric DEFAULT 40;
UPDATE team_member SET email = 'x@example.cz';
INSERT INTO team_member (id, role, full_name, email, is_admin) VALUES
  ('${U_PARTNER}', 'partner', 'Externí Partner', 'partner@firma.cz', false),
  ('${U_LEKTOR}', 'lektor', 'Lektor', 'lektor@enter.cz', false),
  ('${U_ADMIN_PARTNER}', 'partner', 'Partner s příznakem', 'ap@firma.cz', true);
INSERT INTO team_member (id, role, full_name, email, deactivated_at) VALUES ('${U_GONE}', 'projektak', 'Odešel', 'gone@enter.cz', now());
CREATE FUNCTION is_admin() RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM team_member WHERE id = auth.uid() AND is_admin) $$;
CREATE TABLE loop_node (node text PRIMARY KEY, owner_id uuid, deputy_id uuid, updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE allocation (id bigserial PRIMARY KEY, member_id uuid NOT NULL, engagement_id bigint, work_case_id bigint,
  hours_per_week numeric(4,1) NOT NULL, starts_on date NOT NULL, ends_on date, substitute_id uuid, note text, created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE metric_observation (id bigserial PRIMARY KEY, engagement_id bigint NOT NULL, metric text NOT NULL, unit text, baseline numeric,
  actual numeric, observed_on date NOT NULL, evidence_id bigint REFERENCES evidence(id), note text, created_by uuid, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE financial_record (id bigserial PRIMARY KEY, account_id bigint NOT NULL, deal_id bigint, engagement_id bigint, milestone_id bigint,
  kind text NOT NULL, amount numeric(14,2) NOT NULL, currency text NOT NULL DEFAULT 'CZK', period_month date NOT NULL, status text NOT NULL DEFAULT 'draft',
  source text NOT NULL, evidence_id bigint REFERENCES evidence(id), external_ref text, note text, created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE case_proposal (id bigserial PRIMARY KEY, capability text NOT NULL, source_key text NOT NULL, occurred_at timestamptz NOT NULL, node text NOT NULL,
  account_id bigint, title text NOT NULL, rationale text NOT NULL, steps jsonb NOT NULL DEFAULT '[]', method text NOT NULL, info_state text NOT NULL DEFAULT 'ai_suggestion',
  evidence_id bigint NOT NULL REFERENCES evidence(id), status text NOT NULL DEFAULT 'pending', created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  decided_by text, decided_at timestamptz, decision_note text, work_case_id bigint);
CREATE TABLE deal_scope_version (id bigserial PRIMARY KEY, deal_id bigint NOT NULL, version integer NOT NULL, scope text, amount_one_time numeric(14,2) NOT NULL DEFAULT 0,
  expected_mrr numeric(12,2) NOT NULL DEFAULT 0, currency text NOT NULL DEFAULT 'CZK', status text NOT NULL DEFAULT 'draft', sent_at timestamptz, decided_at timestamptz,
  evidence_id bigint REFERENCES evidence(id), created_by uuid, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE deal_partner (deal_id bigint NOT NULL, partner_id bigint NOT NULL, program text NOT NULL, attribution_pct numeric(5,2) DEFAULT 0,
  is_sourcing boolean NOT NULL DEFAULT false, nnpsa_target integer, PRIMARY KEY (deal_id, partner_id, program));
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated, service_role, anon;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO authenticated, service_role, anon;
`

const RLS = `
ALTER TABLE account ENABLE ROW LEVEL SECURITY;
CREATE POLICY account_all ON account FOR ALL USING (is_team_member()) WITH CHECK (is_team_member());
ALTER TABLE task ENABLE ROW LEVEL SECURITY;
CREATE POLICY task_all ON task FOR ALL USING (is_team_member()) WITH CHECK (is_team_member());
ALTER TABLE allocation ENABLE ROW LEVEL SECURITY;
CREATE POLICY allocation_all ON allocation FOR ALL USING (is_team_member()) WITH CHECK (is_team_member());
ALTER TABLE team_member ENABLE ROW LEVEL SECURITY;
CREATE POLICY team_read ON team_member FOR SELECT USING (is_team_member());
`

const HASH = (n: number) => `sha256:${String(n).padStart(64, '0')}`
const SHA = (n: number) => String(n).padStart(64, '0')
const DRAFT = JSON.stringify({ version: 1, info_state: 'ai_suggestion', fields: { account_name: 'Tajná Firma s.r.o.', amount_one_time: 4242000 } })
const UUID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

describe.skipIf(!PGliteCtor)('0099 v Postgresu (PGlite)', () => {
  let db: Db
  const one = async <T,>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0]
  let evId = 0
  let accountId = 0
  let n = 0
  const nextKey = () => HASH(++n)

  async function countAs(sub: string): Promise<number> {
    await db.query('BEGIN')
    try {
      await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role: 'authenticated', sub, aal: 'aal2' })])
      await db.query('SET LOCAL ROLE authenticated')
      return (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM mail_content_intake WHERE offer_draft IS NOT NULL')).rows[0].n
    } finally {
      await db.query('ROLLBACK')
    }
  }

  /** Čekající řádek s návrhem zakázky. */
  const offerRow = async (i: number, extra = '') => (await one<{ id: number }>(
    `INSERT INTO mail_content_intake (dedupe_key, evidence_id, received_at, status, wait_reason, excerpt, subject, offer_proposal_id, offer_draft, offer_pdf_sha256 ${extra ? ', ' + extra.split('|')[0] : ''})
     VALUES ('${nextKey()}', ${evId}, now(), 'queued', 'offer_draft', 'Posílám nabídku.', 'Nabídka', '${UUID(i)}', '${DRAFT}'::jsonb, '${SHA(i)}' ${extra ? ', ' + extra.split('|')[1] : ''}) RETURNING id`)).id

  beforeAll(async () => {
    db = new PGliteCtor!()
    await db.exec(SCHEMA)
    await db.exec(EXTRA)
    await db.exec(M0035)
    await db.exec(M0064)
    await db.exec(RLS)
    await db.exec(M0082)
    await db.exec(M0091)
    // řádek z doby před 0099 přežije migraci beze změny
    await db.exec(`INSERT INTO evidence (source_kind, source_id, web_link) VALUES ('email_message', '<a@b>', 'https://outlook.office.com/x')`)
    evId = (await one<{ id: number }>('SELECT id FROM evidence LIMIT 1')).id
    await db.exec(`INSERT INTO mail_content_intake (dedupe_key, evidence_id, received_at, status, wait_reason, excerpt) VALUES ('${HASH(9000)}', ${evId}, now(), 'queued', 'no_match', 'Starý řádek')`)
    await db.exec(M0099)
    await db.exec(M0099) // idempotence
    await db.exec(`INSERT INTO account (name) VALUES ('Firma')`)
    accountId = (await one<{ id: number }>('SELECT id FROM account LIMIT 1')).id
  }, 90_000)

  test('idempotence: druhý běh nezdvojí ledger ani trigger; starý řádek zůstal', async () => {
    expect((await one<{ n: number }>("SELECT count(*)::int AS n FROM schema_migration WHERE version = '0099'")).n).toBe(1)
    expect((await one<{ n: number }>("SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'audit_row_change_soft' AND tgrelid = 'mail_content_intake'::regclass")).n).toBe(1)
    expect((await one<{ excerpt: string; offer_draft: unknown }>(`SELECT excerpt, offer_draft FROM mail_content_intake WHERE dedupe_key = '${HASH(9000)}'`))).toEqual({ excerpt: 'Starý řádek', offer_draft: null })
  })

  test('návrh zakázky drží jen čekající řádek s důvodem offer_draft a id návrhu (CHECK v DB)', async () => {
    await offerRow(1)
    // důvod offer_draft bez návrhu
    await expect(db.exec(`INSERT INTO mail_content_intake (dedupe_key, evidence_id, received_at, status, wait_reason, excerpt) VALUES ('${nextKey()}', ${evId}, now(), 'queued', 'offer_draft', 'x')`))
      .rejects.toThrow(/offer_check/)
    // návrh bez důvodu offer_draft
    await expect(db.exec(`INSERT INTO mail_content_intake (dedupe_key, evidence_id, received_at, status, wait_reason, excerpt, offer_proposal_id, offer_draft) VALUES ('${nextKey()}', ${evId}, now(), 'queued', 'no_match', 'x', '${UUID(50)}', '${DRAFT}'::jsonb)`))
      .rejects.toThrow(/offer_check/)
    // návrh bez id návrhu
    await expect(db.exec(`INSERT INTO mail_content_intake (dedupe_key, evidence_id, received_at, status, wait_reason, excerpt, offer_draft) VALUES ('${nextKey()}', ${evId}, now(), 'queued', 'offer_draft', 'x', '${DRAFT}'::jsonb)`))
      .rejects.toThrow(/offer_check/)
    // návrh u zahozeného / vypršelého / přiřazeného řádku nejde (wait_reason je tam NULL)
    for (const [status, extra] of [['discarded', ''], ['expired', ''], ['proposed', `, account_id`]] as const) {
      const vals = status === 'proposed' ? `${accountId}` : ''
      await expect(db.exec(`INSERT INTO mail_content_intake (dedupe_key, evidence_id, received_at, status, decided_by, decided_at, offer_proposal_id, offer_draft ${extra})
        VALUES ('${nextKey()}', ${evId}, now(), '${status}', 'user:x', now(), '${UUID(60)}', '${DRAFT}'::jsonb ${vals ? ', ' + vals : ''})`)).rejects.toThrow()
    }
    // návrh není objekt nebo je příliš velký
    await expect(db.exec(`INSERT INTO mail_content_intake (dedupe_key, evidence_id, received_at, status, wait_reason, excerpt, offer_proposal_id, offer_draft) VALUES ('${nextKey()}', ${evId}, now(), 'queued', 'offer_draft', 'x', '${UUID(51)}', '"text"'::jsonb)`))
      .rejects.toThrow(/offer_check/)
    const big = JSON.stringify({ x: 'y'.repeat(17_000) })
    await expect(db.exec(`INSERT INTO mail_content_intake (dedupe_key, evidence_id, received_at, status, wait_reason, excerpt, offer_proposal_id, offer_draft) VALUES ('${nextKey()}', ${evId}, now(), 'queued', 'offer_draft', 'x', '${UUID(52)}', '${big}'::jsonb)`))
      .rejects.toThrow(/offer_check/)
    // otisk PDF je hash
    await expect(db.exec(`INSERT INTO mail_content_intake (dedupe_key, evidence_id, received_at, status, wait_reason, excerpt, offer_pdf_sha256) VALUES ('${nextKey()}', ${evId}, now(), 'queued', 'no_match', 'x', 'NENI-HASH')`))
      .rejects.toThrow(/offer_check/)
  })

  test('unikát id návrhu: stejná příloha téže zprávy nevznikne dvakrát', async () => {
    await offerRow(2)
    await expect(offerRow(2)).rejects.toThrow(/offer_proposal_uniq|duplicate key/)
    // řádky bez návrhu (NULL id) se navzájem nekonfliktují
    await db.exec(`INSERT INTO mail_content_intake (dedupe_key, evidence_id, received_at, status, wait_reason, excerpt) VALUES ('${nextKey()}', ${evId}, now(), 'queued', 'no_match', 'a')`)
    await db.exec(`INSERT INTO mail_content_intake (dedupe_key, evidence_id, received_at, status, wait_reason, excerpt) VALUES ('${nextKey()}', ${evId}, now(), 'queued', 'no_match', 'b')`)
  })

  test('potvrzení: řádek přejde na proposed a návrh zmizí (stejný UPDATE jako v aplikaci)', async () => {
    const id = await offerRow(3)
    await db.exec(`UPDATE mail_content_intake SET status = 'proposed', wait_reason = NULL, offer_draft = NULL, account_id = ${accountId},
      match_method = 'manual', decided_by = 'user:x', decided_at = now() WHERE offer_proposal_id = '${UUID(3)}' AND status = 'queued'`)
    expect(await one(`SELECT status, offer_draft, offer_proposal_id::text AS pid, offer_pdf_sha256 FROM mail_content_intake WHERE id = ${id}`))
      .toEqual({ status: 'proposed', offer_draft: null, pid: UUID(3), offer_pdf_sha256: SHA(3) })
    // Přiřazení bez smazání návrhu databáze nepustí (nezůstane obchodní údaj u vyřízeného řádku).
    const other = await offerRow(4)
    await expect(db.exec(`UPDATE mail_content_intake SET status = 'proposed', wait_reason = NULL, account_id = ${accountId}, decided_by = 'user:x', decided_at = now() WHERE id = ${other}`))
      .rejects.toThrow(/offer_check/)
  })

  test('zahození: návrh zmizí spolu s textem, jinak DB nepustí', async () => {
    const id = await offerRow(5)
    await expect(db.exec(`UPDATE mail_content_intake SET status = 'discarded', wait_reason = NULL, subject = NULL, excerpt = NULL, attachment_names = '[]', decided_by = 'user:x', decided_at = now() WHERE id = ${id}`))
      .rejects.toThrow(/offer_check/)
    await db.exec(`UPDATE mail_content_intake SET status = 'discarded', wait_reason = NULL, subject = NULL, excerpt = NULL, attachment_names = '[]', offer_draft = NULL, decided_by = 'user:x', decided_at = now() WHERE id = ${id}`)
    expect((await one<{ offer_draft: unknown }>(`SELECT offer_draft FROM mail_content_intake WHERE id = ${id}`)).offer_draft).toBeNull()
  })

  test('retence: vypršelý čekající řádek přijde i o návrh zakázky, čerstvý ho drží', async () => {
    const old = await offerRow(6, "created_at|now() - interval '40 days'")
    const fresh = await offerRow(7)
    const res = await one<{ r: { expired: number } }>('SELECT purge_mail_content_intake() AS r')
    expect(res.r.expired).toBeGreaterThanOrEqual(1)
    expect(await one(`SELECT status, offer_draft, subject, excerpt FROM mail_content_intake WHERE id = ${old}`)).toEqual({ status: 'expired', offer_draft: null, subject: null, excerpt: null })
    expect((await one<{ status: string; offer_draft: unknown }>(`SELECT status, offer_draft FROM mail_content_intake WHERE id = ${fresh}`)).status).toBe('queued')
    expect(await one<{ r: unknown }>('SELECT purge_mail_content_intake() AS r')).toEqual({ r: { expired: 0, cleared: 0 } })
  })

  test('RLS zůstává: obchodní role návrh vidí, projekťák ne, klient nezapíše', async () => {
    expect(await countAs(U_SALES)).toBeGreaterThan(0)
    expect(await countAs(U_PM)).toBe(0)
  })

  test('audit: návrh zakázky (klient, cena) ani otisk PDF se do auditu nedostanou hodnotou, jen názvem', async () => {
    const id = await offerRow(8)
    const rows = (await db.query<{ after: unknown; before: unknown }>(
      `SELECT before, after FROM audit_event WHERE entity_table = 'mail_content_intake' AND entity_id = ${id}`)).rows
    expect(rows.length).toBeGreaterThan(0)
    const dump = JSON.stringify(rows)
    expect(dump).not.toMatch(/Tajná Firma|4242000|ai_suggestion/)
    expect(dump).not.toContain(SHA(8))
    expect(dump).toContain('offer_draft')
  })
})
