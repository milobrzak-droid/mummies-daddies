// 0098_bulk_import.sql ve skutečném Postgresu (PGlite = PostgreSQL ve WASM):
// atomický zápis zakázky (klient, obchod, verze nabídky, dodávka, finanční
// záznamy), historická zakázka bez falešného úkolu (0080), idempotence přes
// klíče, oprávnění aktéra a vrácení dávky jen tam, kde nevznikla lidská práce.
// Schéma jako test/owner-change-0093-pglite.test.ts (společné AUDIT_SCHEMA), na
// to skutečné migrace 0063, 0072, 0035, 0064, 0082, 0080 a 0098. PGlite je
// devDependency; bez něj se soubor přeskočí (statické kontroly jsou v
// test/bulk-import-migration.test.ts).
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, test } from 'vitest'
import { AUDIT_SCHEMA as SCHEMA, U_PM, U_SALES } from './helpers/auditPgliteSchema'

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
const M0098 = mig('0098_bulk_import.sql')

const ADMIN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const OWNER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const GONE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const SALES2 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'

const EXTRA = `
ALTER ROLE service_role BYPASSRLS;
-- Supabase dává nové tabulce práva rolím sám; migrace je pak jen odebírají.
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO authenticated, service_role, anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated, service_role, anon;
CREATE TYPE deal_currency AS ENUM ('CZK', 'EUR');
CREATE TYPE revenue_line AS ENUM ('catering_firemni','oslava_soukroma','svatebni_hostina','cheesecaky_eshop','firemni_pravidelny','pronajem_prostor','provize');
CREATE TYPE revenue_category AS ENUM ('one_time','recurring','royalty');
CREATE TYPE delivery_phase AS ENUM ('sm_diagnostika','workshopy','analyza','pilot','implementace','podpora','mereni_6m','uzavreno');
ALTER TABLE team_member ADD COLUMN email text, ADD COLUMN is_admin boolean NOT NULL DEFAULT false,
  ADD COLUMN manager_id uuid, ADD COLUMN deactivated_at timestamptz, ADD COLUMN weekly_capacity_hours numeric DEFAULT 40;
INSERT INTO team_member (id, role, full_name, email, is_admin) VALUES
  ('${ADMIN}', 'vedeni', 'Správce', 'admin@enter.cz', true),
  ('${OWNER}', 'projektak', 'Vlastník', 'owner@enter.cz', false),
  ('${SALES2}', 'obchodnik', 'Druhý obchodník', 'sales2@enter.cz', false);
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
CREATE TABLE allocation (id bigserial PRIMARY KEY, member_id uuid NOT NULL, engagement_id bigint REFERENCES engagement(id) ON DELETE CASCADE, work_case_id bigint,
  hours_per_week numeric(4,1) NOT NULL, starts_on date NOT NULL, ends_on date, substitute_id uuid, note text, created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT allocation_period_check CHECK (ends_on IS NULL OR ends_on >= starts_on),
  CONSTRAINT allocation_substitute_differs CHECK (substitute_id IS NULL OR substitute_id <> member_id));
CREATE TABLE metric_observation (id bigserial PRIMARY KEY, engagement_id bigint NOT NULL REFERENCES engagement(id) ON DELETE CASCADE,
  metric text NOT NULL, unit text, baseline numeric, actual numeric, observed_on date NOT NULL, evidence_id bigint REFERENCES evidence(id),
  note text, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT metric_observation_value_check CHECK (baseline IS NOT NULL OR actual IS NOT NULL));
CREATE TABLE case_proposal (id bigserial PRIMARY KEY, capability text NOT NULL, source_key text NOT NULL, occurred_at timestamptz NOT NULL, node text NOT NULL,
  account_id bigint, title text NOT NULL, rationale text NOT NULL, steps jsonb NOT NULL DEFAULT '[]', method text NOT NULL, info_state text NOT NULL DEFAULT 'ai_suggestion',
  evidence_id bigint NOT NULL REFERENCES evidence(id), status text NOT NULL DEFAULT 'pending', created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  decided_by text, decided_at timestamptz, decision_note text, work_case_id bigint);
CREATE TABLE deal_partner (deal_id bigint NOT NULL, partner_id bigint NOT NULL, program text NOT NULL, attribution_pct numeric(5,2) DEFAULT 0,
  is_sourcing boolean NOT NULL DEFAULT false, nnpsa_target integer, PRIMARY KEY (deal_id, partner_id, program));
-- Cizí klíče z 0006 a 0020 (v AUDIT_SCHEMA chybí); vrácení dávky podle nich pozná cizí práci.
ALTER TABLE task ADD FOREIGN KEY (account_id) REFERENCES account(id) ON DELETE SET NULL,
  ADD FOREIGN KEY (deal_id) REFERENCES deal(id) ON DELETE SET NULL, ADD FOREIGN KEY (engagement_id) REFERENCES engagement(id) ON DELETE SET NULL;
ALTER TABLE sales_activity ADD FOREIGN KEY (deal_id) REFERENCES deal(id) ON DELETE SET NULL;
ALTER TABLE engagement ADD FOREIGN KEY (deal_id) REFERENCES deal(id);
CREATE UNIQUE INDEX sales_activity_external_idx ON sales_activity(source, external_id) WHERE external_id IS NOT NULL;
CREATE UNIQUE INDEX account_ico_uniq ON account (ico) WHERE ico IS NOT NULL AND ico <> '';
GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated, service_role, anon;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO authenticated, service_role, anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
`

// Jeden řádek importu (jako ho posílá aplikace).
function row(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    import_keys: [`row:${Math.random().toString(36).slice(2)}`],
    account_id: null,
    new_account: { name: 'Nová firma s.r.o.', ico: null, industry: null, region: null },
    title: 'Datová platforma',
    revenue_line: 'svatebni_hostina',
    revenue_category: 'one_time',
    pillar: null,
    phase: null,
    stage: 'vyhráno',
    probability_pct: 100,
    currency: 'CZK',
    amount: 580000,
    fx_rate: null,
    cogs: null,
    owner_id: OWNER,
    started_on: '2026-03-01',
    due_on: '2026-12-31',
    expected_close: null,
    invoiced: 300000,
    received: 100000,
    estimate_md: null,
    scope: null,
    note: null,
    source_pdf_path: null,
    evidence_id: null,
    ...over,
  }
}

describe.skipIf(!PGliteCtor)('0098 v Postgresu (PGlite)', () => {
  let db: Db
  const notices: string[] = []
  const run = (sql: string) => db.exec(sql, { onNotice: (n) => notices.push(`${n.severity}: ${n.message}`) })

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
  const q = async <T = Row>(sql: string, params: unknown[] = []) => (await db.query<T>(sql, params)).rows
  const count = async (table: string, where = 'true') =>
    (await one<{ n: number }>(`SELECT count(*)::int AS n FROM ${table} WHERE ${where}`)).n
  const svc = <T = Row>(actor: string, sql: string, params: unknown[] = []) =>
    as<T>({ role: 'service_role', headers: { 'x-cockpit-audit-actor': `user:${actor}` } }, sql, params)

  const openBatch = async (actor = U_SALES, kind = 'csv') =>
    (await svc<{ id: number }>(actor, `SELECT import_open_batch($1::uuid, $2, 'test') AS id`, [actor, kind]))[0].id
  type Applied = { status: string; deal_id: number; account_id: number; account_created?: boolean; engagement_id?: number; records?: number }
  const apply = async (batch: number, r: Record<string, unknown>, actor = U_SALES) =>
    (await svc<{ r: Applied }>(actor, `SELECT import_apply_row($1::uuid, $2::bigint, $3::jsonb) AS r`, [actor, batch, JSON.stringify(r)]))[0].r
  type Reverted = { deals_reverted: number; deals_kept: { deal_id: number; reason: string }[]; accounts_deleted: number; accounts_kept: number; records_deleted: number; status: string }
  const revert = async (batch: number, actor = U_SALES) =>
    (await svc<{ r: Reverted }>(actor, `SELECT import_revert_batch($1::uuid, $2::bigint) AS r`, [actor, batch]))[0].r

  beforeAll(async () => {
    db = new PGliteCtor!()
    await run(SCHEMA)
    await run(EXTRA)
    await run(mig('0063_financial_record.sql'))
    await run(mig('0072_deal_scope_version.sql'))
    await run(M0035)
    await run(mig('0064_audit_coverage.sql'))
    await run(mig('0082_audit_gaps_partner_lockdown.sql'))
    await run(mig('0080_auto_delivery.sql'))
    await run(`INSERT INTO loop_node VALUES ('eventy', '${ADMIN}', NULL), ('vedeni', '${ADMIN}', NULL)`)
    await run(M0098)
  }, 180_000)

  test('migrace je idempotentní: ledger jednou, bez varování', async () => {
    notices.length = 0
    await run(M0098)
    expect(await count('schema_migration', "version = '0098'")).toBe(1)
    expect(notices.filter((n) => n.startsWith('WARNING'))).toEqual([])
    // původ obchodu a zdroj import jsou chráněné před klientem
    expect(await count('pg_trigger', "tgname IN ('deal_import_guard', 'financial_record_import_guard')")).toBe(2)
  })

  describe('oprávnění a strážci', () => {
    test('funkce nemá klientské EXECUTE, jen service_role', async () => {
      const acc = await as({ role: 'authenticated', sub: U_SALES }, `SELECT 1`)
      expect(acc).toBeTruthy()
      await expect(as({ role: 'authenticated', sub: U_SALES }, `SELECT import_open_batch($1::uuid, 'csv', 'x')`, [U_SALES]))
        .rejects.toThrow(/permission denied/)
      await expect(as({ role: 'authenticated', sub: U_SALES }, `SELECT import_apply_row($1::uuid, 1, '{}'::jsonb)`, [U_SALES]))
        .rejects.toThrow(/permission denied/)
      await expect(as({ role: 'authenticated', sub: U_SALES }, `SELECT import_revert_batch($1::uuid, 1)`, [U_SALES]))
        .rejects.toThrow(/permission denied/)
    })

    test('aktér bez obchodní role (projekťák, deaktivovaný) dávku neotevře; neznámý druh také ne', async () => {
      await expect(openBatch(U_PM)).rejects.toThrow(/obchodní rolí/)
      await expect(openBatch(GONE)).rejects.toThrow(/obchodní rolí/)
      await expect(svc(U_SALES, `SELECT import_open_batch($1::uuid, 'xls', 'x')`, [U_SALES])).rejects.toThrow(/Neznámý druh/)
    })

    test('klient nezapíše deal.import_batch_id ani zdroj import napřímo', async () => {
      const batch = await openBatch()
      const acc = (await one<{ id: number }>(`INSERT INTO account (name) VALUES ('Ruční firma') RETURNING id`)).id
      await expect(as({ role: 'authenticated', sub: U_SALES },
        `INSERT INTO deal (account_id, title, import_batch_id) VALUES (${acc}, 'Podvrh', ${batch})`)).rejects.toThrow(/jen hromadný import/)
      const d = (await one<{ id: number }>(`INSERT INTO deal (account_id, title) VALUES (${acc}, 'Obyčejný') RETURNING id`)).id
      await expect(as({ role: 'authenticated', sub: U_SALES },
        `UPDATE deal SET import_batch_id = ${batch} WHERE id = ${d}`)).rejects.toThrow(/nejde změnit/)
      await expect(as({ role: 'authenticated', sub: U_SALES },
        `INSERT INTO financial_record (account_id, deal_id, kind, amount, period_month, status, source, created_by)
         VALUES (${acc}, ${d}, 'contracted', 100, '2026-09-01', 'confirmed', 'import', '${U_SALES}')`)).rejects.toThrow(/zdrojem import/)
      await expect(as({ role: 'authenticated', sub: U_SALES },
        `INSERT INTO import_batch (kind, created_by) VALUES ('csv', '${U_SALES}')`)).rejects.toThrow(/permission denied|row-level/)
    })

    test('čtení dávek: obchodní role s AAL2 ano, projekťák a AAL1 ne', async () => {
      const batch = await openBatch()
      const ok = await as({ role: 'authenticated', sub: U_SALES }, `SELECT id FROM import_batch WHERE id = ${batch}`)
      expect(ok).toHaveLength(1)
      expect(await as({ role: 'authenticated', sub: U_PM }, `SELECT id FROM import_batch WHERE id = ${batch}`)).toHaveLength(0)
    })
  })

  describe('zápis vyhrané zakázky', () => {
    let batch = 0
    let r: Applied
    let payload: Record<string, unknown>
    beforeAll(async () => {
      batch = await openBatch()
      payload = row({ import_keys: ['row:won-1', 'pdf:abc'] })
      r = await apply(batch, payload)
    })

    test('vznikne klient, vyhraný obchod se správnou cenou a původem', async () => {
      expect(r).toMatchObject({ status: 'created', account_created: true, records: 3 })
      const d = await one<Row & { won_txt: string }>(`SELECT d.*, d.won_at::text AS won_txt FROM deal d WHERE id = ${r.deal_id}`)
      expect(d).toMatchObject({
        stage: 'vyhráno', title: 'Datová platforma', currency: 'CZK', import_batch_id: batch, owner_id: OWNER,
        forecast_category: 'closed', probability_pct: 100, revenue_category: 'one_time',
      })
      expect(Number(d.amount_one_time)).toBe(580000)
      expect(d.won_txt).toBe('2026-03-01')
      expect(await one(`SELECT name FROM account WHERE id = ${r.account_id}`)).toMatchObject({ name: 'Nová firma s.r.o.' })
    })

    test('verze nabídky je přijatá a nese cenu, kterou klient dostal', async () => {
      const v = await one<Row>(`SELECT * FROM deal_scope_version WHERE deal_id = ${r.deal_id}`)
      expect(v).toMatchObject({ version: 1, status: 'accepted', currency: 'CZK', created_by: U_SALES })
      expect(Number(v.amount_one_time)).toBe(580000)
      expect(v.sent_at).not.toBeNull()
      expect(v.decided_at).not.toBeNull()
    })

    test('dodávka vznikne přes trigger 0080 se skutečným začátkem a termínem, ale BEZ úkolu a aktivity', async () => {
      const e = await one<Row & { started_txt: string; due_txt: string }>(
        `SELECT e.*, e.started_on::text AS started_txt, e.due_on::text AS due_txt FROM engagement e WHERE deal_id = ${r.deal_id}`)
      expect(e).toMatchObject({ id: r.engagement_id, origin: 'auto_deal_won', owner_id: OWNER, kind: 'it' })
      expect(e.started_txt).toBe('2026-03-01')
      expect(e.due_txt).toBe('2026-12-31')
      expect(await count('engagement_milestone', `engagement_id = ${e.id}`)).toBe(4)
      expect(await count('task', `deal_id = ${r.deal_id}`)).toBe(0)
      expect(await count('sales_activity', `deal_id = ${r.deal_id}`)).toBe(0)
      const created = await one<{ after: Row }>(`SELECT after FROM audit_event WHERE action = 'deal.delivery_auto_created' AND entity_id = ${r.deal_id}`)
      expect(created.after).toMatchObject({ imported: true, task_id: null, activity_id: null, milestones: 4 })
    })

    test('finance: Nasmlouváno potvrzeno, Vyfakturováno a Přijato jen jako návrh, zdroj import', async () => {
      const recs = await q<Row>(`SELECT kind, status, source, currency, amount::float8 AS amount, external_ref, engagement_id, created_by FROM financial_record WHERE deal_id = ${r.deal_id} ORDER BY kind`)
      expect(recs).toEqual([
        { kind: 'contracted', status: 'confirmed', source: 'import', currency: 'CZK', amount: 580000, external_ref: null, engagement_id: r.engagement_id, created_by: U_SALES },
        { kind: 'invoiced', status: 'draft', source: 'import', currency: 'CZK', amount: 300000, external_ref: null, engagement_id: r.engagement_id, created_by: U_SALES },
        { kind: 'received', status: 'draft', source: 'import', currency: 'CZK', amount: 100000, external_ref: null, engagement_id: r.engagement_id, created_by: U_SALES },
      ])
    })

    test('položky dávky a klíče idempotence', async () => {
      const items = await q<{ entity_table: string; import_key: string | null }>(
        `SELECT entity_table, import_key FROM import_batch_item WHERE batch_id = ${batch} ORDER BY entity_table, import_key NULLS LAST`)
      expect(items.map((i) => `${i.entity_table}:${i.import_key ?? '-'}`)).toEqual([
        'account:-', 'deal:pdf:abc', 'deal:row:won-1', 'deal_scope_version:-', 'engagement:-',
        'financial_record:-', 'financial_record:-', 'financial_record:-',
      ])
    })

    test('audit: aktér z hlavičky, human_confirmed, žádný text ani částka ve významové události', async () => {
      const ev = await one<Row>(`SELECT * FROM audit_event WHERE action = 'deal.bulk_imported' AND entity_id = ${r.deal_id}`)
      expect(ev).toMatchObject({ actor_type: 'user', actor_id: U_SALES, entity_table: 'deal', info_state: 'human_confirmed', before: null })
      expect(ev.after).toEqual({
        batch_id: batch, source: 'csv', stage: 'vyhráno', account_created: true, engagement_id: r.engagement_id,
        scope_version_id: expect.any(Number), financial_records: 3,
      })
      expect(JSON.stringify(ev)).not.toMatch(/Datová|Nová firma|580000/)
      const rows = await q<Row>(`SELECT action, actor_id FROM audit_event WHERE entity_table IN ('engagement', 'financial_record', 'deal_scope_version', 'import_batch') AND entity_id IN (${r.engagement_id}, ${batch})`)
      expect(rows.length).toBeGreaterThan(0)
      expect(rows.every((x) => x.actor_id === U_SALES)).toBe(true)
      const b = await one<Row>(`SELECT * FROM audit_event WHERE action = 'import_batch.created' AND entity_id = ${batch}`)
      expect(b.after).not.toHaveProperty('label')
    })

    test('stejná zakázka podruhé (jiný klíč téhož obchodu i totéž) duplicitu nezaloží', async () => {
      const dupSameKey = await apply(batch, row({ import_keys: ['row:won-1'] }))
      expect(dupSameKey).toMatchObject({ status: 'duplicate', deal_id: r.deal_id })
      const dupOtherKey = await apply(batch, row({ import_keys: ['pdf:abc', 'row:jiny'] }))
      expect(dupOtherKey).toMatchObject({ status: 'duplicate', deal_id: r.deal_id })
      // ani z jiné dávky
      const other = await openBatch()
      expect(await apply(other, row({ import_keys: ['row:won-1'] }))).toMatchObject({ status: 'duplicate', deal_id: r.deal_id })
      expect(await count('deal', "title = 'Datová platforma'")).toBe(1)
      expect(await count('account', "name = 'Nová firma s.r.o.'")).toBe(1)
      expect(await count('engagement')).toBe(1)
    })

    test('běžná výhra mimo import dál zakládá úkol Naplánovat realizaci (regrese 0080)', async () => {
      const acc = (await one<{ id: number }>(`INSERT INTO account (name) VALUES ('Běžná firma') RETURNING id`)).id
      const d = (await one<{ id: number }>(`INSERT INTO deal (account_id, title, owner_id) VALUES (${acc}, 'Ruční obchod', '${U_SALES}') RETURNING id`)).id
      await as({ role: 'authenticated', sub: U_SALES }, `UPDATE deal SET stage = 'vyhráno' WHERE id = ${d}`)
      expect(await count('engagement', `deal_id = ${d}`)).toBe(1)
      expect(await count('task', `deal_id = ${d} AND title = 'Naplánovat realizaci akce'`)).toBe(1)
      expect(await count('sales_activity', `deal_id = ${d} AND source = 'auto_delivery'`)).toBe(1)
    })
  })

  describe('další fáze, měna a klienti', () => {
    test('EUR: přepočet kurzem, původní částka, verze i záznam v EUR', async () => {
      const batch = await openBatch()
      const r = await apply(batch, row({
        import_keys: ['row:eur'], currency: 'EUR', amount: 10000, fx_rate: 25.5, cogs: 1000, invoiced: null, received: null,
      }))
      const d = await one<Row>(`SELECT * FROM deal WHERE id = ${r.deal_id}`)
      expect(d).toMatchObject({ currency: 'EUR' })
      expect(Number(d.amount_one_time)).toBe(255000)
      expect(Number(d.amount_one_time_original)).toBe(10000)
      expect(Number(d.fx_rate)).toBe(25.5)
      expect(Number(d.cogs_one_time)).toBe(25500)
      const v = await one<Row>(`SELECT * FROM deal_scope_version WHERE deal_id = ${r.deal_id}`)
      expect(v).toMatchObject({ currency: 'EUR', status: 'accepted' })
      expect(Number(v.amount_one_time)).toBe(10000)
      const f = await q<Row>(`SELECT kind, currency, amount::float8 AS amount FROM financial_record WHERE deal_id = ${r.deal_id}`)
      expect(f).toEqual([{ kind: 'contracted', currency: 'EUR', amount: 10000 }])
      await expect(apply(batch, row({ import_keys: ['row:eur2'], currency: 'EUR', fx_rate: null }))).rejects.toThrow(/kurz/)
    })

    test('nabídka odeslána: verze v odeslaném stavu, žádná dodávka; pozdější ruční výhra založí úkol', async () => {
      const batch = await openBatch()
      const r = await apply(batch, row({
        import_keys: ['row:sent'], stage: 'rozsah_nabidka', probability_pct: 55, invoiced: null, received: null, started_on: null, due_on: null,
      }))
      expect(r.engagement_id).toBeNull()
      expect(await one(`SELECT stage FROM deal WHERE id = ${r.deal_id}`)).toMatchObject({ stage: 'rozsah_nabidka' })
      expect(await one(`SELECT status FROM deal_scope_version WHERE deal_id = ${r.deal_id}`)).toMatchObject({ status: 'sent' })
      expect(await count('financial_record', `deal_id = ${r.deal_id}`)).toBe(0)
      expect(await count('engagement', `deal_id = ${r.deal_id}`)).toBe(0)
      await as({ role: 'authenticated', sub: U_SALES }, `UPDATE deal SET stage = 'vyhráno' WHERE id = ${r.deal_id}`)
      expect(await count('task', `deal_id = ${r.deal_id} AND title = 'Naplánovat realizaci akce'`)).toBe(1)
    })

    test('rozjednáno: jen obchod, bez verze nabídky', async () => {
      const batch = await openBatch()
      const r = await apply(batch, row({
        import_keys: ['row:draft'], stage: 'diagnostika', probability_pct: 30, invoiced: null, received: null, amount: 0,
      }))
      expect(await count('deal_scope_version', `deal_id = ${r.deal_id}`)).toBe(0)
      expect(await one(`SELECT stage, probability_pct FROM deal WHERE id = ${r.deal_id}`)).toMatchObject({ stage: 'diagnostika', probability_pct: 30 })
    })

    test('nový klient: stejné jméno v dávce se použije znovu, IČO existujícího klienta se použije místo duplicity', async () => {
      const batch = await openBatch()
      const a = await apply(batch, row({ import_keys: ['row:n1'], new_account: { name: 'Sdílená s.r.o.', ico: null }, invoiced: null, received: null }))
      const b = await apply(batch, row({ import_keys: ['row:n2'], title: 'Druhá zakázka', new_account: { name: '  sdílená S.R.O. ', ico: null }, invoiced: null, received: null }))
      expect(b.account_id).toBe(a.account_id)
      expect(b.account_created).toBe(false)
      expect(await count('account', "lower(name) = 'sdílená s.r.o.'")).toBe(1)
      const withIco = (await one<{ id: number }>(`INSERT INTO account (name, ico) VALUES ('Firma s IČO', '27082440') RETURNING id`)).id
      const c = await apply(batch, row({ import_keys: ['row:n3'], title: 'Třetí', new_account: { name: 'Jiný zápis názvu', ico: '27082440' }, invoiced: null, received: null }))
      expect(c.account_id).toBe(withIco)
      expect(c.account_created).toBe(false)
    })

    test('existující klient se použije, neexistující ID selže', async () => {
      const batch = await openBatch()
      const acc = (await one<{ id: number }>(`INSERT INTO account (name) VALUES ('Existující') RETURNING id`)).id
      const r = await apply(batch, row({ import_keys: ['row:ex'], account_id: acc, new_account: null, invoiced: null, received: null }))
      expect(r).toMatchObject({ account_id: acc, account_created: false })
      await expect(apply(batch, row({ import_keys: ['row:ex2'], account_id: 999999, new_account: null }))).rejects.toThrow(/Klient neexistuje/)
    })
  })

  describe('validace a atomicita', () => {
    test('chyby vstupu: fakturováno u nevyhrané, přijato > fakturováno, deaktivovaný vlastník, chybějící klient', async () => {
      const batch = await openBatch()
      await expect(apply(batch, row({ import_keys: ['row:v1'], stage: 'diagnostika', invoiced: 100, received: null }))).rejects.toThrow(/jen u vyhrané/)
      await expect(apply(batch, row({ import_keys: ['row:v2'], invoiced: 100, received: 200 }))).rejects.toThrow(/přijato nesmí přesáhnout/)
      await expect(apply(batch, row({ import_keys: ['row:v3'], owner_id: GONE }))).rejects.toThrow(/aktivní člen/)
      await expect(apply(batch, row({ import_keys: ['row:v4'], account_id: null, new_account: null }))).rejects.toThrow(/nemá klienta/)
      await expect(apply(batch, row({ import_keys: [], }))).rejects.toThrow(/klíče/)
      await expect(apply(batch, row({ import_keys: ['row:v5'], stage: 'prohráno' }))).rejects.toThrow(/jen fáze/)
      await expect(apply(batch, row({ import_keys: ['row:v6'], due_on: '2026-01-01', started_on: '2026-02-01' }))).rejects.toThrow(/Termín je dřív/)
      await expect(apply(batch, row({ import_keys: ['row:v7'], amount: -5 }))).rejects.toThrow(/mimo rozumný rozsah/)
    })

    test('chyba uprostřed řádku nezanechá nic: ani klienta, ani položky', async () => {
      const batch = await openBatch()
      const before = [await count('account'), await count('deal'), await count('import_batch_item')]
      await expect(apply(batch, row({
        import_keys: ['row:atom'], new_account: { name: 'Sirotek s.r.o.', ico: null }, revenue_line: 'neexistuje',
      }))).rejects.toThrow()
      expect([await count('account'), await count('deal'), await count('import_batch_item')]).toEqual(before)
      expect(await count('account', "name = 'Sirotek s.r.o.'")).toBe(0)
    })

    test('cizí dávka, zavřená dávka a neexistující dávka se odmítnou', async () => {
      const mine = await openBatch()
      await expect(apply(mine, row({ import_keys: ['row:o1'] }), SALES2)).rejects.toThrow(/jinému člověku/)
      await expect(apply(999999, row({ import_keys: ['row:o2'] }))).rejects.toThrow(/neexistuje/)
      await revert(mine)
      await expect(apply(mine, row({ import_keys: ['row:o3'] }))).rejects.toThrow(/není otevřená/)
      await expect(apply(await openBatch(), row({ import_keys: ['row:o4'] }), U_PM)).rejects.toThrow(/obchodní rolí/)
    })
  })

  describe('vrácení dávky', () => {
    async function seed(prefix: string) {
      const batch = await openBatch()
      const a = await apply(batch, row({ import_keys: [`${prefix}:a`], title: `Zakázka A ${prefix}`, new_account: { name: `Klient A ${prefix}`, ico: null } }))
      const b = await apply(batch, row({ import_keys: [`${prefix}:b`], title: `Zakázka B ${prefix}`, new_account: { name: `Klient B ${prefix}`, ico: null } }))
      const c = await apply(batch, row({ import_keys: [`${prefix}:c`], title: `Nabídka C ${prefix}`, stage: 'rozsah_nabidka', invoiced: null, received: null, new_account: { name: `Klient B ${prefix}`, ico: null } }))
      return { batch, a, b, c }
    }

    test('čistá dávka se vrátí celá: zakázky, dodávky, finance, verze i nový klient; klíče se uvolní', async () => {
      const { batch, a, b } = await seed('clean')
      const res = await revert(batch)
      expect(res).toMatchObject({ deals_reverted: 3, deals_kept: [], accounts_deleted: 2, accounts_kept: 0, records_deleted: 6, status: 'reverted' })
      for (const id of [a.deal_id, b.deal_id]) expect(await count('deal', `id = ${id}`)).toBe(0)
      expect(await count('engagement', `id IN (${a.engagement_id}, ${b.engagement_id})`)).toBe(0)
      expect(await count('engagement_milestone', `engagement_id IN (${a.engagement_id}, ${b.engagement_id})`)).toBe(0)
      expect(await count('financial_record', `deal_id IN (${a.deal_id}, ${b.deal_id})`)).toBe(0)
      expect(await count('deal_scope_version', `deal_id IN (${a.deal_id}, ${b.deal_id})`)).toBe(0)
      expect(await count('account', "name LIKE 'Klient % clean'")).toBe(0)
      expect(await count('import_batch_item', `batch_id = ${batch}`)).toBe(0)
      expect(await one(`SELECT status, reverted_by FROM import_batch WHERE id = ${batch}`)).toMatchObject({ status: 'reverted', reverted_by: U_SALES })
      const ev = await one<{ after: Row }>(`SELECT after FROM audit_event WHERE action = 'import.batch_reverted' AND entity_id = ${batch}`)
      expect(ev.after).toMatchObject({ deals_reverted: 3, deals_kept: 0, accounts_deleted: 2, status: 'reverted' })
      // smazání je v auditu s aktérem
      const del = await q<Row>(`SELECT actor_id FROM audit_event WHERE action = 'engagement.deleted' AND entity_id = ${a.engagement_id}`)
      expect(del).toEqual([{ actor_id: U_SALES }])
      // stejný řádek jde po vrácení nahrát znovu
      const again = await apply(await openBatch(), row({ import_keys: ['clean:a'], title: 'Znovu' }))
      expect(again.status).toBe('created')
    })

    test('lidská práce zakázku zachrání: úkol, změna milníku, změna obchodu, nový finanční záznam, potvrzený návrh', async () => {
      const { batch, a, b, c } = await seed('work')
      // A: někdo k zakázce založil úkol
      await as({ role: 'authenticated', sub: U_SALES }, `INSERT INTO task (title, deal_id, account_id) VALUES ('Zavolat', ${a.deal_id}, ${a.account_id})`)
      // B: člověk potvrdil importovaný návrh faktury (doklad)
      await as({ role: 'authenticated', sub: U_SALES },
        `UPDATE financial_record SET status = 'confirmed', external_ref = 'FV-1' WHERE deal_id = ${b.deal_id} AND kind = 'invoiced'`)
      // C: nabídku někdo posunul na jinou fázi
      await as({ role: 'authenticated', sub: U_SALES }, `UPDATE deal SET stage = 'diagnostika' WHERE id = ${c.deal_id}`)
      const res = await revert(batch)
      expect(res.deals_reverted).toBe(0)
      expect(res.status).toBe('partial')
      const reasons = Object.fromEntries(res.deals_kept.map((k) => [k.deal_id, k.reason]))
      expect(reasons).toEqual({ [a.deal_id]: 'linked_work', [b.deal_id]: 'changed', [c.deal_id]: 'changed' })
      // nic se nesmazalo
      expect(await count('deal', `id IN (${a.deal_id}, ${b.deal_id}, ${c.deal_id})`)).toBe(3)
      expect(res.accounts_deleted).toBe(0)
      expect(res.accounts_kept).toBe(2)
    })

    test('částečné vrácení: čistá zakázka pryč, zakázka s prací zůstane a dávka je partial; po uvolnění se dokončí', async () => {
      const { batch, a, b } = await seed('part')
      const task = (await as<{ id: number }>({ role: 'authenticated', sub: U_SALES },
        `INSERT INTO task (title, deal_id) VALUES ('Pracuje se', ${a.deal_id}) RETURNING id`))[0].id
      const res = await revert(batch)
      expect(res).toMatchObject({ deals_reverted: 2, status: 'partial' })
      expect(res.deals_kept).toEqual([{ deal_id: a.deal_id, reason: 'linked_work' }])
      expect(await count('deal', `id = ${a.deal_id}`)).toBe(1)
      expect(await count('deal', `id = ${b.deal_id}`)).toBe(0)
      // klient A zůstává (obchod na něj ještě odkazuje), klient B je pryč
      expect(await count('account', `id = ${a.account_id}`)).toBe(1)
      expect(await count('account', `id = ${b.account_id}`)).toBe(0)
      expect(await count('import_batch_item', `batch_id = ${batch} AND entity_table = 'deal'`)).toBe(1)
      // po smazání úkolu (a jeho auditu) je zakázka pořád „dotčená“ jen vazbou; teď už bez ní
      await run(`DELETE FROM task WHERE id = ${task}`)
      const again = await revert(batch)
      expect(again.deals_kept).toEqual([])
      expect(again.deals_reverted).toBe(1)
      expect(again.status).toBe('reverted')
    })

    test('změněný milník, ručně přidaný finanční záznam a kontakt klienta zakázku i klienta zachrání', async () => {
      const { batch, a, b, c } = await seed('ms')
      await as({ role: 'authenticated', sub: U_SALES }, `UPDATE engagement_milestone SET status = 'probiha' WHERE engagement_id = ${a.engagement_id} AND title = 'Personál a inventář'`)
      await as({ role: 'authenticated', sub: U_SALES },
        `INSERT INTO financial_record (account_id, deal_id, engagement_id, kind, amount, period_month, status, source, created_by)
         VALUES (${b.account_id}, ${b.deal_id}, ${b.engagement_id}, 'invoiced', 50, '2026-09-01', 'draft', 'rucne', '${U_SALES}')`)
      await run(`INSERT INTO contact (account_id, full_name) VALUES (${c.account_id}, 'Jan Novák')`)
      const res = await revert(batch)
      const reasons = Object.fromEntries(res.deals_kept.map((k) => [k.deal_id, k.reason]))
      expect(reasons).toEqual({ [a.deal_id]: 'changed', [b.deal_id]: 'finance_changed' })
      expect(res.deals_reverted).toBe(1)
      expect(await count('deal', `id = ${c.deal_id}`)).toBe(0)
      // klient z kontaktu zůstává (nabídka C sdílela klienta s B, kterému zůstala zakázka)
      expect(await count('account', `id = ${b.account_id}`)).toBe(1)
      expect(await count('account', `id = ${a.account_id}`)).toBe(1)
      expect(res.accounts_deleted).toBe(0)
    })

    test('vrátit smí ten, kdo dávku nahrál, nebo správce; jiný obchodník ne, projekťák ne', async () => {
      const { batch } = await seed('who')
      await expect(revert(batch, SALES2)).rejects.toThrow(/nahrál, nebo správce/)
      await expect(revert(batch, U_PM)).rejects.toThrow(/obchodní rolí/)
      expect((await revert(batch, ADMIN)).status).toBe('reverted')
      await expect(revert(batch)).rejects.toThrow(/už je vrácená/)
    })
  })
})
