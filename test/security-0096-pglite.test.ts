// 0096 (druhé kolo bezpečnostních oprav) v opravdovém Postgresu (PGlite =
// PostgreSQL ve WASM), bez sítě a bez živé DB. PGlite je devDependency
// (test/pglite-dependency.test.ts hlídá, že nechybí).
//
// Pokryto: D2 (tvrdý audit team_member a loop_node, ostatní měkké), D5 (strážce
// rozdílů iDokladu bez NULL), D6 (touch_changes_view jen aktivní interní člen),
// D7 (REVOKE vnitřních funkcí a tabulek), N1 (api_request_hit), N7
// (oauth_client.approved_at a oauth_client_register), D8 (politika úložiště, samostatná
// databáze). Část D3 (auto_intake_dismiss) hlídá
// test/intake-not-inquiry-0086-pglite.test.ts.
//
// Schéma = test/helpers/auditPgliteSchema.ts + skutečné 0035 (bez kontrol), 0064,
// 0082, 0075, 0018, 0083 a výřez 0092 (tabulka rozdílů a strážce); stuby jen tam,
// kde 0096 vyžaduje existenci objektu z migrace, kterou tenhle test nenačítá.
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, test, vi } from 'vitest'
import { AUDIT_SCHEMA as SCHEMA, U_API, U_PM, U_SALES } from './helpers/auditPgliteSchema'
import { AUDIT_FAIL_CLOSED_TABLES } from '@/core/auditCoverage'

vi.setConfig({ testTimeout: 90_000, hookTimeout: 180_000 })

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

const mig = (f: string) => readFileSync(`supabase/migrations/${f}`, 'utf8')
const M0035 = mig('0035_deal_audit_hardening.sql')
  .replace(/DO \$\$\nDECLARE\n  v_sig text;[\s\S]*?END \$\$;/, '')
  .replace(/INSERT INTO schema_migration[\s\S]*$/, '')
const M0064 = mig('0064_audit_coverage.sql')
const M0082 = mig('0082_audit_gaps_partner_lockdown.sql')
const M0075 = mig('0075_changes_view.sql')
const M0018 = mig('0018_oauth.sql')
const M0083 = mig('0083_oauth_refresh_token.sql')
const M0096 = mig('0096_security_round2.sql')
const M0092 = mig('0092_idoklad_sync.sql')
const M0092_DISCREPANCY = M0092.slice(
  M0092.indexOf('CREATE TABLE IF NOT EXISTS idoklad_discrepancy ('),
  M0092.indexOf("INSERT INTO schema_migration (version, note)\nVALUES ('0092'"),
)

const U_PARTNER = '44444444-4444-4444-8444-444444444444'
const U_LEKTOR = '55555555-5555-4555-8555-555555555555'
const U_GONE = '66666666-6666-4666-8666-666666666666'

const EXTRA = `
ALTER ROLE service_role BYPASSRLS;
ALTER TABLE team_member ADD COLUMN email text, ADD COLUMN is_admin boolean NOT NULL DEFAULT false,
  ADD COLUMN manager_id uuid, ADD COLUMN deactivated_at timestamptz, ADD COLUMN weekly_capacity_hours numeric DEFAULT 40;
UPDATE team_member SET email = 'x@example.cz';
INSERT INTO team_member (id, role, full_name, email) VALUES
  ('${U_PARTNER}', 'partner', 'Externí Partner', 'partner@firma.cz'),
  ('${U_LEKTOR}', 'lektor', 'Lektor', 'lektor@enter.cz');
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
-- Stuby objektů z migrací, které tenhle test nenačítá (0096 je vyžaduje):
CREATE TABLE api_key (id bigserial PRIMARY KEY, name text NOT NULL, key_hash text, created_by uuid, scope text NOT NULL DEFAULT 'read', revoked_at timestamptz, expires_at timestamptz);
CREATE TABLE api_request (id bigserial PRIMARY KEY, key_id bigint NOT NULL REFERENCES api_key(id) ON DELETE CASCADE, path text NOT NULL, at timestamptz NOT NULL DEFAULT now());
CREATE FUNCTION loop_actor() RETURNS text LANGUAGE sql AS $$ SELECT 'user:stub' $$;
CREATE TABLE auto_intake (id bigserial PRIMARY KEY, status text, account_id bigint, deal_id bigint, task_id bigint, decided_by text, decided_at timestamptz);
CREATE FUNCTION auto_intake_dismiss(p_id bigint) RETURNS jsonb LANGUAGE sql AS $$ SELECT '{}'::jsonb $$;
-- Vnitřní funkce, které 0096 zamyká (v produkci mají výchozí grant Supabase).
CREATE FUNCTION financial_record_due_guard() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$;
CREATE FUNCTION auto_delivery_add_working_days(p_from date, p_days integer) RETURNS date LANGUAGE sql AS $$ SELECT p_from + p_days $$;
CREATE FUNCTION auto_delivery_template_key(a text, b text) RETURNS text LANGUAGE sql AS $$ SELECT a || b $$;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated, service_role, anon;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO authenticated, service_role, anon;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO anon, authenticated, service_role;
`
const RLS = `
ALTER TABLE account ENABLE ROW LEVEL SECURITY;
CREATE POLICY account_all ON account FOR ALL USING (is_team_member()) WITH CHECK (is_team_member());
ALTER TABLE team_member ENABLE ROW LEVEL SECURITY;
CREATE POLICY team_read ON team_member FOR SELECT USING (is_team_member());
`

describe.skipIf(!PGliteCtor)('0096 v Postgresu (PGlite)', () => {
  let db: Db
  const notices: string[] = []
  const run = (sql: string) => db.exec(sql, { onNotice: (n) => notices.push(`${n.severity}: ${n.message}`) })

  async function as(
    who: { role: 'authenticated' | 'service_role' | 'postgres'; sub?: string; aal?: string; headers?: Record<string, string> },
    sql: string,
  ) {
    const claims = who.role === 'postgres' ? null : JSON.stringify({ role: who.role, aal: who.aal ?? 'aal2', ...(who.sub ? { sub: who.sub } : {}) })
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
  const svc = (sql: string, actor = `user:${U_API}`) => as({ role: 'service_role', headers: { 'x-cockpit-audit-actor': actor } }, sql)
  const one = async <T = Row>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows[0]
  const count = async (where = 'true') => (await one<{ n: number }>(`select count(*)::int as n from audit_event where ${where}`)).n

  async function scalarAs(role: 'authenticated' | 'service_role', sub: string | null, sql: string, aal = 'aal2') {
    await db.query('BEGIN')
    try {
      await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role, aal, ...(sub ? { sub } : {}) })])
      await db.query(`SET LOCAL ROLE ${role}`)
      return (await db.query<{ v: unknown }>(`SELECT ${sql} AS v`)).rows[0].v
    } finally {
      await db.query('ROLLBACK')
    }
  }

  const CLIENT_A = 'cockpit-client_aaaaaaaaaaaaaaaaaaaaaa' // má refresh token
  const CLIENT_B = 'cockpit-client_bbbbbbbbbbbbabc123' // má klíč konektoru s koncovkou (abc123)
  const CLIENT_C = 'cockpit-client_cccccccccccccccccccccc' // nikdy neschválený

  beforeAll(async () => {
    db = new PGliteCtor!()
    await run(SCHEMA)
    await run(EXTRA)
    await run(M0035)
    await run(M0064)
    await run(RLS)
    await run(M0082)
    await run(M0075)
    await run(M0018.replace(/api_key_id\s+bigint NOT NULL REFERENCES api_key\(id\) ON DELETE CASCADE,/, 'api_key_id bigint REFERENCES api_key(id) ON DELETE CASCADE,'))
    await run(M0083)
    await run(M0092_DISCREPANCY)
    // Klienti před migrací: A má refresh token, B klíč konektoru, C nic.
    await run(`
      INSERT INTO oauth_client (client_id, client_name, redirect_uris) VALUES
        ('${CLIENT_A}', 'Claude A', ARRAY['https://claude.ai/cb']),
        ('${CLIENT_B}', 'Claude B', ARRAY['https://claude.ai/cb']),
        ('${CLIENT_C}', 'Cizí', ARRAY['https://claude.ai/cb']);
      INSERT INTO oauth_refresh_token (token_hash, family_id, client_id, approved_by, expires_at)
        VALUES ('h1', gen_random_uuid(), '${CLIENT_A}', '${U_SALES}', now() + interval '30 days');
      INSERT INTO api_key (name, key_hash, created_by) VALUES ('OAuth · Claude B (abc123)', 'h2', '${U_SALES}');
    `)
    await run(`INSERT INTO schema_migration (version, note) VALUES ('0095', 'stub')`)
    notices.length = 0
    await run(M0096)
    const first = [...notices]
    notices.length = 0
    await run(M0096) // idempotence
    expect(first.filter((n) => n.startsWith('WARNING'))).toEqual([])
    expect(notices.filter((n) => n.startsWith('WARNING'))).toEqual([])
    await run(`INSERT INTO evidence (source_kind, source_id) VALUES ('meeting', 'e1')`)
  })

  test('idempotence: ledger jednou, tvrdý režim jen na dvou tabulkách, triggery beze změny', async () => {
    expect((await one<{ n: number }>(`select count(*)::int as n from schema_migration where version = '0096'`)).n).toBe(1)
    expect((await one<{ n: number }>(`select count(*)::int as n from pg_trigger where tgname = 'audit_row_change_soft'`)).n).toBe(9) // 8 z 0082 + idoklad_discrepancy z 0092
    const fn = await one<{ secdef: boolean; acl: string | null; cfg: string[] }>(
      `select prosecdef as secdef, proacl::text as acl, proconfig as cfg from pg_proc where proname = 'audit_row_change_soft'`)
    expect(fn.secdef).toBe(true)
    expect(fn.cfg).toEqual(['search_path=public, pg_temp'])
    for (const role of ['anon', 'authenticated']) {
      expect((await one<{ v: boolean }>(`select has_function_privilege('${role}', 'audit_row_change_soft()', 'EXECUTE') as v`)).v, role).toBe(false)
    }
  })

  describe('D2: tvrdý audit oprávnění a obsazení uzlů', () => {
    test('registr ve zdrojáku sedí s v_strict v migraci', () => {
      const m = /v_strict boolean := TG_TABLE_SCHEMA = 'public' AND TG_TABLE_NAME = ANY \(ARRAY\[([^\]]+)\]\)/.exec(M0096)
      expect(m).not.toBeNull()
      const inSql = [...m![1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort()
      expect([...AUDIT_FAIL_CLOSED_TABLES].sort()).toEqual(inSql)
    })

    test('normální změna role a admina projde a zanechá auditní řádek s aktérem', async () => {
      const before = await count(`entity_table = 'team_member'`)
      await svc(`UPDATE team_member SET role = 'obchodnik', is_admin = true WHERE id = '${U_LEKTOR}';`)
      expect(await count(`entity_table = 'team_member'`)).toBe(before + 1)
      const e = await one<{ action: string; actor_id: string; after: Row }>(`select * from audit_event where entity_table = 'team_member' order by id desc limit 1`)
      expect(e).toMatchObject({ action: 'team_member.updated', actor_id: U_API })
      expect(e.after).toMatchObject({ role: 'obchodnik', is_admin: true })
      await svc(`UPDATE team_member SET role = 'lektor', is_admin = false WHERE id = '${U_LEKTOR}';`)
    })

    test('selže-li zápis auditu, změna role, admina i deaktivace se ZRUŠÍ (AU001), bez dat řádku v chybě', async () => {
      await run(`ALTER TABLE audit_event ADD CONSTRAINT test_boom CHECK (action NOT IN ('team_member.updated', 'team_member.created', 'team_member.deleted', 'loop_node.created', 'loop_node.updated')) NOT VALID`)
      try {
        for (const sql of [
          `UPDATE team_member SET role = 'vedeni' WHERE id = '${U_LEKTOR}';`,
          `UPDATE team_member SET is_admin = true WHERE id = '${U_LEKTOR}';`,
          `UPDATE team_member SET deactivated_at = now() WHERE id = '${U_LEKTOR}';`,
        ]) {
          await expect(svc(sql)).rejects.toThrow(/0096: audit UPDATE na team_member selhal \(SQLSTATE 23514\)/)
        }
        const me = await one<{ role: string; is_admin: boolean; deactivated_at: string | null }>(`select role, is_admin, deactivated_at from team_member where id = '${U_LEKTOR}'`)
        expect(me).toEqual({ role: 'lektor', is_admin: false, deactivated_at: null })

        // Chybová zpráva nenese hodnoty řádku (e-mail, jméno, uuid).
        const err = await svc(`UPDATE team_member SET role = 'vedeni' WHERE id = '${U_LEKTOR}';`).catch((e: Error) => e)
        expect(String((err as Error).message)).not.toMatch(/lektor@enter\.cz|Lektor|Failing row|test_boom/)
        expect((err as { code?: string }).code).toBe('AU001')

        // Insert a delete: stejně.
        await expect(svc(`INSERT INTO team_member (id, role, full_name) VALUES ('77777777-7777-4777-8777-777777777777', 'partner', 'Nový');`)).rejects.toThrow(/AU001|0096: audit INSERT na team_member/)
        expect((await one<{ n: number }>(`select count(*)::int as n from team_member where id = '77777777-7777-4777-8777-777777777777'`)).n).toBe(0)

        // Obsazení uzlů Loop Core: stejně.
        await expect(svc(`INSERT INTO loop_node (node, owner_id) VALUES ('test_uzel', '${U_SALES}');`)).rejects.toThrow(/0096: audit INSERT na loop_node selhal/)
        expect((await one<{ n: number }>(`select count(*)::int as n from loop_node where node = 'test_uzel'`)).n).toBe(0)
      } finally {
        await run(`ALTER TABLE audit_event DROP CONSTRAINT test_boom`)
      }
    })

    test('ostatní měkké tabulky zůstávají měkké: chyba auditu jen varuje, změna projde', async () => {
      await run(`ALTER TABLE audit_event ADD CONSTRAINT test_boom2 CHECK (action <> 'allocation.created') NOT VALID`)
      try {
        notices.length = 0
        await as({ role: 'authenticated', sub: U_PM }, `INSERT INTO allocation (member_id, hours_per_week, starts_on) VALUES ('${U_PM}', 4, '2026-11-01');`)
        expect((await one<{ n: number }>(`select count(*)::int as n from allocation`)).n).toBe(1)
        const warn = notices.filter((n) => n.startsWith('WARNING'))
        expect(warn).toHaveLength(1)
        expect(warn[0]).toMatch(/0082: audit INSERT na allocation selhal \(SQLSTATE 23514\)/)
      } finally {
        await run(`ALTER TABLE audit_event DROP CONSTRAINT test_boom2`)
      }
    })

    test('trigger na tvrdé tabulce musí existovat: bez něj migrace skončí chybou, ne tichým přeskočením', async () => {
      await run(`ALTER TABLE loop_node DISABLE TRIGGER audit_row_change_soft`)
      try {
        await expect(run(M0096)).rejects.toThrow(/na tabulce loop_node chybí \(nebo je vypnutý\) trigger audit_row_change_soft/)
      } finally {
        await run(`ALTER TABLE loop_node ENABLE TRIGGER audit_row_change_soft`)
      }
    })
  })

  describe('D5: uzavření rozdílu z iDokladu jen platnou dvojicí', () => {
    let ids: number[] = []
    beforeAll(async () => {
      await run(`INSERT INTO account (name) VALUES ('Klient') ON CONFLICT DO NOTHING`)
      const acc = (await one<{ id: number }>('select id from account limit 1')).id
      for (let i = 1; i <= 5; i++) {
        await svc(`INSERT INTO idoklad_discrepancy (kind, reason, idoklad_kind, idoklad_id, account_id, fingerprint)
          VALUES ('invoice_without_record', 'test ${i}', 'invoice', ${i}, ${acc}, 'fp${i}');`, 'system:job:idoklad-sync')
      }
      ids = (await db.query<{ id: number }>('select id from idoklad_discrepancy order by id')).rows.map((r) => r.id)
    })
    const closeAs = (id: number, set: string) => as({ role: 'authenticated', sub: U_SALES }, `UPDATE idoklad_discrepancy SET ${set} WHERE id = ${id};`)
    const state = (id: number) => one<{ status: string; resolution: string | null; resolved_by: string | null }>(
      `select status, resolution, resolved_by from idoklad_discrepancy where id = ${id}`)

    test.each([
      ['resolved bez resolution (NULL)', `status = 'resolved'`],
      ['dismissed bez resolution (NULL)', `status = 'dismissed'`],
      ['resolved s resolution dismissed', `status = 'resolved', resolution = 'dismissed'`],
      ['dismissed s resolution applied', `status = 'dismissed', resolution = 'applied'`],
      ['resolution auto od člověka', `status = 'resolved', resolution = 'auto'`],
    ])('%s se odmítne', async (_n, set) => {
      await expect(closeAs(ids[0], set)).rejects.toThrow(/Rozdíl lze uzavřít jako vyřešený \(applied\) nebo odložený \(dismissed\)/)
      expect(await state(ids[0])).toEqual({ status: 'open', resolution: null, resolved_by: null })
    })

    test('platné dvojice projdou a nesou kdo a kdy', async () => {
      await closeAs(ids[1], `status = 'resolved', resolution = 'applied'`)
      await closeAs(ids[2], `status = 'dismissed', resolution = 'dismissed', resolution_note = 'Neřešit'`)
      expect(await state(ids[1])).toEqual({ status: 'resolved', resolution: 'applied', resolved_by: U_SALES })
      expect(await state(ids[2])).toEqual({ status: 'dismissed', resolution: 'dismissed', resolved_by: U_SALES })
    })

    test('servisní zápis úlohy (automatické uzavření) omezení nemá', async () => {
      await svc(`UPDATE idoklad_discrepancy SET status = 'resolved', resolution = 'auto', resolved_at = now() WHERE id = ${ids[3]};`, 'system:job:idoklad-sync')
      expect((await state(ids[3])).resolution).toBe('auto')
    })

    test('uzavřený rozdíl člověk znovu neotevře a nepřepíše', async () => {
      await expect(closeAs(ids[1], `status = 'open', resolution = NULL, resolved_at = NULL`)).rejects.toThrow()
      await expect(closeAs(ids[1], `resolution_note = 'jiné'`)).rejects.toThrow(/nemění/)
    })
  })

  describe('D6: touch_changes_view jen aktivní interní člen', () => {
    const touch = (sub: string, aal = 'aal2') => scalarAs('authenticated', sub, 'to_jsonb((SELECT t FROM touch_changes_view() t))', aal)

    test('aktivní interní člen projde, zápis nese jeho id', async () => {
      await as({ role: 'authenticated', sub: U_PM }, `SELECT * FROM touch_changes_view();`)
      expect((await one<{ n: number }>(`select count(*)::int as n from changes_view where member_id = '${U_PM}'`)).n).toBe(1)
    })

    test.each([
      ['partner (externí účet)', U_PARTNER],
      ['deaktivovaný člen', U_GONE],
      ['nečlen', '99999999-9999-4999-8999-999999999999'],
    ])('%s dostane 42501 a nic nezapíše', async (_n, sub) => {
      await expect(touch(sub)).rejects.toThrow(/jen aktivní člen týmu|42501/)
      expect((await one<{ n: number }>(`select count(*)::int as n from changes_view where member_id = '${sub}'`)).n).toBe(0)
    })

    test('bez AAL2 se odmítne', async () => {
      await expect(touch(U_SALES, 'aal1')).rejects.toThrow(/AAL2/)
    })

    test('práva zůstala: jen authenticated smí volat', async () => {
      expect((await one<{ v: boolean }>(`select has_function_privilege('authenticated', 'touch_changes_view()', 'EXECUTE') as v`)).v).toBe(true)
      expect((await one<{ v: boolean }>(`select has_function_privilege('anon', 'touch_changes_view()', 'EXECUTE') as v`)).v).toBe(false)
    })
  })

  describe('D7: vnitřní funkce a tabulky bez práv pro klientské role', () => {
    test.each([
      'financial_record_due_guard()',
      'auto_delivery_add_working_days(date, integer)',
      'auto_delivery_template_key(text, text)',
      'idoklad_discrepancy_guard()',
    ])('%s: EXECUTE jen pro vlastníka a service_role stejně nemusí', async (sig) => {
      for (const role of ['anon', 'authenticated']) {
        expect((await one<{ v: boolean }>(`select has_function_privilege('${role}', '${sig}', 'EXECUTE') as v`)).v, `${role} ${sig}`).toBe(false)
      }
    })

    test('anon nemá právo na interní tabulky, authenticated zůstává (řídí ho politiky)', async () => {
      for (const table of ['idoklad_discrepancy', 'changes_view', 'auto_intake']) {
        expect((await one<{ v: boolean }>(`select has_table_privilege('anon', '${table}', 'SELECT') as v`)).v, table).toBe(false)
      }
      expect((await one<{ v: boolean }>(`select has_table_privilege('authenticated', 'idoklad_discrepancy', 'SELECT') as v`)).v).toBe(true)
    })

    test('nikdo z klientů nevolá pomocné funkce, ale strážce dál běží jako trigger', async () => {
      // Strážce rozdílů (D5) běžel výše pod rolí authenticated i po REVOKE EXECUTE.
      expect((await one<{ n: number }>(`select count(*)::int as n from idoklad_discrepancy where status = 'resolved'`)).n).toBeGreaterThan(0)
    })
  })

  describe('N1: api_request_hit', () => {
    let key1 = 0
    let key2 = 0
    beforeAll(async () => {
      key1 = (await one<{ id: number }>(`INSERT INTO api_key (name, key_hash, created_by) VALUES ('k1', 'x1', '${U_SALES}') RETURNING id`)).id
      key2 = (await one<{ id: number }>(`INSERT INTO api_key (name, key_hash, created_by) VALUES ('k2', 'x2', '${U_SALES}') RETURNING id`)).id
    })
    const hit = (key: number, limit: number, path = '/api/v1/deals') => scalarAs('service_role', null, `api_request_hit(${key}, '${path}', ${limit})`)
    // Každé volání je vlastní transakce (jako požadavek z PostgRESTu), výsledky se sbírají do dočasné tabulky.
    async function hits(key: number, limit: number, n: number, path = '/x'): Promise<boolean[]> {
      for (let i = 0; i < n; i++) {
        await as({ role: 'service_role' },
          `CREATE TEMP TABLE IF NOT EXISTS t_hit (v boolean); INSERT INTO t_hit SELECT api_request_hit(${key}, '${path}', ${limit});`)
      }
      const out = (await db.query<{ v: boolean }>('select v from t_hit')).rows.map((r) => r.v)
      await db.exec('DROP TABLE t_hit')
      return out
    }

    test('do limitu zapisuje, po limitu odmítne a nezapisuje; klíče jsou nezávislé', async () => {
      expect(await hits(key1, 3, 5)).toEqual([true, true, true, false, false])
      expect((await one<{ n: number }>(`select count(*)::int as n from api_request where key_id = ${key1} and path = '/x'`)).n).toBe(3)
      expect(await hits(key2, 3, 5)).toEqual([true, true, true, false, false])
    })

    test('starý záznam mimo minutové okno se do limitu nepočítá', async () => {
      const key = (await one<{ id: number }>(`INSERT INTO api_key (name, key_hash, created_by) VALUES ('k3', 'x3', '${U_SALES}') RETURNING id`)).id
      await run(`INSERT INTO api_request (key_id, path, at) SELECT ${key}, '/old', now() - interval '5 minutes' FROM generate_series(1, 10)`)
      expect(await hits(key, 2, 3, '/new')).toEqual([true, true, false])
    })

    test('retence: záznamy starší 90 dní se při zápisu časem smažou (deterministicky přes setseed)', async () => {
      await run(`INSERT INTO api_request (key_id, path, at) SELECT ${key1}, '/ancient', now() - interval '100 days' FROM generate_series(1, 5)`)
      await as({ role: 'service_role' },
        `SELECT setseed(0.42); SELECT count(*) FROM (SELECT api_request_hit(${key2}, '/bulk', 100000) FROM generate_series(1, 4000)) q;`)
      expect((await one<{ n: number }>(`select count(*)::int as n from api_request where path = '/ancient'`)).n).toBe(0)
      expect((await one<{ n: number }>(`select count(*)::int as n from api_request where path = '/bulk'`)).n).toBe(4000)
    })

    test('neplatné argumenty a práva', async () => {
      await expect(hit(key1, 0)).rejects.toThrow(/neplatné argumenty/)
      await expect(scalarAs('service_role', null, `api_request_hit(NULL, '/x', 5)`)).rejects.toThrow(/neplatné argumenty/)
      await expect(scalarAs('authenticated', U_SALES, `api_request_hit(${key1}, '/x', 5)`)).rejects.toThrow(/permission denied/)
      await expect(scalarAs('authenticated', null, `api_request_hit(${key1}, '/x', 5)`)).rejects.toThrow(/permission denied/)
      expect(M0096).toMatch(/pg_advisory_xact_lock\(hashtextextended\('api_request_hit:'/)
    })
  })

  describe('N7: oauth_client.approved_at a oauth_client_register', () => {
    const reg = (id: string, max: number, name = 'Test', ttl = 3) =>
      scalarAs('service_role', null, `oauth_client_register('${id}', '${name}', ARRAY['https://claude.ai/cb'], ${max}, ${ttl})`)
    const registerPersist = async (id: string, max: number, ttl = 3) => {
      await as({ role: 'service_role' },
        `CREATE TEMP TABLE IF NOT EXISTS reg_out (v boolean); INSERT INTO reg_out SELECT oauth_client_register('${id}', 'Test', ARRAY['https://claude.ai/cb'], ${max}, ${ttl});`)
      const v = (await db.query<{ v: boolean }>('select v from reg_out')).rows.at(-1)!.v
      await db.exec('DROP TABLE reg_out')
      return v
    }

    test('zpětné doplnění: klient s tokenem nebo klíčem konektoru je schválený, ostatní ne', async () => {
      const rows = (await db.query<{ client_id: string; approved: boolean }>(
        `select client_id, approved_at is not null as approved from oauth_client order by client_id`)).rows
      expect(Object.fromEntries(rows.map((r) => [r.client_id, r.approved]))).toEqual({
        [CLIENT_A]: true, [CLIENT_B]: true, [CLIENT_C]: false,
      })
    })

    test('strop neschválených: nad stropem false a nic se nezaloží; schválení místo uvolní', async () => {
      // Už je jeden neschválený (C). Strop 3 → dva další projdou, čtvrtý ne.
      expect(await registerPersist('cockpit-client_new1aaaaaaaa', 3)).toBe(true)
      expect(await registerPersist('cockpit-client_new2aaaaaaaa', 3)).toBe(true)
      expect(await registerPersist('cockpit-client_new3aaaaaaaa', 3)).toBe(false)
      expect((await one<{ n: number }>(`select count(*)::int as n from oauth_client where client_id = 'cockpit-client_new3aaaaaaaa'`)).n).toBe(0)
      // Schválení jednoho uvolní místo (approved_at nastaví aplikace při souhlasu).
      await run(`UPDATE oauth_client SET approved_at = now() WHERE client_id = 'cockpit-client_new1aaaaaaaa'`)
      expect(await registerPersist('cockpit-client_new3aaaaaaaa', 3)).toBe(true)
    })

    test('neschválení starší než 3 dny se maží i s kódy; schválení ne', async () => {
      await run(`
        UPDATE oauth_client SET created_at = now() - interval '4 days' WHERE client_id IN ('${CLIENT_C}', '${CLIENT_A}');
        INSERT INTO oauth_code (code, client_id, redirect_uri, code_challenge, api_key_id, api_key_secret, expires_at)
          VALUES ('kod-c', '${CLIENT_C}', 'https://claude.ai/cb', 'ch', NULL, 's', now() + interval '1 minute');`)
      expect(await registerPersist('cockpit-client_new4aaaaaaaa', 100)).toBe(true)
      const left = (await db.query<{ client_id: string }>('select client_id from oauth_client')).rows.map((r) => r.client_id)
      expect(left).not.toContain(CLIENT_C)
      expect(left).toContain(CLIENT_A) // schválený, i když starý
      expect((await one<{ n: number }>(`select count(*)::int as n from oauth_code where code = 'kod-c'`)).n).toBe(0)
    })

    test('neplatné argumenty a práva', async () => {
      await expect(reg('spatne-id', 5)).rejects.toThrow(/neplatné client_id/)
      await expect(scalarAs('service_role', null, `oauth_client_register('cockpit-client_okokokokok', 'x', ARRAY[]::text[], 5, 3)`)).rejects.toThrow(/1 až 10/)
      await expect(reg('cockpit-client_okokokokok', 0)).rejects.toThrow(/neplatný strop/)
      await expect(scalarAs('authenticated', U_SALES, `oauth_client_register('cockpit-client_okokokokok', 'x', ARRAY['https://claude.ai/cb'], 5, 3)`)).rejects.toThrow(/permission denied/)
    })

    test('název se ořízne na 100 znaků', async () => {
      await as({ role: 'service_role' }, `SELECT oauth_client_register('cockpit-client_longnamexxxx', '${'x'.repeat(300)}', ARRAY['https://claude.ai/cb'], 1000, 3);`)
      expect((await one<{ n: number }>(`select char_length(client_name)::int as n from oauth_client where client_id = 'cockpit-client_longnamexxxx'`)).n).toBe(100)
    })
  })

  test('guard: bez 0095 v ledgeru se migrace nespustí', async () => {
    await run(`DELETE FROM schema_migration WHERE version = '0095'`)
    try {
      await expect(run(M0096)).rejects.toThrow(/aplikuje po 0095/)
    } finally {
      await run(`INSERT INTO schema_migration (version, note) VALUES ('0095', 'stub')`)
    }
  })
})

// ---------------------------------------------------------------------------
// D8: politika úložiště na bucket nabidky (stub Supabase Storage jako v 0089)

const STORAGE_BASE = `
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid $$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claims', true), '')::jsonb $$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE TABLE team_member (id uuid PRIMARY KEY, role text NOT NULL);
INSERT INTO team_member VALUES ('${U_SALES}', 'obchodnik'), ('${U_PM}', 'projektak');
CREATE FUNCTION can_see_sales() RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM team_member WHERE id = auth.uid() AND role IN ('vedeni', 'obchodnik')) $$;
GRANT EXECUTE ON FUNCTION can_see_sales() TO anon, authenticated, service_role;
CREATE ROLE storage_admin NOLOGIN;
CREATE SCHEMA storage AUTHORIZATION storage_admin;
CREATE TABLE storage.buckets (id text PRIMARY KEY, name text NOT NULL, public boolean DEFAULT false);
CREATE TABLE storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text REFERENCES storage.buckets(id), name text NOT NULL);
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role;
GRANT ALL ON storage.objects, storage.buckets TO anon, authenticated, service_role;
INSERT INTO storage.buckets VALUES ('nabidky', 'nabidky', false), ('jiny', 'jiny', false);
INSERT INTO storage.objects (bucket_id, name) VALUES ('nabidky', 'offers/a.pdf'), ('jiny', 'x.txt');
-- Starší RUČNĚ založená permisivní politika (hypotéza D8): čte cokoli, i nabidky.
CREATE POLICY stara_rucni_cteni ON storage.objects FOR SELECT TO authenticated USING (true);
ALTER TABLE storage.objects OWNER TO storage_admin;
ALTER TABLE storage.buckets OWNER TO storage_admin;
`

describe.skipIf(!PGliteCtor)('0096 D8: politika úložiště (PGlite)', () => {
  let db: Db
  const notices: string[] = []
  const SECTION = M0096.slice(
    M0096.indexOf('-- 6) D8: bucket nabidky'),
    M0096.indexOf('-- 7) N1: limit API klíčů'),
  ).replace(/^-- =+\n/m, '')

  beforeAll(async () => {
    db = new PGliteCtor!()
    await db.exec(STORAGE_BASE)
    await db.exec(SECTION, { onNotice: (n) => notices.push(`${n.severity}: ${n.message}`) })
    await db.exec(SECTION) // idempotence
  })

  const visible = async (sub: string, bucket: string) => {
    await db.query('BEGIN')
    try {
      await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role: 'authenticated', sub, aal: 'aal2' })])
      await db.query('SET LOCAL ROLE authenticated')
      return (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM storage.objects WHERE bucket_id = $1`, [bucket])).rows[0].n
    } finally {
      await db.query('ROLLBACK')
    }
  }

  test('starší permisivní politika už nepustí ne-obchodní roli k nabídkám', async () => {
    expect(await visible(U_PM, 'nabidky')).toBe(0)
    expect(await visible(U_SALES, 'nabidky')).toBe(1)
    // Ostatní buckety nejsou dotčené.
    expect(await visible(U_PM, 'jiny')).toBe(1)
  })

  test('cizí politika se jen ohlásí (NOTICE), nic se neodstraní', async () => {
    expect(notices.some((n) => n.startsWith('NOTICE: 0096: na storage.objects jsou další politiky (stara_rucni_cteni)'))).toBe(true)
    const names = (await db.query<{ policyname: string }>(`SELECT policyname FROM pg_policies WHERE schemaname = 'storage' ORDER BY 1`)).rows.map((r) => r.policyname)
    expect(names).toEqual(['nabidky_sales_only', 'stara_rucni_cteni'])
  })
})
