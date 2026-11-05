// 0091 v opravdovém Postgresu (PGlite = PostgreSQL ve WASM), bez sítě a bez živé DB:
// tabulka vybrané pošty s obsahem, její stavové CHECKy, RLS (jen obchodní role),
// audit bez textu a retence purge_mail_content_intake. Statické kontroly téže
// migrace běží vždy (test/mail-content-migration.test.ts); PGlite je v
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

describe.skipIf(!PGliteCtor)('0091 v Postgresu (PGlite)', () => {
  let db: Db
  const notices: string[] = []

  async function as(who: { role: 'authenticated' | 'service_role'; sub?: string }, sql: string) {
    const claims = JSON.stringify({ role: who.role, aal: 'aal2', ...(who.sub ? { sub: who.sub } : {}) })
    try {
      await db.exec(`BEGIN;\nSELECT set_config('request.jwt.claims', '${claims}', true);\nSET LOCAL ROLE ${who.role};\n${sql};\nCOMMIT;`)
    } catch (e) {
      await db.exec('ROLLBACK').catch(() => undefined)
      throw e
    }
  }
  async function countAs(sub: string, where = 'true'): Promise<number> {
    await db.query('BEGIN')
    try {
      await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role: 'authenticated', sub, aal: 'aal2' })])
      await db.query('SET LOCAL ROLE authenticated')
      return (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM mail_content_intake WHERE ${where}`)).rows[0].n
    } finally {
      await db.query('ROLLBACK')
    }
  }
  const one = async <T,>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0]

  let accountId = 0
  let engagementId = 0
  let milestoneId = 0
  let evId = 0
  let n = 0
  const nextKey = () => HASH(++n)

  /** Vloží řádek jako server (servisní klíč) a vrátí jeho id. */
  async function insert(cols: string, vals: string): Promise<number> {
    const r = await db.query<{ id: number }>(
      `INSERT INTO mail_content_intake (dedupe_key, evidence_id, received_at, ${cols}) VALUES ('${nextKey()}', ${evId}, now(), ${vals}) RETURNING id`)
    return r.rows[0].id
  }
  const queued = (extra = '') =>
    insert("status, wait_reason, excerpt, subject" + (extra ? ', ' + extra.split('|')[0] : ''),
      "'queued', 'no_match', 'Schvalujeme mapu.', 'Předmět'" + (extra ? ', ' + extra.split('|')[1] : ''))

  beforeAll(async () => {
    db = new PGliteCtor!()
    await db.exec(SCHEMA)
    await db.exec(EXTRA)
    await db.exec(M0035)
    await db.exec(M0064)
    await db.exec(RLS)
    await db.exec(M0082)
    await db.exec(M0091)
    await db.exec(M0091) // idempotence
    await db.exec(`INSERT INTO evidence (source_kind, source_id, web_link) VALUES ('email_message', '<a@b>', 'https://outlook.office.com/x')`)
    evId = (await one<{ id: number }>('SELECT id FROM evidence LIMIT 1')).id
    await db.exec(`INSERT INTO account (name) VALUES ('Firma')`)
    accountId = (await one<{ id: number }>('SELECT id FROM account LIMIT 1')).id
    await db.exec(`INSERT INTO engagement (account_id, kind) VALUES (${accountId}, 'edu')`)
    engagementId = (await one<{ id: number }>('SELECT id FROM engagement LIMIT 1')).id
    await db.exec(`INSERT INTO engagement_milestone (engagement_id, title) VALUES (${engagementId}, 'Procesní mapa')`)
    milestoneId = (await one<{ id: number }>('SELECT id FROM engagement_milestone LIMIT 1')).id
  }, 90_000)

  test('idempotence: druhý běh nezdvojí trigger ani ledger', async () => {
    expect((await one<{ n: number }>("SELECT count(*)::int AS n FROM schema_migration WHERE version = '0091'")).n).toBe(1)
    expect((await one<{ n: number }>("SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'audit_row_change_soft' AND tgrelid = 'mail_content_intake'::regclass")).n).toBe(1)
    expect(notices).toEqual([])
  })

  test('stavový CHECK: čekající nese úryvek a důvod, zahozený a vypršelý žádný text', async () => {
    await expect(db.exec(`INSERT INTO mail_content_intake (dedupe_key, evidence_id, received_at, status, wait_reason) VALUES ('${nextKey()}', ${evId}, now(), 'queued', 'no_match')`))
      .rejects.toThrow(/state_consistent/)
    await expect(db.exec(`INSERT INTO mail_content_intake (dedupe_key, evidence_id, received_at, status, excerpt) VALUES ('${nextKey()}', ${evId}, now(), 'queued', 'x')`))
      .rejects.toThrow(/state_consistent/)
    await expect(db.exec(`INSERT INTO mail_content_intake (dedupe_key, evidence_id, received_at, status, excerpt, decided_by, decided_at) VALUES ('${nextKey()}', ${evId}, now(), 'discarded', 'text', 'user:1', now())`))
      .rejects.toThrow(/state_consistent/)
    await expect(db.exec(`INSERT INTO mail_content_intake (dedupe_key, evidence_id, received_at, status, attachment_names, decided_by, decided_at) VALUES ('${nextKey()}', ${evId}, now(), 'expired', '["a.pdf"]', 'system:retention', now())`))
      .rejects.toThrow(/state_consistent/)
    // proposed bez klienta nejde, s klientem ano
    await expect(db.exec(`INSERT INTO mail_content_intake (dedupe_key, evidence_id, received_at, status, decided_by, decided_at) VALUES ('${nextKey()}', ${evId}, now(), 'proposed', 'system:x', now())`))
      .rejects.toThrow(/state_consistent/)
    await db.exec(`INSERT INTO mail_content_intake (dedupe_key, evidence_id, received_at, status, account_id, decided_by, decided_at) VALUES ('${nextKey()}', ${evId}, now(), 'proposed', ${accountId}, 'system:x', now())`)
  })

  test('meze sloupců: úryvek 300, předmět 200, příznaky jen známé, klíč sha256, deset příloh', async () => {
    await expect(db.exec(`INSERT INTO mail_content_intake (dedupe_key, evidence_id, received_at, status, wait_reason, excerpt) VALUES ('${nextKey()}', ${evId}, now(), 'queued', 'no_match', '${'x'.repeat(301)}')`))
      .rejects.toThrow(/excerpt_check/)
    await db.exec(`INSERT INTO mail_content_intake (dedupe_key, evidence_id, received_at, status, wait_reason, excerpt) VALUES ('${nextKey()}', ${evId}, now(), 'queued', 'no_match', '${'x'.repeat(300)}')`)
    await expect(queued(`subject|'${'s'.repeat(201)}'`)).rejects.toThrow()
    await expect(db.exec(`INSERT INTO mail_content_intake (dedupe_key, evidence_id, received_at, status, wait_reason, excerpt, signals) VALUES ('${nextKey()}', ${evId}, now(), 'queued', 'no_match', 'x', '{approval,hack}')`))
      .rejects.toThrow(/signals_check/)
    await expect(db.exec(`INSERT INTO mail_content_intake (dedupe_key, evidence_id, received_at, status, wait_reason, excerpt) VALUES ('<a@b>', ${evId}, now(), 'queued', 'no_match', 'x')`))
      .rejects.toThrow(/dedupe_check/)
    const eleven = JSON.stringify(Array.from({ length: 11 }, (_, i) => `f${i}.pdf`))
    await expect(db.exec(`INSERT INTO mail_content_intake (dedupe_key, evidence_id, received_at, status, wait_reason, excerpt, attachment_names) VALUES ('${nextKey()}', ${evId}, now(), 'queued', 'no_match', 'x', '${eleven}')`))
      .rejects.toThrow(/attachments_check/)
    // stejný klíč podruhé = unikát (idempotence příjmu)
    const key = nextKey()
    const ins = `INSERT INTO mail_content_intake (dedupe_key, evidence_id, received_at, status, wait_reason, excerpt) VALUES ('${key}', ${evId}, now(), 'queued', 'no_match', 'x')`
    await db.exec(ins)
    await expect(db.exec(ins)).rejects.toThrow(/dedupe_unique|duplicate key/)
  })

  test('RLS: obchodní role řádky vidí, projekťák ne; klient nezapíše nic', async () => {
    const total = (await one<{ n: number }>('SELECT count(*)::int AS n FROM mail_content_intake')).n
    expect(total).toBeGreaterThan(0)
    expect(await countAs(U_SALES)).toBe(total)
    expect(await countAs(U_PM)).toBe(0)
    await expect(as({ role: 'authenticated', sub: U_SALES }, `UPDATE mail_content_intake SET excerpt = 'změna'`)).rejects.toThrow(/permission denied/)
    await expect(as({ role: 'authenticated', sub: U_SALES }, `DELETE FROM mail_content_intake`)).rejects.toThrow(/permission denied/)
    await expect(as({ role: 'authenticated', sub: U_SALES },
      `INSERT INTO mail_content_intake (dedupe_key, evidence_id, received_at, status, wait_reason, excerpt) VALUES ('${nextKey()}', ${evId}, now(), 'queued', 'no_match', 'x')`)).rejects.toThrow(/permission denied/)
    // Bez AAL2 nevidí nikdo.
    await db.query('BEGIN')
    try {
      await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role: 'authenticated', sub: U_SALES, aal: 'aal1' })])
      await db.query('SET LOCAL ROLE authenticated')
      expect((await one<{ n: number }>('SELECT count(*)::int AS n FROM mail_content_intake')).n).toBe(0)
    } finally {
      await db.query('ROLLBACK')
    }
  })

  test('audit: stavy a vazby s hodnotou, předmět a úryvek jen názvem sloupce', async () => {
    const id = await insert(
      'status, wait_reason, excerpt, subject, attachment_names, signals, account_id, engagement_id, milestone_id, sender_domain',
      `'queued', 'ambiguous_target', 'Tajný úryvek o Novákovi', 'Tajný předmět', '["smlouva-novak.pdf"]', '{approval,schedule}', ${accountId}, ${engagementId}, ${milestoneId}, 'klient.cz'`)
    const created = await one<{ action: string; after: Row; evidence_id: number | null; entity_id: number }>(
      `SELECT * FROM audit_event WHERE entity_table = 'mail_content_intake' AND entity_id = ${id} ORDER BY id LIMIT 1`)
    expect(created.action).toBe('mail_content_intake.created')
    expect(created.evidence_id).toBe(evId)
    expect(created.after).toMatchObject({ status: 'queued', wait_reason: 'ambiguous_target', account_id: accountId, engagement_id: engagementId, milestone_id: milestoneId })
    expect(created.after.signals).toEqual(['approval', 'schedule'])
    expect(created.after._columns).toEqual(expect.arrayContaining(['subject', 'excerpt', 'attachment_names', 'sender_domain', 'dedupe_key']))
    expect(JSON.stringify(created)).not.toMatch(/Tajný|Novák|smlouva|klient\.cz|sha256/)

    // Zahození: text pryč a audit opět bez textu.
    await db.exec(`UPDATE mail_content_intake SET status = 'discarded', wait_reason = NULL, subject = NULL, excerpt = NULL, attachment_names = '[]', decided_by = 'user:${U_SALES}', decided_at = now() WHERE id = ${id}`)
    const upd = await one<{ action: string; before: Row; after: Row }>(
      `SELECT * FROM audit_event WHERE entity_table = 'mail_content_intake' AND entity_id = ${id} ORDER BY id DESC LIMIT 1`)
    expect(upd.action).toBe('mail_content_intake.updated')
    expect(upd.after).toMatchObject({ status: 'discarded' })
    expect(JSON.stringify(upd)).not.toMatch(/Tajný|Novák/)
  })

  test('purge: čekající po 30 dnech vyprší bez textu, návrh ztratí úryvek po rozhodnutí, čerstvé a čekající zůstanou', async () => {
    const old = "now() - interval '40 days'"
    const oldQueued = await queued('created_at|' + old)
    const freshQueued = await queued()
    const mkProposal = async (status: string, decidedAgo: string | null) =>
      (await one<{ id: number }>(
        `INSERT INTO case_proposal (capability, source_key, occurred_at, node, title, rationale, method, evidence_id, created_by, status, decided_by, decided_at)
         VALUES ('mail_content_approval', '${nextKey()}', now(), 'eventy', 't', 'r', 'rule', ${evId}, 'system:mail_content', '${status}',
                 ${decidedAgo ? "'user:x'" : 'NULL'}, ${decidedAgo ? `now() - interval '${decidedAgo}'` : 'NULL'}) RETURNING id`)).id
    const proposedRow = async (proposalId: number | null, created: string) =>
      insert('status, account_id, excerpt, subject, proposal_id, decided_by, decided_at, created_at',
        `'proposed', ${accountId}, 'Úryvek', 'Předmět', ${proposalId ?? 'NULL'}, 'system:mail_content', now(), ${created}`)
    const decided = await proposedRow(await mkProposal('accepted', '40 days'), old)
    const pending = await proposedRow(await mkProposal('pending', null), old)
    const decidedRecently = await proposedRow(await mkProposal('rejected', '2 days'), old)
    const ancient = await proposedRow(await mkProposal('pending', null), "now() - interval '200 days'")
    const orphan = await proposedRow(null, old)

    const res = await one<{ r: { expired: number; cleared: number } }>('SELECT purge_mail_content_intake() AS r')
    expect(res.r.expired).toBeGreaterThanOrEqual(1)
    const state = async (id: number) => one<{ status: string; excerpt: string | null; subject: string | null }>(
      `SELECT status, excerpt, subject FROM mail_content_intake WHERE id = ${id}`)
    expect(await state(oldQueued)).toEqual({ status: 'expired', excerpt: null, subject: null })
    expect((await state(freshQueued)).status).toBe('queued')
    expect((await state(decided)).excerpt).toBeNull()
    expect((await state(pending)).excerpt).toBe('Úryvek')
    expect((await state(decidedRecently)).excerpt).toBe('Úryvek')
    expect((await state(ancient)).excerpt).toBeNull()
    expect((await state(orphan)).excerpt).toBeNull()
    // Opakovaný běh nic dalšího nemění.
    const again = await one<{ r: { expired: number; cleared: number } }>('SELECT purge_mail_content_intake() AS r')
    expect(again.r).toEqual({ expired: 0, cleared: 0 })
    // Vyprášený řádek dál brání opětovnému načtení téže zprávy (dedupe_key zůstává).
    expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM mail_content_intake WHERE id = ${oldQueued} AND dedupe_key IS NOT NULL`)).n).toBe(1)
  })

  test('purge smí jen server; neplatné lhůty spadnou', async () => {
    await expect(as({ role: 'authenticated', sub: U_SALES }, 'SELECT purge_mail_content_intake()')).rejects.toThrow(/permission denied/)
    await as({ role: 'service_role' }, 'SELECT purge_mail_content_intake()')
    await expect(db.exec('SELECT purge_mail_content_intake(0, 0, 1)')).rejects.toThrow(/neplatné lhůty/)
  })

  test('cizí klíče: smazání dodávky vazbu vynuluje, smazání klienta řádek odstraní', async () => {
    const id = await insert('status, account_id, engagement_id, milestone_id, decided_by, decided_at',
      `'proposed', ${accountId}, ${engagementId}, ${milestoneId}, 'system:x', now()`)
    await db.exec(`DELETE FROM engagement WHERE id = ${engagementId}`)
    expect(await one(`SELECT engagement_id, milestone_id FROM mail_content_intake WHERE id = ${id}`)).toEqual({ engagement_id: null, milestone_id: null })
    await db.exec(`DELETE FROM account WHERE id = ${accountId}`)
    expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM mail_content_intake WHERE id = ${id}`)).n).toBe(0)
  })
})
