// 0080_auto_delivery.sql: statické kontroly (vždy) a chování ve skutečném
// Postgresu (PGlite = PostgreSQL ve WASM, bez sítě). PGlite je v devDependencies, v bráně (build:release) i v CI běží;
// kdyby chyběl, červeně selže test/pglite-dependency.test.ts.
//
// Schéma je zjednodušená kopie tabulek, kterých se migrace dotýká (sloupce
// podle migrací 0001–0079), stuby auth.uid()/auth.jwt() jako v Supabase a
// role authenticated/service_role. Audit je ten skutečný: funkce a triggery
// audit_row_change() se vytáhnou přímo z 0064_audit_coverage.sql, takže se
// ověří i konvence auditu (aktér z auth.uid(), žádný volný text v hodnotách).
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, test } from 'vitest'
import { COMPANY } from '@/config'
import {
  AUTO_DELIVERY_AUDIT_ACTIONS,
  AUTO_DELIVERY_MIGRATION,
  AUTO_DELIVERY_NOT_WON_CODE,
  AUTO_DELIVERY_ORIGIN,
} from '@/domain/delivery/autoDelivery'

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

const MIG = readFileSync('supabase/migrations/0080_auto_delivery.sql', 'utf8')
const M0064 = readFileSync('supabase/migrations/0064_audit_coverage.sql', 'utf8')
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '')
const SQL = strip(MIG)
const AUTO = AUTO_DELIVERY_ORIGIN

// ---------------------------------------------------------------------------
// Statické kontroly (bez databáze)

describe('0080_auto_delivery.sql — statické kontroly', () => {
  test('guard je první příkaz a jmenuje migrace, na kterých stojí', () => {
    expect(SQL.trim().startsWith('DO $$')).toBe(true)
    for (const f of [
      '0042_engagement_milestone.sql', '0072_deal_scope_version.sql', '0064_audit_coverage.sql',
      '0039_loop_core.sql', '0061_delivery_impact.sql', '0054_handoff_package.sql', '0052_deal_opportunity.sql',
    ]) expect(SQL).toContain(f)
  })

  test('ledger nese 0080 a soubor nemá vlastní transakci', () => {
    expect(AUTO_DELIVERY_MIGRATION).toBe('0080')
    expect(SQL).toMatch(/INSERT INTO schema_migration \(version, note\)\s+VALUES \('0080'/)
    expect(SQL).toMatch(/ON CONFLICT \(version\) DO NOTHING;\s*$/)
    expect(SQL).not.toMatch(/^\s*(BEGIN|COMMIT)\s*;/im)
  })

  test('jádro a trigger funkce nemají klientské EXECUTE, RPC jen pro authenticated', () => {
    expect(SQL).toContain('REVOKE ALL ON FUNCTION auto_delivery_create(bigint, date, text, text) FROM PUBLIC;')
    expect(SQL).toContain('REVOKE ALL ON FUNCTION auto_delivery_create(bigint, date, text, text) FROM anon, authenticated;')
    expect(SQL).toContain('REVOKE ALL ON FUNCTION auto_delivery_on_deal_won() FROM anon, authenticated;')
    expect(SQL).toContain('REVOKE ALL ON FUNCTION engagement_origin_guard() FROM PUBLIC, anon, authenticated;')
    expect(SQL).toContain('REVOKE ALL ON FUNCTION ensure_deal_delivery(bigint) FROM PUBLIC, anon;')
    expect(SQL).toContain('GRANT EXECUTE ON FUNCTION ensure_deal_delivery(bigint) TO authenticated;')
    expect(SQL).not.toMatch(/GRANT EXECUTE ON FUNCTION auto_delivery_create/)
  })

  test('RPC má bránu: přihlášený, AAL2, člen týmu, obchodní role', () => {
    const rpc = /CREATE OR REPLACE FUNCTION ensure_deal_delivery[\s\S]*?\$\$;/.exec(SQL)![0]
    expect(rpc).toContain('SECURITY DEFINER')
    expect(rpc).toContain('SET search_path = public, pg_temp')
    expect(rpc).toContain('auth.uid() IS NULL')
    expect(rpc).toContain("coalesce(auth.jwt() ->> 'aal', '') <> 'aal2'")
    expect(rpc).toContain('NOT is_team_member()')
    expect(rpc).toContain('NOT can_see_sales()')
  })

  test('triggery reagují jen na vstup do Vyhráno a mají zvlášť INSERT a UPDATE', () => {
    expect(SQL).toMatch(/CREATE TRIGGER deal_auto_delivery_insert\s+AFTER INSERT ON deal\s+FOR EACH ROW\s+WHEN \(NEW\.stage::text = 'vyhráno'\)/)
    expect(SQL).toMatch(
      /CREATE TRIGGER deal_auto_delivery_update\s+AFTER UPDATE OF stage ON deal\s+FOR EACH ROW\s+WHEN \(NEW\.stage::text = 'vyhráno' AND OLD\.stage IS DISTINCT FROM NEW\.stage\)/,
    )
    for (const t of ['deal_auto_delivery_insert', 'deal_auto_delivery_update', 'engagement_origin_guard']) {
      expect(SQL).toContain(`DROP TRIGGER IF EXISTS ${t} ON`)
    }
    // Návrat z Vyhráno nic nemaže.
    expect(SQL).not.toMatch(/DELETE FROM (engagement|task|sales_activity|engagement_milestone)/i)
  })

  test('unikátní vazba jen pro automatické dodávky, původ hlídá CHECK', () => {
    expect(SQL).toContain(`CHECK (origin IN ('manual', '${AUTO}'))`)
    expect(SQL).toContain(`CREATE UNIQUE INDEX IF NOT EXISTS engagement_auto_deal_uidx\n  ON engagement (deal_id) WHERE origin = '${AUTO}';`)
    expect(SQL).toContain(`ON CONFLICT (deal_id) WHERE origin = '${AUTO}' DO NOTHING`)
  })

  test('kódy a názvy událostí v SQL sedí s doménovým modulem', () => {
    expect(SQL).toContain(`ERRCODE = '${AUTO_DELIVERY_NOT_WON_CODE}'`)
    expect(SQL).toContain(`'${AUTO_DELIVERY_AUDIT_ACTIONS.created}'`)
    expect(SQL).toContain(`'${AUTO_DELIVERY_AUDIT_ACTIONS.failed}'`)
  })

  test('backfill bere jen vyhrané obchody bez jakékoli dodávky', () => {
    const backfill = /FOR r IN[\s\S]*?LOOP/.exec(SQL)![0]
    expect(backfill).toContain("d.stage::text = 'vyhráno'")
    expect(backfill).toContain('NOT EXISTS (SELECT 1 FROM engagement e WHERE e.deal_id = d.id)')
  })

  test('částky obchodu se do dodávky nekopírují', () => {
    const core = /CREATE OR REPLACE FUNCTION auto_delivery_create[\s\S]*?\$\$;/.exec(SQL)![0]
    expect(core).not.toMatch(/amount_one_time|expected_mrr|cogs_one_time|financial_frame|client_sponsor/)
  })

  test('šablona milníků v SQL == COMPANY.autoDelivery.milestoneTemplates', () => {
    const fnBody = /CREATE OR REPLACE FUNCTION auto_delivery_milestones[\s\S]*?\$\$;/.exec(SQL)![0]
    const rows = [...fnBody.matchAll(/\('(\w+)', (\d+), '([^']+)'\)/g)].map((m) => ({ key: m[1], pos: Number(m[2]), title: m[3] }))
    const sqlTemplates: Record<string, string[]> = {}
    for (const r of rows.sort((a, b) => a.pos - b.pos)) (sqlTemplates[r.key] ??= []).push(r.title)
    const cfg = COMPANY.autoDelivery!.milestoneTemplates
    expect(sqlTemplates).toEqual(Object.fromEntries(Object.entries(cfg).map(([k, v]) => [k, [...v]])))
    for (const r of rows) expect(rows.filter((x) => x.key === r.key && x.pos === r.pos)).toHaveLength(1)
  })

  test('úkol: název a termín v SQL == COMPANY.autoDelivery.startTask', () => {
    const { title, workingDays } = COMPANY.autoDelivery!.startTask
    expect(SQL).toContain(`'${title}',\n    'Obchod`)
    expect(SQL).toContain(`auto_delivery_add_working_days(v_today, ${workingDays})`)
  })

  test('uzly zástupu v SQL == COMPANY.autoDelivery.deputyNodes', () => {
    const list = COMPANY.autoDelivery!.deputyNodes.map((n) => `'${n}'`).join(', ')
    expect(SQL).toContain(`array_position(ARRAY[${list}], n.node)`)
    // Šablona `jine` je výchozí a existuje vždy.
    expect(COMPANY.autoDelivery!.milestoneTemplates.jine.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// Skutečný Postgres (PGlite)

const U_SALES = '11111111-1111-4111-8111-111111111111'
const U_PM = '22222222-2222-4222-8222-222222222222'
const U_DEPUTY = '33333333-3333-4333-8333-333333333333'
const U_ACC_OWNER = '44444444-4444-4444-8444-444444444444'
const U_NODE_OWNER = '55555555-5555-4555-8555-555555555555'

const pragueToday = (): string =>
  new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Prague' }).format(new Date())
// Nezávislý výpočet očekávaného termínu úkolu (Po–Pá).
function plusWorkingDays(day: string, n: number): string {
  const d = new Date(`${day}T12:00:00Z`)
  let left = n
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1)
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) left -= 1
  }
  return d.toISOString().slice(0, 10)
}

// Funkce a triggery skutečného auditu z 0064 (bez závislosti na 21 tabulkách).
function auditMachinery(): string {
  const start = M0064.indexOf('CREATE OR REPLACE FUNCTION audit_request_context(')
  const end = M0064.indexOf('-- 4) Napojení tabulek')
  if (start < 0 || end < 0) throw new Error('0064: struktura se změnila, uprav vytažení auditu v testu')
  const functions = M0064.slice(start, end)
  const wanted = ['engagement', 'engagement_milestone', 'task', 'sales_activity', 'deal']
  const triggers = [...M0064.matchAll(
    /DROP TRIGGER IF EXISTS audit_row_change ON (\w+);\s*CREATE TRIGGER audit_row_change[\s\S]*?\);\n/g,
  )].filter((m) => wanted.includes(m[1])).map((m) => m[0])
  if (triggers.length !== wanted.length) throw new Error('0064: nenalezeny všechny triggery auditu')
  return `${functions}\n${triggers.join('\n')}`
}

const SCHEMA = `
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('request.jwt.claim', true), ''),
                  nullif(current_setting('request.jwt.claims', true), ''))::jsonb $$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
-- Supabase dává novým funkcím EXECUTE pro anon i authenticated; migrace ho musí odebrat sama.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

CREATE TABLE schema_migration (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now(), note text);
CREATE TABLE team_member (id uuid PRIMARY KEY, role text NOT NULL, full_name text);
INSERT INTO team_member VALUES ('${U_SALES}', 'obchodnik', 'Obchodník'), ('${U_PM}', 'projektak', 'Projekťák'),
  ('${U_DEPUTY}', 'vedeni', 'Zástupce'), ('${U_ACC_OWNER}', 'obchodnik', 'Vlastník klienta'), ('${U_NODE_OWNER}', 'vedeni', 'Vlastník uzlu');
CREATE FUNCTION is_team_member() RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM team_member WHERE id = auth.uid()) $$;
CREATE FUNCTION can_see_sales() RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM team_member WHERE id = auth.uid() AND role IN ('vedeni', 'obchodnik')) $$;

CREATE TABLE evidence (id bigserial PRIMARY KEY, source_kind text NOT NULL, source_id text NOT NULL, web_link text,
  captured_at timestamptz NOT NULL DEFAULT now(), created_by text);
CREATE TABLE audit_event (id bigserial PRIMARY KEY, actor_type text NOT NULL, actor_id text, action text NOT NULL,
  entity_table text NOT NULL, entity_id bigint NOT NULL, before jsonb, after jsonb, occurred_at timestamptz NOT NULL DEFAULT now(),
  evidence_id bigint REFERENCES evidence(id) ON DELETE RESTRICT,
  info_state text CHECK (info_state IS NULL OR info_state IN ('source_fact','ai_suggestion','human_confirmed','actual_result')));

CREATE TYPE task_status AS ENUM ('todo','in_progress','blocked','done');
CREATE TYPE task_priority AS ENUM ('low','normal','high');
CREATE TYPE sales_activity_kind AS ENUM ('call','email','meeting','note','other');
CREATE TYPE sales_activity_outcome AS ENUM ('completed','no_answer','follow_up','cancelled');
CREATE TYPE deal_stage AS ENUM ('lead','proběhlo_jednání','nabídka','vyjednávání','kvalifikace','diagnostika','rozsah_nabidka','rozhodovani','vyhráno','prohráno','odloženo');
CREATE TYPE delivery_phase AS ENUM ('sm_diagnostika','workshopy','analyza','pilot','implementace','podpora','mereni_6m','uzavreno');
CREATE TYPE revenue_line AS ENUM ('catering_firemni','oslava_soukroma','svatebni_hostina','cheesecaky_eshop','firemni_pravidelny','pronajem_prostor','provize');

CREATE TABLE account (id bigserial PRIMARY KEY, name text NOT NULL, owner_id uuid REFERENCES team_member(id));
CREATE TABLE loop_node (node text PRIMARY KEY, owner_id uuid REFERENCES team_member(id), deputy_id uuid REFERENCES team_member(id),
  CONSTRAINT loop_node_deputy_differs CHECK (deputy_id IS NULL OR owner_id IS NULL OR deputy_id <> owner_id));
CREATE TABLE deal (id bigserial PRIMARY KEY, account_id bigint NOT NULL REFERENCES account(id) ON DELETE CASCADE, title text NOT NULL,
  revenue_line revenue_line NOT NULL DEFAULT 'svatebni_hostina', stage deal_stage NOT NULL DEFAULT 'kvalifikace',
  amount_one_time numeric(14,2) DEFAULT 0, cogs_one_time numeric(14,2) DEFAULT 0, expected_mrr numeric(12,2) DEFAULT 0,
  won_at date, closed_at date, pillar text, phase text, delivery_team text CHECK (delivery_team IS NULL OR delivery_team IN ('kuchyne','cukrarna','obsluha','logistika','externi')),
  owner_id uuid REFERENCES team_member(id), primary_contact_id bigint, next_step text, next_step_due date, last_activity_at timestamptz,
  deal_kind text, expected_outcome text, updated_at timestamptz NOT NULL DEFAULT now(),
  currency text NOT NULL DEFAULT 'CZK', subsidy_pct numeric(5,2) DEFAULT 0, fx_rate numeric(10,4), amount_one_time_original numeric(14,2),
  follow_up_nudged_on date, follow_up_escalated_on date, client_paid_one_time numeric(14,2), delivery_lane text, estimate_md integer,
  forecast_category text, probability_pct integer, revenue_category text, sourced_by_partner bigint, subsidy_program text, expected_close date, decision_due date);
CREATE TABLE engagement (id bigserial PRIMARY KEY, account_id bigint NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  deal_id bigint REFERENCES deal(id), kind text NOT NULL, phase delivery_phase NOT NULL DEFAULT 'sm_diagnostika',
  started_on date, due_on date, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  reference_worthy boolean NOT NULL DEFAULT false, goal text, scope text, client_sponsor_contact_id bigint, financial_frame text, risks text[],
  handoff_completed_at timestamptz, handoff_by uuid, owner_id uuid REFERENCES team_member(id), deputy_id uuid REFERENCES team_member(id),
  delivery_team text CHECK (delivery_team IS NULL OR delivery_team IN ('kuchyne','cukrarna','obsluha','logistika','externi')),
  CONSTRAINT engagement_deputy_check CHECK (deputy_id IS NULL OR owner_id IS NULL OR deputy_id <> owner_id));
CREATE TABLE engagement_milestone (id bigserial PRIMARY KEY, engagement_id bigint NOT NULL REFERENCES engagement(id) ON DELETE CASCADE, title text NOT NULL,
  owner_id uuid, deputy_id uuid, status text NOT NULL DEFAULT 'pripraveno', due_on date, accepted_at timestamptz, accepted_by_contact_id bigint,
  acceptance_evidence_id bigint REFERENCES evidence(id), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT engagement_milestone_deputy_check CHECK (deputy_id IS NULL OR owner_id IS NULL OR deputy_id <> owner_id));
CREATE TABLE task (id bigserial PRIMARY KEY, title text NOT NULL, description text, status task_status NOT NULL DEFAULT 'todo',
  priority task_priority NOT NULL DEFAULT 'normal', assignee_id uuid, created_by uuid, due_on date, account_id bigint, deal_id bigint,
  engagement_id bigint, ms_event_id text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE sales_activity (id bigserial PRIMARY KEY, account_id bigint REFERENCES account(id) ON DELETE CASCADE, deal_id bigint, contact_id bigint,
  kind sales_activity_kind NOT NULL, outcome sales_activity_outcome NOT NULL DEFAULT 'completed', subject text NOT NULL, body text,
  occurred_at timestamptz NOT NULL DEFAULT now(), follow_up_on date, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  partner_id bigint, source text, external_id text, ms_event_id text);
CREATE UNIQUE INDEX sales_activity_external_idx ON sales_activity(source, external_id) WHERE external_id IS NOT NULL;
CREATE TABLE deal_scope_version (id bigserial PRIMARY KEY, deal_id bigint NOT NULL REFERENCES deal(id) ON DELETE CASCADE, version integer NOT NULL,
  scope text, status text NOT NULL DEFAULT 'draft', UNIQUE (deal_id, version));
CREATE UNIQUE INDEX deal_scope_version_one_accepted_idx ON deal_scope_version (deal_id) WHERE status = 'accepted';

-- Trigger aktivity z 0059: posouvá deal.last_activity_at (zápis aktivity uvnitř našeho triggeru ho musí přežít).
CREATE FUNCTION touch_deal_last_activity() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.deal_id IS NOT NULL THEN
    UPDATE deal SET last_activity_at = GREATEST(COALESCE(last_activity_at, NEW.occurred_at), NEW.occurred_at) WHERE id = NEW.deal_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sales_activity_touch_deal AFTER INSERT ON sales_activity FOR EACH ROW EXECUTE FUNCTION touch_deal_last_activity();

ALTER TABLE engagement ENABLE ROW LEVEL SECURITY;
ALTER TABLE task ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_activity ENABLE ROW LEVEL SECURITY;
ALTER TABLE engagement_milestone ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_event ENABLE ROW LEVEL SECURITY;
${auditMachinery()}
-- Uživatel smí měnit obchod (jako obchodní role přes RLS deal), nic dalšího nevidí ani nezapisuje.
GRANT SELECT, INSERT, UPDATE ON deal, account TO authenticated, service_role;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO authenticated, service_role;
GRANT SELECT ON team_member, loop_node TO authenticated, service_role;
`

type Audit = { id: number; actor_type: string; actor_id: string | null; action: string; entity_table: string; entity_id: number; after: Row | null; before: Row | null; info_state: string | null }

describe.skipIf(!PGliteCtor)('0080 v Postgresu (PGlite)', () => {
  const notices: string[] = []

  async function fresh(prepare?: (db: Db) => Promise<void>): Promise<Db> {
    const db = new PGliteCtor!()
    await db.exec(SCHEMA)
    if (prepare) await prepare(db)
    await db.exec(MIG, { onNotice: (n) => notices.push(`${n.severity}: ${n.message}`) })
    return db
  }
  // Jeden požadavek jako z PostgRESTu: JWT claims, SET LOCAL ROLE.
  async function as(
    db: Db,
    who: { role: 'authenticated' | 'service_role' | 'anon'; sub?: string; aal?: string; headers?: Record<string, string> },
    sql: string,
  ) {
    const claims = JSON.stringify({ role: who.role, aal: who.aal ?? 'aal2', ...(who.sub ? { sub: who.sub } : {}) })
    const prefix = [
      'BEGIN;',
      `SELECT set_config('request.jwt.claims', '${claims}', true);`,
      who.headers ? `SELECT set_config('request.headers', '${JSON.stringify(who.headers)}', true);` : '',
      `SET LOCAL ROLE ${who.role};`,
    ].join('\n')
    try {
      await db.exec(`${prefix}\n${sql}\nCOMMIT;`, { onNotice: (n) => notices.push(`${n.severity}: ${n.message}`) })
    } catch (e) {
      await db.exec('ROLLBACK').catch(() => undefined)
      throw e
    }
  }
  const q = async <T = Row>(db: Db, sql: string, params?: unknown[]) => (await db.query<T>(sql, params)).rows
  const one = async <T = Row>(db: Db, sql: string, params?: unknown[]) => (await q<T>(db, sql, params))[0]
  const count = async (db: Db, table: string, where = 'true') =>
    (await one<{ n: number }>(db, `select count(*)::int as n from ${table} where ${where}`)).n
  const audits = (db: Db, where: string) => q<Audit>(db, `select * from audit_event where ${where} order by id`)

  let account = 0
  async function newAccount(db: Db, name = 'Firma s.r.o.', owner: string | null = null): Promise<number> {
    return (await one<{ id: number }>(db, `insert into account (name, owner_id) values ($1, $2) returning id`, [name, owner])).id
  }
  async function newDeal(db: Db, extra: Partial<Record<string, string | number | null>> = {}): Promise<number> {
    const cols: Record<string, string | number | null> = { account_id: account, title: 'Datová platforma', owner_id: U_SALES, ...extra }
    const keys = Object.keys(cols)
    return (await one<{ id: number }>(
      db,
      `insert into deal (${keys.join(', ')}) values (${keys.map((_, i) => `$${i + 1}`).join(', ')}) returning id`,
      keys.map((k) => cols[k]),
    )).id
  }
  const win = (db: Db, dealId: number, sub = U_SALES) =>
    as(db, { role: 'authenticated', sub }, `UPDATE deal SET stage = 'vyhráno' WHERE id = ${dealId};`)
  const engagementsOf = (db: Db, dealId: number) =>
    q<Row & { id: number; started_txt: string | null }>(db, 'select e.*, e.started_on::text as started_txt from engagement e where deal_id = $1 order by id', [dealId])

  // ------------------------------------------------------------------ živé chování
  describe('po vyhrání obchodu', () => {
    let db: Db
    beforeAll(async () => {
      db = await fresh()
      account = await newAccount(db, 'Servis Climax')
      await db.exec(`INSERT INTO loop_node VALUES
        ('eventy', '${U_SALES}', '${U_DEPUTY}'), ('obchod', '${U_SALES}', NULL),
        ('vedeni', '${U_NODE_OWNER}', NULL)`)
    }, 60_000)

    test('migrace je idempotentní a zapíše ledger právě jednou', async () => {
      await db.exec(MIG)
      expect(await count(db, 'schema_migration', "version = '0080'")).toBe(1)
      expect((await one<{ note: string }>(db, `select note from schema_migration where version = '0080'`)).note).toMatch(/backfill zalozil 0 dodavek/)
    })

    test('přechod do Vyhráno založí dodávku s výchozími hodnotami, milníky, úkol, aktivitu a audit', async () => {
      const dealId = await newDeal(db, {
        revenue_line: 'svatebni_hostina', deal_kind: 'implementace', expected_outcome: 'Jedna pravda o datech',
        delivery_team: 'obsluha', amount_one_time: 580000,
      })
      await db.exec(`INSERT INTO deal_scope_version (deal_id, version, scope, status) VALUES
        (${dealId}, 1, 'Starý rozsah', 'superseded'), (${dealId}, 2, 'Tajný rozsah přijaté nabídky', 'accepted'),
        (${dealId}, 3, 'Odeslaná, nepřijatá verze', 'sent')`)
      await win(db, dealId)

      const [e] = await engagementsOf(db, dealId)
      expect(e).toMatchObject({
        account_id: account, deal_id: dealId, kind: 'it', phase: 'sm_diagnostika', origin: AUTO,
        goal: 'Jedna pravda o datech', scope: 'Tajný rozsah přijaté nabídky', delivery_team: 'obsluha',
        owner_id: U_SALES, deputy_id: U_DEPUTY, financial_frame: null, client_sponsor_contact_id: null, risks: null, handoff_completed_at: null,
      })
      expect(e.started_txt).toBe(pragueToday())

      const ms = await q<{ title: string; owner_id: string; deputy_id: string; status: string; due_on: string | null }>(
        db, 'select title, owner_id, deputy_id, status, due_on from engagement_milestone where engagement_id = $1 order by id', [e.id])
      expect(ms.map((m) => m.title)).toEqual([...COMPANY.autoDelivery!.milestoneTemplates.implementace])
      expect(ms.every((m) => m.owner_id === U_SALES && m.deputy_id === U_DEPUTY && m.status === 'pripraveno' && m.due_on === null)).toBe(true)

      const task = await one<Row & { due_txt: string }>(db, 'select t.*, t.due_on::text as due_txt from task t where engagement_id = $1', [e.id])
      expect(task).toMatchObject({
        title: COMPANY.autoDelivery!.startTask.title, assignee_id: U_SALES, created_by: null, status: 'todo',
        account_id: account, deal_id: dealId,
      })
      expect(task.due_txt).toBe(plusWorkingDays(pragueToday(), COMPANY.autoDelivery!.startTask.workingDays))

      const act = await one<Row>(db, `select * from sales_activity where deal_id = $1 and source = 'auto_delivery'`, [dealId])
      expect(act).toMatchObject({ account_id: account, kind: 'note', outcome: 'completed', external_id: `engagement:${e.id}`, created_by: null })
      expect(String(act.subject)).toContain('Datová platforma')
      expect(String(act.body)).toContain('verze nabídky v2')
      expect(String(act.body)).not.toMatch(/580|Kč/)
    })

    test('audit: významová událost, řádkové změny od triggeru 0064, žádný volný text ani částky', async () => {
      const dealId = (await one<{ id: number }>(db, `select id from deal order by id limit 1`)).id
      const [e] = await engagementsOf(db, dealId)
      const [created] = await audits(db, `action = '${AUTO_DELIVERY_AUDIT_ACTIONS.created}'`)
      expect(created).toMatchObject({ actor_type: 'user', actor_id: U_SALES, entity_table: 'deal', entity_id: dealId, before: null, info_state: 'human_confirmed' })
      expect(created.after).toMatchObject({
        engagement_id: e.id, milestones: 4, owner_id: U_SALES, deputy_id: U_DEPUTY, template: 'implementace', via: 'trigger',
      })
      const rows = await audits(db, `action IN ('engagement.created', 'engagement_milestone.created', 'task.created', 'sales_activity.created')`)
      expect(rows.map((r) => r.action).sort()).toEqual([
        'engagement.created', 'engagement_milestone.created', 'engagement_milestone.created', 'engagement_milestone.created',
        'engagement_milestone.created', 'sales_activity.created', 'task.created',
      ])
      expect(rows.every((r) => r.actor_type === 'user' && r.actor_id === U_SALES)).toBe(true)
      const all = JSON.stringify(await q(db, 'select before, after from audit_event'))
      expect(all).not.toMatch(/Tajný rozsah|Jedna pravda|Datová platforma|Naplánovat|580000/)
    })

    test('opakované přepnutí fáze druhou dodávku nezaloží a návrat z Vyhráno nic nemaže', async () => {
      const dealId = (await one<{ id: number }>(db, `select id from deal order by id limit 1`)).id
      const before = [
        await count(db, 'engagement'), await count(db, 'engagement_milestone'), await count(db, 'task'),
        await count(db, 'sales_activity'), await count(db, 'audit_event', `action = '${AUTO_DELIVERY_AUDIT_ACTIONS.created}'`),
      ]
      await as(db, { role: 'authenticated', sub: U_SALES }, `UPDATE deal SET stage = 'rozhodovani' WHERE id = ${dealId};`)
      expect(await count(db, 'engagement')).toBe(before[0])
      await win(db, dealId)
      await as(db, { role: 'authenticated', sub: U_SALES }, `UPDATE deal SET title = 'Nový název', stage = 'vyhráno' WHERE id = ${dealId};`)
      await as(db, { role: 'service_role' }, `UPDATE deal SET stage = 'vyhráno' WHERE id = ${dealId};`)
      const after = [
        await count(db, 'engagement'), await count(db, 'engagement_milestone'), await count(db, 'task'),
        await count(db, 'sales_activity'), await count(db, 'audit_event', `action = '${AUTO_DELIVERY_AUDIT_ACTIONS.created}'`),
      ]
      expect(after).toEqual(before)
    })

    test('obchod založený rovnou jako vyhraný (INSERT) má dodávku taky', async () => {
      const dealId = await newDeal(db, { title: 'Rovnou vyhraný', stage: 'vyhráno', revenue_line: 'oslava_soukroma' })
      const [e] = await engagementsOf(db, dealId)
      expect(e).toMatchObject({ kind: 'edu', phase: 'sm_diagnostika', origin: AUTO })
      const titles = (await q<{ title: string }>(db, 'select title from engagement_milestone where engagement_id = $1 order by id', [e.id])).map((m) => m.title)
      // deal_kind je NULL → šablona podle produktové linky (akce → implementace).
      expect(titles).toEqual([...COMPANY.autoDelivery!.milestoneTemplates.implementace])
    })

    test('rozsah jen z přijaté verze: bez ní zůstane prázdný a úkol i aktivita to řeknou', async () => {
      const dealId = await newDeal(db, { title: 'Bez přijaté verze' })
      await db.exec(`INSERT INTO deal_scope_version (deal_id, version, scope, status) VALUES (${dealId}, 1, 'Jen odeslaná', 'sent')`)
      await win(db, dealId)
      const [e] = await engagementsOf(db, dealId)
      expect(e.scope).toBeNull()
      const task = await one<{ description: string }>(db, 'select description from task where deal_id = $1', [dealId])
      expect(task.description).toContain('chybí přijatá verze nabídky')
      const act = await one<{ body: string }>(db, `select body from sales_activity where deal_id = $1 and source = 'auto_delivery'`, [dealId])
      expect(act.body).toContain('rozsah nevyplněn')
    })

    test('když k obchodu už ruční dodávka existuje, nic se nezakládá', async () => {
      const dealId = await newDeal(db, { title: 'Ruční dodávka' })
      await db.exec(`INSERT INTO engagement (account_id, deal_id, kind) VALUES (${account}, ${dealId}, 'edu')`)
      await win(db, dealId)
      const list = await engagementsOf(db, dealId)
      expect(list).toHaveLength(1)
      expect(list[0].origin).toBe('manual')
      expect(await count(db, 'task', `deal_id = ${dealId}`)).toBe(0)
      expect(await count(db, 'audit_event', `entity_id = ${dealId} and action = '${AUTO_DELIVERY_AUDIT_ACTIONS.created}'`)).toBe(0)
    })

    test('vlastník: obchod → vlastník klienta → uzel eventy; bez nikoho úkol bez řešitele', async () => {
      const acc = await newAccount(db, 'Klient s vlastníkem', U_ACC_OWNER)
      const d1 = await newDeal(db, { account_id: acc, owner_id: null })
      await win(db, d1)
      expect((await engagementsOf(db, d1))[0].owner_id).toBe(U_ACC_OWNER)

      const d2 = await newDeal(db, { owner_id: null })
      await win(db, d2)
      expect((await engagementsOf(db, d2))[0].owner_id).toBe(U_SALES) // vlastník uzlu eventy

      await db.exec(`UPDATE loop_node SET owner_id = NULL, deputy_id = NULL WHERE node = 'eventy'`)
      const d3 = await newDeal(db, { owner_id: null })
      await win(db, d3)
      const [e3] = await engagementsOf(db, d3)
      expect([e3.owner_id, e3.deputy_id]).toEqual([null, null])
      expect((await one<{ assignee_id: string | null }>(db, 'select assignee_id from task where deal_id = $1', [d3])).assignee_id).toBeNull()
      await db.exec(`UPDATE loop_node SET owner_id = '${U_SALES}', deputy_id = '${U_DEPUTY}' WHERE node = 'eventy'`)
    })

    test('zástup: uzel eventů má přednost před vedením, pak jakýkoli; nikdy vlastník sám', async () => {
      await db.exec(`UPDATE loop_node SET owner_id = '${U_ACC_OWNER}', deputy_id = '${U_PM}' WHERE node = 'vedeni'`)
      // Vlastník obchodu vlastní realizaci (zástup U_DEPUTY) i strategii (zástup U_PM) → realizace vyhrává.
      await db.exec(`UPDATE loop_node SET owner_id = '${U_ACC_OWNER}' WHERE node = 'eventy'`)
      const d1 = await newDeal(db, { owner_id: U_ACC_OWNER })
      await win(db, d1, U_ACC_OWNER)
      expect((await engagementsOf(db, d1))[0].deputy_id).toBe(U_DEPUTY)

      // Bez zástupu u realizace se vezme strategie, potom jakýkoli uzel vlastníka.
      await db.exec(`UPDATE loop_node SET deputy_id = NULL WHERE node = 'eventy'`)
      const d2 = await newDeal(db, { owner_id: U_ACC_OWNER })
      await win(db, d2, U_ACC_OWNER)
      expect((await engagementsOf(db, d2))[0].deputy_id).toBe(U_PM)

      await db.exec(`UPDATE loop_node SET deputy_id = NULL WHERE node = 'vedeni'; UPDATE loop_node SET deputy_id = '${U_PM}' WHERE node = 'obchod'`)
      await db.exec(`UPDATE loop_node SET owner_id = '${U_ACC_OWNER}' WHERE node = 'obchod'`)
      const d3 = await newDeal(db, { owner_id: U_ACC_OWNER })
      await win(db, d3, U_ACC_OWNER)
      expect((await engagementsOf(db, d3))[0].deputy_id).toBe(U_PM)

      // Obnova výchozího stavu pro další testy.
      await db.exec(`UPDATE loop_node SET owner_id = '${U_SALES}', deputy_id = '${U_DEPUTY}' WHERE node = 'eventy';
        UPDATE loop_node SET owner_id = '${U_NODE_OWNER}', deputy_id = NULL WHERE node IN ('vedeni', 'vedeni')`)
    })

    test('pilíř a fáze obchodu určují první fázi dodávky', async () => {
      const d = await newDeal(db, { revenue_line: 'oslava_soukroma', pillar: 'b2c_oslavy', phase: 'potvrzeno' })
      await win(db, d)
      expect((await engagementsOf(db, d))[0]).toMatchObject({ kind: 'edu', phase: 'analyza' })
    })

    test('uživatel bez práv k tabulkám dodávky přechod provede (SECURITY DEFINER), RLS nepřekáží', async () => {
      const d = await newDeal(db, { title: 'RLS' })
      await win(db, d)
      expect(await engagementsOf(db, d)).toHaveLength(1)
      // Obyčejný uživatel k engagement nemá žádné právo (jen přes trigger).
      await expect(as(db, { role: 'authenticated', sub: U_SALES }, 'SELECT * FROM engagement;')).rejects.toThrow(/permission denied/)
    })

    test('selhání jádra neblokuje výhru: přechod projde, podtransakce se vrátí, zůstane audit a WARNING', async () => {
      await db.exec(`CREATE FUNCTION test_boom() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'boom' USING ERRCODE = 'XX999'; END $$;
        CREATE TRIGGER test_boom BEFORE INSERT ON task FOR EACH ROW EXECUTE FUNCTION test_boom();`)
      const d = await newDeal(db, { title: 'Selže' })
      notices.length = 0
      await win(db, d)
      expect((await one<{ stage: string }>(db, 'select stage::text as stage from deal where id = $1', [d])).stage).toBe('vyhráno')
      expect(await engagementsOf(db, d)).toHaveLength(0)
      expect(await count(db, 'task', `deal_id = ${d}`)).toBe(0)
      expect(await count(db, 'sales_activity', `deal_id = ${d} and source = 'auto_delivery'`)).toBe(0)
      const [failed] = await audits(db, `action = '${AUTO_DELIVERY_AUDIT_ACTIONS.failed}' and entity_id = ${d}`)
      expect(failed).toMatchObject({ actor_type: 'user', actor_id: U_SALES, after: { sqlstate: 'XX999', via: 'trigger' } })
      expect(notices.some((n) => n.startsWith('WARNING') && n.includes('nepodařilo založit'))).toBe(true)
      // Po opravě založí dodávku záložní RPC.
      await db.exec('DROP TRIGGER test_boom ON task')
      await as(db, { role: 'authenticated', sub: U_SALES }, 'SELECT ensure_deal_delivery(' + d + ');')
      expect(await engagementsOf(db, d)).toHaveLength(1)
    })
  })

  // ------------------------------------------------------------------ RPC
  describe('RPC ensure_deal_delivery', () => {
    let db: Db
    const rpc = async (sub: string | null, dealId: number, aal = 'aal2') => {
      const claims = JSON.stringify({ role: 'authenticated', aal, ...(sub ? { sub } : {}) })
      await db.exec(`BEGIN; SELECT set_config('request.jwt.claims', '${claims}', true); SET LOCAL ROLE authenticated;`)
      try {
        return (await db.query<{ r: { engagement_id: number; created: boolean } }>(`SELECT ensure_deal_delivery(${dealId}) AS r`)).rows[0].r
      } finally {
        await db.exec('COMMIT').catch(() => db.exec('ROLLBACK'))
      }
    }
    beforeAll(async () => {
      db = await fresh()
      account = await newAccount(db)
    }, 60_000)

    test('brána: bez přihlášení, bez AAL2, jiná než obchodní role, nevyhraný obchod', async () => {
      const wonDeal = await newDeal(db, { stage: 'vyhráno' })
      await db.exec(`DELETE FROM engagement WHERE deal_id = ${wonDeal}`)
      const open = await newDeal(db, { stage: 'diagnostika' })
      await expect(rpc(null, wonDeal)).rejects.toThrow(/Nepřihlášený/)
      await expect(rpc(U_SALES, wonDeal, 'aal1')).rejects.toThrow(/AAL2/)
      await expect(rpc(U_PM, wonDeal)).rejects.toThrow(/obchodní role/)
      await expect(rpc(U_SALES, open)).rejects.toThrow(/jen z vyhraného obchodu/)
      await expect(rpc(U_SALES, 987654)).rejects.toThrow(/neexistuje/)
      expect(await engagementsOf(db, wonDeal)).toHaveLength(0)
    })

    test('vyhraný obchod bez dodávky: založí, podruhé vrátí tutéž (created=false), audit via rpc', async () => {
      const dealId = await newDeal(db, { title: 'Záložní tlačítko', stage: 'vyhráno' })
      await db.exec(`DELETE FROM engagement WHERE deal_id = ${dealId}`)
      const first = await rpc(U_SALES, dealId)
      const second = await rpc(U_SALES, dealId)
      expect(first.created).toBe(true)
      expect(second).toEqual({ engagement_id: first.engagement_id, created: false })
      expect(await engagementsOf(db, dealId)).toHaveLength(1)
      const events = await audits(db, `action = '${AUTO_DELIVERY_AUDIT_ACTIONS.created}' and entity_id = ${dealId}`)
      expect(events.map((e) => (e.after as { via: string }).via)).toEqual(['trigger', 'rpc'])
    })

    test('klientské role nesmí volat jádro ani trigger funkce; anon nemá ani RPC', async () => {
      for (const fn of ['auto_delivery_create(1)', 'auto_delivery_on_deal_won()', 'engagement_origin_guard()']) {
        await expect(as(db, { role: 'authenticated', sub: U_SALES }, `SELECT ${fn};`)).rejects.toThrow(/permission denied/)
      }
      await expect(as(db, { role: 'anon' }, 'SELECT ensure_deal_delivery(1);')).rejects.toThrow(/permission denied/)
    })
  })

  // ------------------------------------------------------------------ strážce původu a unikátní vazba
  describe('původ dodávky a unikátní vazba', () => {
    let db: Db
    beforeAll(async () => {
      db = await fresh()
      account = await newAccount(db)
      await db.exec('GRANT SELECT, INSERT, UPDATE ON engagement TO authenticated')
      await db.exec(`CREATE POLICY t ON engagement FOR ALL TO authenticated USING (true) WITH CHECK (true)`)
    }, 60_000)

    test('klient si nemůže označit dodávku za automatickou ani původ změnit', async () => {
      const d = await newDeal(db)
      await expect(as(db, { role: 'authenticated', sub: U_SALES },
        `INSERT INTO engagement (account_id, deal_id, kind, origin) VALUES (${account}, ${d}, 'edu', '${AUTO}');`)).rejects.toThrow(/zakládá jen Cockpit/)
      await as(db, { role: 'authenticated', sub: U_SALES }, `INSERT INTO engagement (account_id, deal_id, kind) VALUES (${account}, ${d}, 'edu');`)
      expect((await engagementsOf(db, d))[0].origin).toBe('manual')
      await expect(as(db, { role: 'authenticated', sub: U_SALES }, `UPDATE engagement SET origin = '${AUTO}' WHERE deal_id = ${d};`)).rejects.toThrow(/Původ dodávky nejde změnit/)
      // Běžná úprava dodávky (bez origin) projde.
      await as(db, { role: 'authenticated', sub: U_SALES }, `UPDATE engagement SET kind = 'it' WHERE deal_id = ${d};`)
    })

    test('unikátní index: druhá automatická dodávka téhož obchodu neprojde, ruční doplňkové ano', async () => {
      const d = await newDeal(db, { stage: 'vyhráno' })
      expect(await engagementsOf(db, d)).toHaveLength(1)
      await db.exec(`SELECT set_config('app.auto_delivery', '${d}', false)`)
      await expect(db.exec(`INSERT INTO engagement (account_id, deal_id, kind, origin) VALUES (${account}, ${d}, 'edu', '${AUTO}')`)).rejects.toThrow(/engagement_auto_deal_uidx/)
      await db.exec(`SELECT set_config('app.auto_delivery', '', false)`)
      // Původ jiný než dovolené hodnoty zamítne CHECK.
      await expect(db.exec(`INSERT INTO engagement (account_id, deal_id, kind, origin) VALUES (${account}, ${d}, 'edu', 'jine')`)).rejects.toThrow(/engagement_origin_check/)
      // Ruční dodávka téhož obchodu (workshop + pilot) zůstává možná.
      await db.exec(`INSERT INTO engagement (account_id, deal_id, kind) VALUES (${account}, ${d}, 'it')`)
      expect(await engagementsOf(db, d)).toHaveLength(2)
    })
  })

  // ------------------------------------------------------------------ backfill
  describe('backfill', () => {
    test('založí dodávky jen vyhraným obchodům bez dodávky; datum výhry, aktér migrace, počet v ledgeru; druhý běh nic', async () => {
      let ids: Record<string, number> = {}
      const db = await fresh(async (pre) => {
        // Data „před migrací": sloupec origin ještě neexistuje, proto vkládáme bez něj.
        await pre.exec(`INSERT INTO account (name, owner_id) VALUES ('Servis Climax', '${U_SALES}')`)
        const acc = (await pre.query<{ id: number }>('select id from account')).rows[0].id
        const mk = async (title: string, stage: string) => (await pre.query<{ id: number }>(
          `insert into deal (account_id, title, owner_id, stage) values (${acc}, '${title}', '${U_SALES}', '${stage}') returning id`)).rows[0].id
        // Triggery ještě nejsou (migrace neběžela) → vyhrané obchody vznikají bez dodávky.
        ids = {
          wonOld: await mk('Vyhraný v červenci', 'vyhráno'),
          wonWithManual: await mk('Vyhraný s ruční dodávkou', 'vyhráno'),
          open: await mk('Otevřený', 'rozsah_nabidka'),
          lost: await mk('Prohraný', 'prohráno'),
          wonRunning: await mk('Vyhraný a běží', 'vyhráno'),
        }
        await pre.exec(`UPDATE deal SET closed_at = '2026-07-20' WHERE id = ${ids.wonOld}`)
        await pre.exec(`UPDATE deal SET won_at = '2026-08-15', closed_at = '2026-08-20', pillar = 'cheesecaky', phase = 'realizovano' WHERE id = ${ids.wonRunning}`)
        await pre.exec(`INSERT INTO engagement (account_id, deal_id, kind) VALUES (${acc}, ${ids.wonWithManual}, 'edu')`)
      })
      const eng = (id: number) => engagementsOf(db, id)
      expect(await eng(ids.wonOld)).toHaveLength(1)
      expect(await eng(ids.wonRunning)).toHaveLength(1)
      expect(await eng(ids.wonWithManual)).toHaveLength(1)
      expect((await eng(ids.wonWithManual))[0].origin).toBe('manual')
      expect(await eng(ids.open)).toHaveLength(0)
      expect(await eng(ids.lost)).toHaveLength(0)

      // Začátek = datum výhry (won_at, jinak closed_at), fáze podle legacy fáze obchodu.
      expect((await eng(ids.wonOld))[0].started_txt).toBe('2026-07-20')
      expect((await eng(ids.wonRunning))[0].started_txt).toBe('2026-08-15')
      expect((await eng(ids.wonRunning))[0]).toMatchObject({ phase: 'implementace', origin: AUTO })
      // Úkol se počítá od dneška, ne od data výhry.
      const task = await one<{ due_txt: string }>(db, 'select due_on::text as due_txt from task where deal_id = $1', [ids.wonOld])
      expect(task.due_txt).toBe(plusWorkingDays(pragueToday(), COMPANY.autoDelivery!.startTask.workingDays))

      const events = await audits(db, `action = '${AUTO_DELIVERY_AUDIT_ACTIONS.created}'`)
      expect(events).toHaveLength(2)
      expect(events.every((e) => e.actor_type === 'system' && e.actor_id === 'migration:0080' && e.info_state === null)).toBe(true)
      expect(events.every((e) => (e.after as { via: string }).via === 'backfill')).toBe(true)
      expect((await one<{ note: string }>(db, `select note from schema_migration where version = '0080'`)).note).toMatch(/backfill zalozil 2 dodavek/)
      expect(notices.some((n) => n.includes('založeno 2 dodávek'))).toBe(true)

      const snapshot = [await count(db, 'engagement'), await count(db, 'task'), await count(db, 'audit_event')]
      await db.exec(MIG)
      expect([await count(db, 'engagement'), await count(db, 'task'), await count(db, 'audit_event')]).toEqual(snapshot)
    }, 60_000)
  })

  // ------------------------------------------------------------------ čisté funkce
  describe('pomocné funkce', () => {
    let db: Db
    beforeAll(async () => { db = await fresh() }, 60_000)
    const val = async (sql: string) => Object.values(await one<Row>(db, `select ${sql} as v`))[0]

    test('šablony milníků z databáze == config, neznámý klíč = výchozí „jine"', async () => {
      const cfg = COMPANY.autoDelivery!.milestoneTemplates
      for (const [key, titles] of Object.entries(cfg)) {
        expect((await q<{ title: string }>(db, `select title from auto_delivery_milestones('${key}') order by pos`)).map((r) => r.title)).toEqual([...titles])
      }
      expect((await q<{ title: string }>(db, `select title from auto_delivery_milestones('neznámý') order by pos`)).map((r) => r.title)).toEqual([...cfg.jine])
      expect((await q<{ title: string }>(db, `select title from auto_delivery_milestones(NULL) order by pos`)).map((r) => r.title)).toEqual([...cfg.jine])
    })

    test('klíč šablony: výslovný typ má přednost, jinak produktová linka', async () => {
      const cases: [string | null, string | null, string][] = [
        ['workshop', 'svatebni_hostina', 'workshop'], ['implementace', 'oslava_soukroma', 'implementace'], ['provoz', null, 'provoz'],
        ['jine', 'oslava_soukroma', 'jine'], [null, 'catering_firemni', 'implementace'], [null, 'oslava_soukroma', 'implementace'],
        [null, 'svatebni_hostina', 'implementace'], [null, 'cheesecaky_eshop', 'implementace'], [null, 'pronajem_prostor', 'implementace'],
        [null, 'firemni_pravidelny', 'provoz'], [null, 'provize', 'jine'], ['', 'oslava_soukroma', 'implementace'], [null, null, 'jine'],
      ]
      const lit = (v: string | null) => (v === null ? 'NULL' : `'${v}'`)
      for (const [kind, line, expected] of cases) {
        expect(await val(`auto_delivery_template_key(${lit(kind)}, ${lit(line)})`), `${kind}/${line}`).toBe(expected)
      }
    })

    test('druh dodávky z produktové linky', async () => {
      const expected: Record<string, string> = {
        catering_firemni: 'edu', oslava_soukroma: 'edu', svatebni_hostina: 'it', cheesecaky_eshop: 'it', pronajem_prostor: 'it',
        firemni_pravidelny: 'platform', provize: 'platform',
      }
      for (const [line, kind] of Object.entries(expected)) expect(await val(`auto_delivery_engagement_kind('${line}')`), line).toBe(kind)
    })

    test('každá „vyhraná" fáze pilíře z configu dostane skutečnou fázi dodávky, ne výchozí', async () => {
      const valid = ['sm_diagnostika', 'workshopy', 'analyza', 'pilot', 'implementace', 'podpora', 'mereni_6m', 'uzavreno']
      for (const [pillar, phases] of Object.entries(COMPANY.wonPhases)) {
        for (const phase of phases) {
          const r = String(await val(`auto_delivery_phase('edu', '${pillar}', '${phase}')`))
          expect(valid, `${pillar}/${phase}`).toContain(r)
          expect(r, `${pillar}/${phase} spadlo na výchozí`).not.toBe('sm_diagnostika')
        }
      }
      expect(await val(`auto_delivery_phase('it', NULL, NULL)`)).toBe('sm_diagnostika')
      expect(await val(`auto_delivery_phase('platform', NULL, NULL)`)).toBe('podpora')
      expect(await val(`auto_delivery_phase('edu', 'b2b_akce', 'poptavka')`)).toBe('sm_diagnostika')
    })

    test('pracovní dny: přeskočí víkend, nula dnů = stejný den', async () => {
      const cases: [string, number, string][] = [
        ['2026-10-01', 3, '2026-10-06'], // čt → út
        ['2026-10-02', 3, '2026-10-07'], // pá → st
        ['2026-10-03', 3, '2026-10-07'], // so → st
        ['2026-10-05', 3, '2026-10-08'], // po → čt
        ['2026-10-05', 0, '2026-10-05'],
        ['2026-10-02', 1, '2026-10-05'],
      ]
      for (const [from, n, expected] of cases) {
        expect(String(await val(`auto_delivery_add_working_days('${from}'::date, ${n})::text`)), `${from}+${n}`).toBe(expected)
        expect(plusWorkingDays(from, n)).toBe(expected)
      }
    })
  })
})
