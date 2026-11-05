// 0088 v opravdovém Postgresu (PGlite = PostgreSQL ve WASM), bez sítě a bez
// živé DB: hlavní metrika dopadu (sloupce, CHECKy, razítko „nelze měřit",
// převod starých polí Adopce %) a transfer_member_work (předání práce člověka
// jednou transakcí s auditem). PGlite NENÍ závislost projektu: bez
// `npm i --no-save @electric-sql/pglite` se soubor přeskočí. Statické kontroly
// téže migrace běží vždy (test/impact-metric.test.ts, test/member-work.test.ts).
//
// Schéma = test/helpers/auditPgliteSchema.ts + zjednodušené kopie tabulek
// a sloupců z 0039/0042/0061/0062/0069 a audit z 0035/0064/0082 (skutečné
// migrace). Požadavek PostgRESTu se simuluje transakcí se
// set_config('request.jwt.claims' | 'request.headers') a SET LOCAL ROLE.
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, test } from 'vitest'
import { AUDIT_SCHEMA as SCHEMA, U_PM } from './helpers/auditPgliteSchema'

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
const M0088 = readFileSync('supabase/migrations/0088_impact_metric_owner_transfer.sql', 'utf8')
const M0035 = readFileSync('supabase/migrations/0035_deal_audit_hardening.sql', 'utf8')
  .replace(/DO \$\$\nDECLARE\n  v_sig text;[\s\S]*?END \$\$;/, '')
  .replace(/INSERT INTO schema_migration[\s\S]*$/, '')

const ADMIN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const FROM = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const TO = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const PARTNER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const GONE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const TODAY = '2026-09-29'

// Doplněk schématu: sloupce a tabulky, které 0082 a 0088 potřebují (kopie
// z 0039/0042/0061/0062/0069 včetně CHECKů „zástupce ≠ vlastník").
const EXTRA = `
ALTER ROLE service_role BYPASSRLS;
ALTER TABLE team_member ADD COLUMN email text, ADD COLUMN is_admin boolean NOT NULL DEFAULT false,
  ADD COLUMN manager_id uuid, ADD COLUMN deactivated_at timestamptz, ADD COLUMN weekly_capacity_hours numeric DEFAULT 40;
INSERT INTO team_member (id, role, full_name, email, is_admin) VALUES
  ('${ADMIN}', 'vedeni', 'Správce', 'admin@enter.cz', true),
  ('${FROM}', 'projektak', 'Odchází', 'from@enter.cz', false),
  ('${TO}', 'projektak', 'Přebírá', 'to@enter.cz', false),
  ('${PARTNER}', 'partner', 'Partner', 'p@firma.cz', false);
INSERT INTO team_member (id, role, full_name, email, deactivated_at) VALUES ('${GONE}', 'projektak', 'Pryč', 'gone@enter.cz', now());
CREATE FUNCTION is_admin() RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM team_member WHERE id = auth.uid() AND is_admin) $$;
ALTER TABLE engagement ADD COLUMN owner_id uuid REFERENCES team_member(id) ON DELETE SET NULL,
  ADD COLUMN deputy_id uuid REFERENCES team_member(id) ON DELETE SET NULL, ADD COLUMN delivery_team text,
  ADD CONSTRAINT engagement_deputy_check CHECK (deputy_id IS NULL OR owner_id IS NULL OR deputy_id <> owner_id);
ALTER TABLE engagement_milestone ADD CONSTRAINT engagement_milestone_deputy_check CHECK (deputy_id IS NULL OR owner_id IS NULL OR deputy_id <> owner_id);
ALTER TABLE work_case ADD CONSTRAINT work_case_deputy_differs CHECK (deputy_id IS NULL OR lead_owner_id IS NULL OR deputy_id <> lead_owner_id);
CREATE TABLE loop_node (node text PRIMARY KEY, owner_id uuid, deputy_id uuid, updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT loop_node_deputy_differs CHECK (deputy_id IS NULL OR owner_id IS NULL OR deputy_id <> owner_id));
CREATE TABLE allocation (id bigserial PRIMARY KEY, member_id uuid NOT NULL, engagement_id bigint, work_case_id bigint,
  hours_per_week numeric(4,1) NOT NULL, starts_on date NOT NULL, ends_on date, substitute_id uuid, note text, created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT allocation_period_check CHECK (ends_on IS NULL OR ends_on >= starts_on),
  CONSTRAINT allocation_substitute_differs CHECK (substitute_id IS NULL OR substitute_id <> member_id));
CREATE TABLE metric_observation (id bigserial PRIMARY KEY, engagement_id bigint NOT NULL REFERENCES engagement(id) ON DELETE CASCADE,
  metric text NOT NULL, unit text, baseline numeric, actual numeric, observed_on date NOT NULL, evidence_id bigint REFERENCES evidence(id),
  note text, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT metric_observation_value_check CHECK (baseline IS NOT NULL OR actual IS NOT NULL));
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

describe.skipIf(!PGliteCtor)('0088 v Postgresu (PGlite)', () => {
  let db: Db
  const notices: string[] = []
  const run = (sql: string) => db.exec(sql, { onNotice: (n) => notices.push(`${n.severity}: ${n.message}`) })

  // Jeden požadavek (transakce) jako daná role; vrátí řádky posledního dotazu.
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
  const asAdminService = (sql: string, params: unknown[] = []) =>
    as<{ r: Record<string, number> }>({ role: 'service_role', headers: { 'x-cockpit-audit-actor': `user:${ADMIN}` } }, sql, params)
  const transfer = (from: string, to: string, actor = ADMIN, kinds = '{klienti,obchody,dodavky,milniky,ukoly,pripady,alokace,oblasti}') =>
    asAdminService(`SELECT transfer_member_work($1, $2, $3, $4::text[], $5::date) AS r`, [from, to, actor, kinds, TODAY])

  let accountId = 0
  const eng: Record<string, number> = {}

  beforeAll(async () => {
    db = new PGliteCtor!()
    await run(SCHEMA)
    await run(EXTRA)
    await run(M0035)
    await run(M0064)
    await run(M0082)
    accountId = (await one<{ id: number }>(`INSERT INTO account (name, owner_id) VALUES ('Firma', '${FROM}') RETURNING id`)).id
    // Stará pole Adopce % před 0088: vzdělávání, IT s „nulou kvůli kontrole", IT se skutečnou adopcí.
    for (const [k, kind, base, post] of [['edu', 'edu', 17, 78], ['itZero', 'it', 0, null], ['itReal', 'it', 35, null]] as const) {
      eng[k] = (await one<{ id: number }>(
        `INSERT INTO engagement (account_id, kind, baseline_adoption_pct, post_adoption_pct, baseline_captured_on) VALUES ($1, $2, $3, $4, '2026-06-01') RETURNING id`,
        [accountId, kind, base, post],
      )).id
    }
    notices.length = 0
    await run(M0088)
    await run(M0088) // idempotence
  }, 120_000)

  test('idempotence: ledger jednou, trigger jednou, převod nezdvojený', async () => {
    expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM schema_migration WHERE version = '0088'`)).n).toBe(1)
    expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'engagement_impact_unmeasurable_stamp'`)).n).toBe(1)
    expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM metric_observation WHERE metric_key = 'adopce'`)).n).toBe(2)
    expect(notices.filter((n) => n.startsWith('WARNING'))).toEqual([])
    expect(notices.filter((n) => n.includes('0088: převedeno'))).toHaveLength(1)
  })

  test('převod Adopce %: vzdělávání ano, falešná nula u IT ne, skutečná adopce u IT s volbou metriky', async () => {
    const rows = (await db.query<{ engagement_id: number; baseline: string; actual: string | null; unit: string; observed_on: string }>(
      `SELECT engagement_id, baseline::text, actual::text, unit, observed_on::text FROM metric_observation ORDER BY engagement_id`,
    )).rows
    expect(rows).toEqual([
      { engagement_id: eng.edu, baseline: '17.00', actual: '78.00', unit: '%', observed_on: '2026-06-01' },
      { engagement_id: eng.itReal, baseline: '35.00', actual: null, unit: '%', observed_on: '2026-06-01' },
    ])
    const keys = (await db.query<{ id: number; impact_metric_key: string | null }>(`SELECT id, impact_metric_key FROM engagement ORDER BY id`)).rows
    expect(keys).toEqual([
      { id: eng.edu, impact_metric_key: null },
      { id: eng.itZero, impact_metric_key: null },
      { id: eng.itReal, impact_metric_key: 'adopce' },
    ])
  })

  test('„zatím nelze měřit": kdo a kdy z DB, nejde podvrhnout; krátký důvod neprojde', async () => {
    await as({ role: 'authenticated', sub: U_PM }, `UPDATE engagement SET impact_unmeasurable_reason = 'Data z ERP až v listopadu.', impact_unmeasurable_by = '${ADMIN}', impact_unmeasurable_at = '2020-01-01' WHERE id = ${eng.itZero}`)
    let r = await one<{ by: string; at: string }>(`SELECT impact_unmeasurable_by AS by, impact_unmeasurable_at::text AS at FROM engagement WHERE id = ${eng.itZero}`)
    expect(r.by).toBe(U_PM)
    expect(r.at.startsWith('2020')).toBe(false)
    // Bez změny důvodu se razítko nepřepíše.
    await as({ role: 'authenticated', sub: ADMIN }, `UPDATE engagement SET impact_unmeasurable_by = '${ADMIN}', impact_metric_key = 'chybovost' WHERE id = ${eng.itZero}`)
    r = await one(`SELECT impact_unmeasurable_by AS by, impact_unmeasurable_at::text AS at FROM engagement WHERE id = ${eng.itZero}`)
    expect(r.by).toBe(U_PM)
    await expect(as({ role: 'authenticated', sub: U_PM }, `UPDATE engagement SET impact_unmeasurable_reason = 'nevím' WHERE id = ${eng.itZero}`))
      .rejects.toThrow(/engagement_impact_unmeasurable_check/)
    // Zrušení důvodu smaže i razítko.
    await as({ role: 'authenticated', sub: U_PM }, `UPDATE engagement SET impact_unmeasurable_reason = NULL WHERE id = ${eng.itZero}`)
    expect(await one(`SELECT impact_unmeasurable_by AS by, impact_unmeasurable_at AS at FROM engagement WHERE id = ${eng.itZero}`)).toEqual({ by: null, at: null })
  })

  test('peníze a špatný klíč metriky DB odmítne', async () => {
    await expect(run(`UPDATE engagement SET impact_metric_key = 'vlastni', impact_metric_label = 'Úspora v Kč', impact_metric_unit = 'ks' WHERE id = ${eng.edu}`))
      .rejects.toThrow(/engagement_impact_no_currency_check/)
    await expect(run(`UPDATE engagement SET impact_metric_unit = 'EUR' WHERE id = ${eng.edu}`)).rejects.toThrow(/no_currency/)
    await expect(run(`UPDATE engagement SET impact_metric_key = 'Čas na úkon' WHERE id = ${eng.edu}`)).rejects.toThrow(/impact_metric_key_check/)
    await expect(run(`INSERT INTO metric_observation (engagement_id, metric, baseline, observed_on, metric_key) VALUES (${eng.edu}, 'x', 1, '2026-09-01', 'X')`))
      .rejects.toThrow(/metric_observation_metric_key_check/)
  })

  describe('transfer_member_work', () => {
    const ids: Record<string, number> = {}
    beforeAll(async () => {
      const ins = async (sql: string) => (await one<{ id: number }>(`${sql} RETURNING id`)).id
      ids.dealOpen = await ins(`INSERT INTO deal (account_id, title, stage, owner_id) VALUES (${accountId}, 'Otevřený', 'kvalifikace', '${FROM}')`)
      ids.dealWon = await ins(`INSERT INTO deal (account_id, title, stage, owner_id) VALUES (${accountId}, 'Vyhraný', 'vyhráno', '${FROM}')`)
      ids.engA = await ins(`INSERT INTO engagement (account_id, kind, phase, owner_id, deputy_id) VALUES (${accountId}, 'it', 'analyza', '${FROM}', '${TO}')`)
      ids.engB = await ins(`INSERT INTO engagement (account_id, kind, phase, owner_id, deputy_id) VALUES (${accountId}, 'it', 'pilot', '${U_PM}', '${FROM}')`)
      ids.engClosed = await ins(`INSERT INTO engagement (account_id, kind, phase, owner_id) VALUES (${accountId}, 'edu', 'uzavreno', '${FROM}')`)
      ids.msOpen = await ins(`INSERT INTO engagement_milestone (engagement_id, title, status, owner_id) VALUES (${ids.engA}, 'Mapa', 'v_praci', '${FROM}')`)
      await run(`INSERT INTO evidence (source_kind, source_id) VALUES ('file', 'm1')`)
      ids.msClosed = await ins(`INSERT INTO engagement_milestone (engagement_id, title, status, owner_id, accepted_at, acceptance_evidence_id)
        VALUES (${ids.engA}, 'Hotovo', 'uzavreno', '${FROM}', now(), (SELECT max(id) FROM evidence))`)
      ids.taskOpen = await ins(`INSERT INTO task (title, status, assignee_id) VALUES ('Otevřený', 'todo', '${FROM}')`)
      ids.taskDone = await ins(`INSERT INTO task (title, status, assignee_id) VALUES ('Hotový', 'done', '${FROM}')`)
      ids.caseOpen = await ins(`INSERT INTO work_case (title, node, status, lead_owner_id, created_by) VALUES ('Případ', 'eventy', 'in_progress', '${FROM}', 'system:test')`)
      ids.caseCancelled = await ins(`INSERT INTO work_case (title, node, status, lead_owner_id, created_by) VALUES ('Zrušený', 'eventy', 'cancelled', '${FROM}', 'system:test')`)
      ids.allocRunning = await ins(`INSERT INTO allocation (member_id, engagement_id, hours_per_week, starts_on, substitute_id, note) VALUES ('${FROM}', ${ids.engA}, 8, '2026-09-01', '${TO}', 'poznámka')`)
      ids.allocFuture = await ins(`INSERT INTO allocation (member_id, engagement_id, hours_per_week, starts_on, ends_on) VALUES ('${FROM}', ${ids.engA}, 4, '2026-10-15', '2026-12-31')`)
      ids.allocEnded = await ins(`INSERT INTO allocation (member_id, engagement_id, hours_per_week, starts_on, ends_on) VALUES ('${FROM}', ${ids.engA}, 4, '2026-08-01', '2026-09-10')`)
      ids.allocSub = await ins(`INSERT INTO allocation (member_id, engagement_id, hours_per_week, starts_on, substitute_id) VALUES ('${U_PM}', ${ids.engB}, 10, '2026-09-01', '${FROM}')`)
      await run(`INSERT INTO loop_node (node, owner_id, deputy_id) VALUES ('eventy', '${FROM}', '${TO}'), ('vedeni', '${U_PM}', '${FROM}')`)
    })

    test('chyby: sám sobě, Partner, deaktivovaný, aktér bez správce, neznámý druh', async () => {
      await expect(transfer(FROM, FROM)).rejects.toThrow(/témuž člověku/)
      await expect(transfer(FROM, PARTNER)).rejects.toThrow(/interní rolí/)
      await expect(transfer(FROM, GONE)).rejects.toThrow(/interní rolí/)
      await expect(transfer(FROM, TO, U_PM)).rejects.toThrow(/správce/)
      await expect(transfer(FROM, TO, ADMIN, '{ukoly,vse}')).rejects.toThrow(/Neznámý druh/)
      await expect(transfer(FROM, TO, ADMIN, '{}')).rejects.toThrow(/Neznámý druh/)
      // Nic se nepohnulo.
      expect((await one<{ a: string }>(`SELECT assignee_id AS a FROM task WHERE id = ${ids.taskOpen}`)).a).toBe(FROM)
    })

    test('přihlášený uživatel funkci volat nesmí (jen service_role)', async () => {
      await expect(as({ role: 'authenticated', sub: ADMIN }, `SELECT transfer_member_work('${FROM}', '${TO}', '${ADMIN}', '{ukoly}', '${TODAY}')`))
        .rejects.toThrow(/permission denied/)
    })

    test('předá jen otevřenou práci, zástup uvolní, alokace rozdělí; souhrn i řádky v auditu s aktérem', async () => {
      const auditBefore = (await one<{ n: number }>(`SELECT max(id)::int AS n FROM audit_event`)).n
      const [{ r }] = await transfer(FROM, TO)
      expect(r).toEqual({ klienti: 1, obchody: 1, dodavky: 2, milniky: 1, ukoly: 1, pripady: 1, alokace: 3, oblasti: 2, bez_zastupce: 2 })

      const q = async (sql: string) => (await db.query<Row>(sql)).rows
      expect(await q(`SELECT owner_id FROM account WHERE id = ${accountId}`)).toEqual([{ owner_id: TO }])
      expect(await q(`SELECT id, owner_id FROM deal WHERE id IN (${ids.dealOpen}, ${ids.dealWon}) ORDER BY id`))
        .toEqual([{ id: ids.dealOpen, owner_id: TO }, { id: ids.dealWon, owner_id: FROM }])
      expect(await q(`SELECT id, owner_id, deputy_id FROM engagement WHERE id IN (${ids.engA}, ${ids.engB}, ${ids.engClosed}) ORDER BY id`)).toEqual([
        { id: ids.engA, owner_id: TO, deputy_id: null },
        { id: ids.engB, owner_id: U_PM, deputy_id: TO },
        { id: ids.engClosed, owner_id: FROM, deputy_id: null },
      ])
      expect(await q(`SELECT id, owner_id FROM engagement_milestone ORDER BY id`))
        .toEqual([{ id: ids.msOpen, owner_id: TO }, { id: ids.msClosed, owner_id: FROM }])
      expect(await q(`SELECT id, assignee_id FROM task WHERE id IN (${ids.taskOpen}, ${ids.taskDone}) ORDER BY id`))
        .toEqual([{ id: ids.taskOpen, assignee_id: TO }, { id: ids.taskDone, assignee_id: FROM }])
      expect(await q(`SELECT id, lead_owner_id FROM work_case ORDER BY id`))
        .toEqual([{ id: ids.caseOpen, lead_owner_id: TO }, { id: ids.caseCancelled, lead_owner_id: FROM }])
      expect(await q(`SELECT node, owner_id, deputy_id FROM loop_node ORDER BY node`)).toEqual([
        { node: 'eventy', owner_id: TO, deputy_id: null },
        { node: 'vedeni', owner_id: U_PM, deputy_id: TO },
      ])
      // Alokace: běžící ukončena včerejškem + pokračování od dneška, budoucí přepsaná, skončená beze změny, zástup přepsaný.
      expect(await q(`SELECT member_id, starts_on::text, ends_on::text, substitute_id, note, created_by FROM allocation ORDER BY id`)).toEqual([
        { member_id: FROM, starts_on: '2026-09-01', ends_on: '2026-09-28', substitute_id: TO, note: 'poznámka', created_by: null },
        { member_id: TO, starts_on: '2026-10-15', ends_on: '2026-12-31', substitute_id: null, note: null, created_by: null },
        { member_id: FROM, starts_on: '2026-08-01', ends_on: '2026-09-10', substitute_id: null, note: null, created_by: null },
        { member_id: U_PM, starts_on: '2026-09-01', ends_on: null, substitute_id: TO, note: null, created_by: null },
        { member_id: TO, starts_on: TODAY, ends_on: null, substitute_id: null, note: 'poznámka', created_by: ADMIN },
      ])

      const summary = await one<Row>(`SELECT * FROM audit_event WHERE action = 'team_member.work_transferred'`)
      expect(summary).toMatchObject({ actor_type: 'user', actor_id: ADMIN, entity_table: 'team_member', entity_id: null, entity_ref: FROM, info_state: 'human_confirmed' })
      expect(summary.after).toMatchObject({ to_member_id: TO, on: TODAY, counts: { ukoly: 1, bez_zastupce: 2 } })
      expect(JSON.stringify(summary)).not.toMatch(/Otevřený|poznámka|@enter/)
      // Řádkový audit změn nese správce z hlavičky.
      const taskAudit = await one<Row>(`SELECT * FROM audit_event WHERE entity_table = 'task' AND entity_id = ${ids.taskOpen} AND id > ${auditBefore} ORDER BY id DESC LIMIT 1`)
      expect(taskAudit).toMatchObject({ action: 'task.updated', actor_type: 'user', actor_id: ADMIN })
      expect(taskAudit.after).toMatchObject({ assignee_id: TO })
      const nodeAudit = await one<{ n: number }>(`SELECT count(*)::int AS n FROM audit_event WHERE entity_table = 'loop_node' AND actor_id = '${ADMIN}' AND id > ${auditBefore}`)
      expect(nodeAudit.n).toBe(2)
    })

    test('opakované předání nic nezmění a souhrn do auditu nepřidá', async () => {
      const [{ r }] = await transfer(FROM, TO)
      expect(r).toEqual({ klienti: 0, obchody: 0, dodavky: 0, milniky: 0, ukoly: 0, pripady: 0, alokace: 0, oblasti: 0, bez_zastupce: 0 })
      expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM audit_event WHERE action = 'team_member.work_transferred'`)).n).toBe(1)
    })

    test('předat jde i od deaktivovaného člověka (úklid po odchodu), jen vybrané druhy', async () => {
      await run(`INSERT INTO task (title, status, assignee_id) VALUES ('Po odchodu', 'todo', '${GONE}'), ('Jiný', 'todo', '${GONE}')`)
      await run(`UPDATE account SET owner_id = '${GONE}' WHERE id = ${accountId}`)
      const [{ r }] = await transfer(GONE, TO, ADMIN, '{ukoly}')
      expect(r).toEqual({ ukoly: 2, bez_zastupce: 0 })
      expect((await one<{ o: string }>(`SELECT owner_id AS o FROM account WHERE id = ${accountId}`)).o).toBe(GONE)
    })
  })
})
