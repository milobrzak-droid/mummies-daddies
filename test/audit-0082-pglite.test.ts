// 0082 v opravdovém Postgresu (PGlite = PostgreSQL ve WASM), bez sítě a bez
// živé DB: (A) audit osmi dalších tabulek, který nikdy nezablokuje zápis,
// (B) role Partner bez čtení interní evidence. PGlite je v devDependencies, v bráně (build:release) i v CI běží;
// kdyby chyběl, červeně selže test/pglite-dependency.test.ts.
// Statické kontroly téže migrace běží vždy (test/audit-coverage-0064.test.ts,
// test/hardening-0082.test.ts).
//
// Schéma = test/helpers/auditPgliteSchema.ts + zjednodušené kopie tabulek z
// 0039/0061/0062/0063/0067/0072 a doplněné sloupce team_member (0062, 0069).
// Požadavek PostgRESTu se simuluje transakcí se set_config('request.jwt.claims'
// | 'request.headers') a SET LOCAL ROLE.
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, test } from 'vitest'
import { AUDIT_SCHEMA as SCHEMA, U_API, U_PM, U_SALES } from './helpers/auditPgliteSchema'

type Row = Record<string, unknown>
type Db = {
  exec: (sql: string, opts?: { onNotice?: (n: { severity: string; message: string }) => void }) => Promise<unknown>
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

const U_PARTNER = '44444444-4444-4444-8444-444444444444'
const U_LEKTOR = '55555555-5555-4555-8555-555555555555'
const U_GONE = '66666666-6666-4666-8666-666666666666'
const U_ADMIN_PARTNER = '77777777-7777-4777-8777-777777777777'

// Doplněk schématu: sloupce team_member a tabulky, které 0082 napojuje.
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

// Politiky jako v produkci: čtení a zápis podle is_team_member() (0003), vlastní
// řádek team_member až od 0082 (proto se politika team_self_read zakládá v migraci).
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

type Audit = {
  id: number
  actor_type: string
  actor_id: string | null
  action: string
  entity_table: string
  entity_id: number | null
  entity_ref: string | null
  before: Row | null
  after: Row | null
  evidence_id: number | null
  info_state: string | null
}

describe.skipIf(!PGliteCtor)('0082 v Postgresu (PGlite)', () => {
  let db: Db
  const notices: string[] = []
  const run = (sql: string) => db.exec(sql, { onNotice: (n) => notices.push(`${n.severity}: ${n.message}`) })

  async function as(
    who: { role: 'authenticated' | 'service_role' | 'postgres'; sub?: string; headers?: Record<string, string> },
    sql: string,
  ) {
    const claims = who.role === 'postgres' ? null : JSON.stringify({ role: who.role, aal: 'aal2', ...(who.sub ? { sub: who.sub } : {}) })
    const prefix = [
      'BEGIN;',
      claims ? `SELECT set_config('request.jwt.claims', '${claims}', true);` : '',
      who.headers ? `SELECT set_config('request.headers', '${JSON.stringify(who.headers)}', true);` : '',
      who.role === 'postgres' ? '' : `SET LOCAL ROLE ${who.role};`,
    ].join('\n')
    try {
      await run(`${prefix}\n${sql}\nCOMMIT;`)
    } catch (e) {
      await db.exec('ROLLBACK').catch(() => undefined)
      throw e
    }
  }

  // Čtení jako přihlášený člen (RLS platí): počet řádků z dotazu.
  async function countAs(sub: string, table: string, where = 'true'): Promise<number> {
    await db.query('BEGIN')
    try {
      await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role: 'authenticated', sub, aal: 'aal2' })])
      await db.query('SET LOCAL ROLE authenticated')
      return (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`)).rows[0].n
    } finally {
      await db.query('ROLLBACK')
    }
  }
  async function fnAs(sub: string, fn: string): Promise<boolean> {
    await db.query('BEGIN')
    try {
      await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role: 'authenticated', sub, aal: 'aal2' })])
      await db.query('SET LOCAL ROLE authenticated')
      return (await db.query<{ v: boolean }>(`SELECT ${fn} AS v`)).rows[0].v
    } finally {
      await db.query('ROLLBACK')
    }
  }
  const last = async (table: string) =>
    (await db.query<Audit>('select * from audit_event where entity_table = $1 order by id desc limit 1', [table])).rows[0]
  const count = async (where = 'true') =>
    (await db.query<{ n: number }>(`select count(*)::int as n from audit_event where ${where}`)).rows[0].n

  let accountId = 0
  let engId = 0
  let evId = 0

  beforeAll(async () => {
    db = new PGliteCtor!()
    await run(SCHEMA)
    await run(EXTRA)
    await run(M0035)
    await run(M0064)
    await run(RLS)
    await run(M0082)
    notices.length = 0
    await run(M0082) // idempotence
    await run(`INSERT INTO evidence (source_kind, source_id) VALUES ('meeting', 'e1')`)
    evId = (await db.query<{ id: number }>(`select id from evidence limit 1`)).rows[0].id
    await as({ role: 'authenticated', sub: U_SALES }, `INSERT INTO account (name) VALUES ('Firma');`)
    accountId = (await last('account')).entity_id!
    await as({ role: 'authenticated', sub: U_PM }, `INSERT INTO engagement (account_id, kind) VALUES (${accountId}, 'edu');`)
    engId = (await last('engagement')).entity_id!
  }, 90_000)

  test('idempotence: druhý běh nezdvojí triggery ani ledger, žádné varování o sloupci', async () => {
    expect((await db.query<{ n: number }>(`select count(*)::int as n from pg_trigger where tgname = 'audit_row_change_soft'`)).rows[0].n).toBe(8)
    expect((await db.query<{ n: number }>(`select count(*)::int as n from pg_trigger where tgname = 'audit_row_change'`)).rows[0].n).toBe(21)
    expect((await db.query<{ n: number }>(`select count(*)::int as n from schema_migration where version = '0082'`)).rows[0].n).toBe(1)
    expect(notices.filter((n) => n.startsWith('WARNING'))).toEqual([])
  })

  test('audit řádek vzniká: allocation vytvořená člověkem, poznámka jen názvem sloupce', async () => {
    await as({ role: 'authenticated', sub: U_PM },
      `INSERT INTO allocation (member_id, engagement_id, hours_per_week, starts_on, note, created_by)
       VALUES ('${U_LEKTOR}', ${engId}, 8, '2026-10-01', 'tajná poznámka o Novákovi', '${U_PM}');`)
    const a = await last('allocation')
    expect(a).toMatchObject({ action: 'allocation.created', actor_type: 'user', actor_id: U_PM, info_state: 'human_confirmed', entity_ref: null, before: null })
    expect(a.entity_id).toBeGreaterThan(0)
    expect(a.after).toMatchObject({ member_id: U_LEKTOR, engagement_id: engId, hours_per_week: 8 })
    expect(a.after!._columns).toContain('note')
    expect(JSON.stringify(a)).not.toMatch(/Novák|tajná/)
  })

  test('citlivá pole nejsou v auditu: finance (číslo dokladu, poznámka), metrika, návrh, rozsah nabídky', async () => {
    await as({ role: 'authenticated', sub: U_SALES },
      `INSERT INTO financial_record (account_id, kind, amount, period_month, status, source, external_ref, note, evidence_id)
       VALUES (${accountId}, 'invoiced', 15000, '2026-10-01', 'confirmed', 'ucetnictvi', 'FA-2026-0042', 'faktura pro paní Dvořákovou', ${evId});`)
    const f = await last('financial_record')
    expect(f).toMatchObject({ action: 'financial_record.created', evidence_id: evId })
    expect(f.after).toMatchObject({ amount: 15000, kind: 'invoiced', status: 'confirmed', account_id: accountId })
    expect(JSON.stringify(f)).not.toMatch(/FA-2026|Dvořák/)
    expect(f.after!._columns).toEqual(expect.arrayContaining(['external_ref', 'note']))

    await as({ role: 'authenticated', sub: U_PM },
      `INSERT INTO metric_observation (engagement_id, metric, unit, baseline, actual, observed_on, note, evidence_id)
       VALUES (${engId}, 'Čas na report Nováková', 'minut', 60, 20, '2026-10-02', 'zákazník Svoboda', ${evId});`)
    const m = await last('metric_observation')
    expect(m.after).toMatchObject({ baseline: 60, actual: 20, engagement_id: engId })
    expect(JSON.stringify(m)).not.toMatch(/Nováková|Svoboda|minut/)

    await as({ role: 'service_role', headers: { 'x-cockpit-audit-actor': `api_key:${U_API}` } },
      `INSERT INTO loop_node (node, owner_id) VALUES ('obchod', '${U_SALES}');
       INSERT INTO case_proposal (capability, source_key, occurred_at, node, title, rationale, steps, method, evidence_id, created_by)
       VALUES ('mail_followup', 'AAMk-tajne-id-zpravy', now(), 'obchod', 'Odpovědět panu Černému', 'Klient Černý čeká', '[{"t":"zavolat"}]', 'rule', ${evId}, 'system');`)
    const p = await last('case_proposal')
    expect(p).toMatchObject({ action: 'case_proposal.created', actor_type: 'api_key', actor_id: U_API, evidence_id: evId })
    expect(p.after).toMatchObject({ status: 'pending', method: 'rule', info_state: 'ai_suggestion' })
    expect(JSON.stringify(p)).not.toMatch(/Černý|Černému|AAMk|zavolat/)

    await as({ role: 'authenticated', sub: U_SALES },
      `INSERT INTO deal (account_id, title) VALUES (${accountId}, 'Obchod');`)
    const dealId = (await last('deal')).entity_id ?? 1
    await as({ role: 'authenticated', sub: U_SALES },
      `INSERT INTO deal_scope_version (deal_id, version, scope, amount_one_time, status)
       VALUES (${dealId}, 1, 'Školení pro firmu Krejčí a syn', 90000, 'draft');`)
    const s = await last('deal_scope_version')
    expect(s.after).toMatchObject({ amount_one_time: 90000, status: 'draft', version: 1 })
    expect(JSON.stringify(s)).not.toMatch(/Krejčí|Školení/)
  })

  test('klíč jiného tvaru: deal_partner a loop_node mají entity_ref, entity_id je NULL', async () => {
    await as({ role: 'authenticated', sub: U_SALES },
      `INSERT INTO deal_partner (deal_id, partner_id, program, attribution_pct, is_sourcing) VALUES (7, 3, 'microsoft', 30, true);`)
    expect(await last('deal_partner')).toMatchObject({ action: 'deal_partner.created', entity_id: null, entity_ref: '7:3:microsoft' })
    await as({ role: 'authenticated', sub: U_SALES }, `DELETE FROM deal_partner WHERE deal_id = 7;`)
    expect(await last('deal_partner')).toMatchObject({ action: 'deal_partner.deleted', entity_ref: '7:3:microsoft', after: null })
    await as({ role: 'service_role', headers: { 'x-cockpit-audit-actor': `user:${U_SALES}` } },
      `UPDATE loop_node SET deputy_id = '${U_PM}' WHERE node = 'obchod';`)
    const n = await last('loop_node')
    expect(n).toMatchObject({ action: 'loop_node.updated', entity_id: null, entity_ref: 'obchod', actor_id: U_SALES })
    expect(n.after).toEqual({ deputy_id: U_PM, _columns: ['deputy_id'] })
  })

  test('team_member: změna role, admina a deaktivace s aktérem; e-mail a jméno v auditu nikdy', async () => {
    const hdr = { 'x-cockpit-audit-actor': `user:${U_API}` }
    await as({ role: 'service_role', headers: hdr }, `UPDATE team_member SET role = 'vedeni', is_admin = true WHERE id = '${U_LEKTOR}';`)
    const r = await last('team_member')
    expect(r).toMatchObject({ action: 'team_member.updated', entity_id: null, entity_ref: U_LEKTOR, actor_type: 'user', actor_id: U_API })
    expect(r.before).toEqual({ is_admin: false, role: 'lektor' })
    expect(r.after).toEqual({ is_admin: true, role: 'vedeni', _columns: ['is_admin', 'role'] })

    await as({ role: 'service_role', headers: hdr }, `UPDATE team_member SET deactivated_at = '2026-10-05T10:00:00Z', is_admin = false WHERE id = '${U_LEKTOR}';`)
    expect((await last('team_member')).after).toMatchObject({ is_admin: false, _columns: ['deactivated_at', 'is_admin'] })

    const before = await count(`entity_table = 'team_member'`)
    await as({ role: 'service_role', headers: hdr }, `UPDATE team_member SET full_name = 'Nové Jméno', weekly_capacity_hours = 20 WHERE id = '${U_LEKTOR}';`)
    expect(await count(`entity_table = 'team_member'`)).toBe(before) // ignorované sloupce

    await as({ role: 'service_role', headers: hdr }, `UPDATE team_member SET email = 'novy.tajny@enter.cz' WHERE id = '${U_LEKTOR}';`)
    const e = await last('team_member')
    expect(e.after).toEqual({ _columns: ['email'] })
    expect(e.before).toEqual({})
    expect(JSON.stringify(e)).not.toMatch(/tajny|enter\.cz/)
    await as({ role: 'service_role', headers: hdr }, `UPDATE team_member SET role = 'lektor', is_admin = false, deactivated_at = NULL, email = 'x@example.cz' WHERE id = '${U_LEKTOR}';`)

    await as({ role: 'service_role' }, `UPDATE team_member SET manager_id = '${U_SALES}' WHERE id = '${U_PM}';`)
    expect(await last('team_member')).toMatchObject({ actor_type: 'system', actor_id: 'db-trigger:service_role', entity_ref: U_PM })
  })

  test('chyba zápisu do audit_event NEzablokuje původní zápis (jen varování), tvrdý trigger 0064 ano', async () => {
    await run(`ALTER TABLE audit_event ADD CONSTRAINT test_boom CHECK (action NOT IN ('allocation.created', 'account.created')) NOT VALID`)
    try {
      notices.length = 0
      const before = await count()
      await as({ role: 'authenticated', sub: U_PM },
        `INSERT INTO allocation (member_id, engagement_id, hours_per_week, starts_on) VALUES ('${U_PM}', ${engId}, 4, '2026-11-01');`)
      expect((await db.query<{ n: number }>(`select count(*)::int as n from allocation where hours_per_week = 4`)).rows[0].n).toBe(1)
      expect(await count()).toBe(before) // změna prošla bez auditní stopy
      const warn = notices.filter((n) => n.startsWith('WARNING'))
      expect(warn).toHaveLength(1)
      expect(warn[0]).toMatch(/0082: audit INSERT na allocation selhal \(SQLSTATE 23514\)/)
      expect(warn[0]).not.toMatch(/allocation\.created|Failing row/) // bez dat řádku

      // Kontrast: 0064 (tvrdý režim) zápis shodí — záměr té migrace, tady se nemění.
      await expect(as({ role: 'authenticated', sub: U_SALES }, `INSERT INTO account (name) VALUES ('Nepovedená');`)).rejects.toThrow(/test_boom/)
    } finally {
      await run(`ALTER TABLE audit_event DROP CONSTRAINT test_boom`)
    }
  })

  test('DELETE na kaskádě nechá stopu; audit_event nese CHECK proti řádku bez klíče', async () => {
    await expect(run(`INSERT INTO audit_event (actor_type, action, entity_table) VALUES ('system', 'x.created', 'x');`)).rejects.toThrow(/audit_event_entity_check/)
    const before = await count(`action = 'allocation.deleted'`)
    await as({ role: 'postgres' }, `DELETE FROM allocation WHERE hours_per_week = 4;`)
    expect(await count(`action = 'allocation.deleted'`)).toBe(before + 1)
  })

  test('historie částek a rozsahu nabídky jen pro obchodní role; ostatní entity beze změny', async () => {
    const seen = (sub: string, where: string) => countAs(sub, 'audit_event', where)
    expect(await seen(U_SALES, `entity_table IN ('financial_record', 'deal_scope_version')`)).toBeGreaterThan(0)
    expect(await seen(U_PM, `entity_table IN ('financial_record', 'deal_scope_version')`)).toBe(0)
    expect(await seen(U_PM, `entity_table = 'allocation'`)).toBe(await seen(U_SALES, `entity_table = 'allocation'`))
    expect(await seen(U_PM, `entity_table = 'allocation'`)).toBeGreaterThan(0)
  })

  test('Partner nic nepřečte: helpery false, RLS tabulek prázdné, zápis odmítnut, vlastní řádek team_member ano', async () => {
    expect(await fnAs(U_PARTNER, 'is_team_member()')).toBe(false)
    expect(await fnAs(U_PARTNER, 'is_admin()')).toBe(false)
    expect(await fnAs(U_ADMIN_PARTNER, 'is_admin()')).toBe(false) // příznak admina u externího účtu nic nedává
    expect(await fnAs(U_PARTNER, 'can_see_sales()')).toBe(false)

    for (const t of ['account', 'task', 'allocation', 'audit_event']) expect(await countAs(U_PARTNER, t), t).toBe(0)
    expect(await countAs(U_PARTNER, 'team_member')).toBe(1)
    expect(await countAs(U_PARTNER, 'team_member', `id = '${U_PARTNER}'`)).toBe(1)

    await expect(as({ role: 'authenticated', sub: U_PARTNER }, `INSERT INTO task (title) VALUES ('x');`)).rejects.toThrow(/row-level security/)
    await expect(as({ role: 'authenticated', sub: U_PARTNER }, `INSERT INTO account (name) VALUES ('x');`)).rejects.toThrow(/row-level security/)
    // UPDATE/DELETE bez viditelných řádků nic nezmění.
    await as({ role: 'authenticated', sub: U_PARTNER }, `UPDATE account SET name = 'hacked'; DELETE FROM task;`)
    expect((await db.query<{ n: number }>(`select count(*)::int as n from account where name = 'hacked'`)).rows[0].n).toBe(0)
  })

  test('ostatní role beze změny: vedení, obchodník, projektak, lektor čtou; deaktivovaný ne', async () => {
    // U_LEKTOR se v testu výše vrátil na roli lektor a aktivní stav.
    for (const sub of [U_API, U_SALES, U_PM, U_LEKTOR]) {
      expect(await fnAs(sub, 'is_team_member()'), sub).toBe(true)
      expect(await countAs(sub, 'account'), sub).toBeGreaterThan(0)
      expect(await countAs(sub, 'team_member'), sub).toBeGreaterThan(3)
    }
    expect(await fnAs(U_GONE, 'is_team_member()')).toBe(false)
    expect(await countAs(U_GONE, 'account')).toBe(0)
    expect(await fnAs(U_SALES, 'can_see_sales()')).toBe(true)
    await as({ role: 'authenticated', sub: U_PM }, `INSERT INTO task (title) VALUES ('projekťák píše dál');`)
  })

  test('guard: bez prerekvizit srozumitelná chyba', async () => {
    const empty = new PGliteCtor!()
    await expect(empty.exec(M0082)).rejects.toThrow(/nejdřív aplikujte 0028_audit_event\.sql/)
  }, 60_000)
})
