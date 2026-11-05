// 0093 v opravdovém Postgresu (PGlite = PostgreSQL ve WASM), bez sítě a bez
// živé DB: (1) transfer_member_work s cílovými seznamy, zpětně kompatibilní
// s 0088, a (2) change_work_owner — jednotlivá změna vlastníka a zástupce
// případu, milníku, obchodu, dodávky a cílového seznamu (oprávnění, aktér
// v auditu, souhrn pro „Co se změnilo", vlastník ≠ zástupce, deaktivovaný
// člověk nejde vybrat, souběh, vrácení vlastní změny).
// Schéma jako test/owner-transfer-0088-pglite.test.ts (společné
// auditPgliteSchema + zjednodušené kopie sloupců z 0039/0042/0061/0062/0069),
// na to skutečné migrace 0035, 0064, 0082, 0088 a 0093. PGlite je
// devDependency; bez něj se soubor přeskočí. Statické kontroly téže migrace
// běží vždy (test/member-work.test.ts, test/owner-change.test.ts).
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, test } from 'vitest'
import { AUDIT_SCHEMA as SCHEMA, U_API, U_PM } from './helpers/auditPgliteSchema'

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
const M0093 = readFileSync('supabase/migrations/0093_owner_change.sql', 'utf8')
const M0035 = readFileSync('supabase/migrations/0035_deal_audit_hardening.sql', 'utf8')
  .replace(/DO \$\$\nDECLARE\n  v_sig text;[\s\S]*?END \$\$;/, '')
  .replace(/INSERT INTO schema_migration[\s\S]*$/, '')

const ADMIN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const FROM = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const TO = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const PARTNER = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const GONE = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const NODE_OWNER = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const OUTSIDER = U_PM // projektak bez práv k věcem níž
const VEDENI = U_API // vedení, ne správce
const TODAY = '2026-09-30'

const EXTRA = `
ALTER ROLE service_role BYPASSRLS;
ALTER TABLE team_member ADD COLUMN email text, ADD COLUMN is_admin boolean NOT NULL DEFAULT false,
  ADD COLUMN manager_id uuid, ADD COLUMN deactivated_at timestamptz, ADD COLUMN weekly_capacity_hours numeric DEFAULT 40;
INSERT INTO team_member (id, role, full_name, email, is_admin) VALUES
  ('${ADMIN}', 'vedeni', 'Správce', 'admin@enter.cz', true),
  ('${FROM}', 'projektak', 'Odchází', 'from@enter.cz', false),
  ('${TO}', 'projektak', 'Přebírá', 'to@enter.cz', false),
  ('${NODE_OWNER}', 'obchodnik', 'Vlastník oblasti', 'node@enter.cz', false),
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

describe.skipIf(!PGliteCtor)('0093 v Postgresu (PGlite)', () => {
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
  const q = async (sql: string) => (await db.query<Row>(sql)).rows
  const svc = (actor: string, sql: string, params: unknown[] = []) =>
    as<{ r: Record<string, unknown> }>({ role: 'service_role', headers: { 'x-cockpit-audit-actor': `user:${actor}` } }, sql, params)
  const transfer = (from: string, to: string, kinds: string, actor = ADMIN) =>
    svc(actor, `SELECT transfer_member_work($1, $2, $3, $4::text[], $5::date) AS r`, [from, to, actor, kinds, TODAY])
  // change_work_owner(kind, id, actor, owner, deputy, expect, undo_of) → r
  const change = async (
    kind: string, id: number, actor: string, owner: string | null, deputy: string | null,
    opts: { expect?: { owner: string | null; deputy?: string | null } | null; undoOf?: number | null } = {},
  ) => {
    const [{ r }] = await svc(
      actor,
      `SELECT change_work_owner($1, $2::bigint, $3::uuid, $4::uuid, $5::uuid, $6::jsonb, $7::bigint) AS r`,
      [kind, id, actor, owner, deputy, opts.expect ? JSON.stringify(opts.expect) : null, opts.undoOf ?? null],
    )
    return r
  }

  let accountId = 0
  const ids: Record<string, number> = {}
  const ins = async (sql: string) => (await one<{ id: number }>(`${sql} RETURNING id`)).id

  beforeAll(async () => {
    db = new PGliteCtor!()
    await run(SCHEMA)
    await run(EXTRA)
    await run(M0035)
    await run(M0064)
    await run(M0082)
    await run(M0088)
    accountId = (await one<{ id: number }>(`INSERT INTO account (name, owner_id) VALUES ('Firma', '${OUTSIDER}') RETURNING id`)).id
    ids.list1 = await ins(`INSERT INTO target_list (name, segment, rationale, owner_id) VALUES ('Seznam 1', 'IT', 'proč', '${FROM}')`)
    ids.list2 = await ins(`INSERT INTO target_list (name, segment, rationale, owner_id) VALUES ('Seznam 2', 'IT', 'proč', '${FROM}')`)
    ids.listOther = await ins(`INSERT INTO target_list (name, segment, rationale, owner_id) VALUES ('Cizí', 'IT', 'proč', '${OUTSIDER}')`)
  }, 120_000)

  test('před 0093 starý transfer_member_work druh „seznamy" nezná', async () => {
    await expect(transfer(FROM, TO, '{seznamy}')).rejects.toThrow(/Neznámý druh/)
    expect((await one<{ o: string }>(`SELECT owner_id AS o FROM target_list WHERE id = ${ids.list1}`)).o).toBe(FROM)
  })

  test('aplikace 0093 je idempotentní (ledger jednou, obě funkce jednou)', async () => {
    notices.length = 0
    await run(M0093)
    await run(M0093)
    expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM schema_migration WHERE version = '0093'`)).n).toBe(1)
    expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM pg_proc WHERE proname IN ('transfer_member_work', 'change_work_owner')`)).n).toBe(2)
    expect(notices.filter((n) => n.startsWith('WARNING'))).toEqual([])
  })

  describe('hromadné předání: cílové seznamy a zpětná kompatibilita', () => {
    test('starý volající bez „seznamy" dostane totéž co v 0088 (bez klíče seznamy)', async () => {
      const [{ r }] = await transfer(FROM, TO, '{ukoly,klienti}')
      expect(r).toEqual({ ukoly: 0, klienti: 0, bez_zastupce: 0 })
      expect((await one<{ o: string }>(`SELECT owner_id AS o FROM target_list WHERE id = ${ids.list1}`)).o).toBe(FROM)
    })

    test('seznamy: předají se všechny seznamy člověka, cizí ne; audit s aktérem, souhrn s počtem', async () => {
      const before = (await one<{ n: number }>(`SELECT max(id)::int AS n FROM audit_event`)).n
      const [{ r }] = await transfer(FROM, TO, '{seznamy}')
      expect(r).toEqual({ seznamy: 2, bez_zastupce: 0 })
      expect(await q(`SELECT id, owner_id FROM target_list ORDER BY id`)).toEqual([
        { id: ids.list1, owner_id: TO }, { id: ids.list2, owner_id: TO }, { id: ids.listOther, owner_id: OUTSIDER },
      ])
      const rowAudit = await one<Row>(`SELECT * FROM audit_event WHERE entity_table = 'target_list' AND entity_id = ${ids.list1} AND id > ${before} ORDER BY id DESC LIMIT 1`)
      expect(rowAudit).toMatchObject({ action: 'target_list.updated', actor_type: 'user', actor_id: ADMIN })
      const summary = await one<Row>(`SELECT * FROM audit_event WHERE action = 'team_member.work_transferred' AND id > ${before}`)
      expect(summary.after).toMatchObject({ to_member_id: TO, counts: { seznamy: 2, bez_zastupce: 0 } })
      expect(JSON.stringify(summary)).not.toMatch(/Seznam|proč/)
    })

    test('chyby jako dřív: Partner, deaktivovaný příjemce, neznámý druh', async () => {
      await expect(transfer(TO, PARTNER, '{seznamy}')).rejects.toThrow(/interní rolí/)
      await expect(transfer(TO, GONE, '{seznamy}')).rejects.toThrow(/interní rolí/)
      await expect(transfer(TO, FROM, '{seznamy,vse}')).rejects.toThrow(/Neznámý druh/)
      await expect(transfer(TO, FROM, '{seznamy}', OUTSIDER)).rejects.toThrow(/správce/)
    })
  })

  describe('change_work_owner', () => {
    beforeAll(async () => {
      // Vrať seznamy k testu jednotlivé změny.
      await run(`UPDATE target_list SET owner_id = '${FROM}' WHERE id IN (${ids.list1}, ${ids.list2})`)
      await run(`INSERT INTO loop_node (node, owner_id, deputy_id) VALUES ('eventy', '${NODE_OWNER}', NULL), ('obchod', NULL, NULL)`)
      ids.dealOpen = await ins(`INSERT INTO deal (account_id, title, stage, owner_id) VALUES (${accountId}, 'Otevřený', 'kvalifikace', '${FROM}')`)
      ids.dealWon = await ins(`INSERT INTO deal (account_id, title, stage, owner_id) VALUES (${accountId}, 'Vyhraný', 'vyhráno', '${FROM}')`)
      ids.dealNoOwner = await ins(`INSERT INTO deal (account_id, title, stage) VALUES (${accountId}, 'Bez vlastníka', 'kvalifikace')`)
      ids.engA = await ins(`INSERT INTO engagement (account_id, kind, phase, owner_id, deputy_id) VALUES (${accountId}, 'it', 'analyza', '${FROM}', '${TO}')`)
      ids.engClosed = await ins(`INSERT INTO engagement (account_id, kind, phase, owner_id) VALUES (${accountId}, 'edu', 'uzavreno', '${FROM}')`)
      ids.msOpen = await ins(`INSERT INTO engagement_milestone (engagement_id, title, status, owner_id, deputy_id) VALUES (${ids.engA}, 'Mapa', 'v_praci', '${FROM}', '${TO}')`)
      await run(`INSERT INTO evidence (source_kind, source_id) VALUES ('file', 'm93')`)
      ids.msClosed = await ins(`INSERT INTO engagement_milestone (engagement_id, title, status, owner_id, accepted_at, acceptance_evidence_id)
        VALUES (${ids.engA}, 'Hotovo', 'uzavreno', '${FROM}', now(), (SELECT max(id) FROM evidence))`)
      ids.caseA = await ins(`INSERT INTO work_case (title, node, status, lead_owner_id, deputy_id, created_by) VALUES ('Případ A', 'eventy', 'in_progress', '${FROM}', '${TO}', 'system:test')`)
      ids.caseB = await ins(`INSERT INTO work_case (title, node, status, lead_owner_id, created_by) VALUES ('Případ B', 'eventy', 'open', '${FROM}', 'system:test')`)
      ids.caseCancelled = await ins(`INSERT INTO work_case (title, node, status, lead_owner_id, created_by) VALUES ('Zrušený', 'eventy', 'cancelled', '${FROM}', 'system:test')`)
      ids.caseNoOwner = await ins(`INSERT INTO work_case (title, node, status, created_by) VALUES ('Bez vlastníka', 'obchod', 'open', 'system:test')`)
    })

    test('jen service_role (přihlášený uživatel funkci volat nesmí)', async () => {
      await expect(as({ role: 'authenticated', sub: ADMIN }, `SELECT change_work_owner('pripady', ${ids.caseA}, '${ADMIN}', '${TO}', NULL, NULL, NULL)`))
        .rejects.toThrow(/permission denied/)
    })

    test('chyby vstupu: neznámý druh, neexistující věc, aktér neaktivní / Partner', async () => {
      await expect(change('sklady', 1, ADMIN, TO, null)).rejects.toThrow(/Neznámý druh/)
      await expect(change('pripady', 999999, ADMIN, TO, null)).rejects.toThrow(/neexistuje/)
      await expect(change('pripady', ids.caseA, GONE, TO, null)).rejects.toThrow(/aktivní člen týmu/)
      await expect(change('pripady', ids.caseA, PARTNER, TO, null)).rejects.toThrow(/aktivní člen týmu/)
    })

    test('oprávnění: cizí projektak ne, vedení, správce, vlastník, zástupce a vlastník oblasti ano', async () => {
      await expect(change('pripady', ids.caseA, OUTSIDER, OUTSIDER, null)).rejects.toThrow(/smí měnit správce týmu, vedení/)
      await expect(change('milniky', ids.msOpen, OUTSIDER, OUTSIDER, null)).rejects.toThrow(/smí měnit/)
      await expect(change('obchody', ids.dealNoOwner, OUTSIDER, OUTSIDER, null)).rejects.toThrow(/smí měnit/)
      await expect(change('pripady', ids.caseNoOwner, OUTSIDER, OUTSIDER, null)).rejects.toThrow(/smí měnit/)
      // Nic se nepohnulo.
      expect((await one<{ o: string }>(`SELECT lead_owner_id AS o FROM work_case WHERE id = ${ids.caseA}`)).o).toBe(FROM)

      // Zástupce případu (TO) smí předat, když je vlastník, kdo drží věc: tady zástupce sám sebe jako vlastníka.
      const asDeputy = await change('pripady', ids.caseA, TO, TO, null)
      expect(asDeputy).toMatchObject({ changed: true, owner: TO, freed_deputy: 1 })
      // Vlastník oblasti případu (loop_node.owner_id) smí případ přehodit.
      const asNode = await change('pripady', ids.caseA, NODE_OWNER, FROM, TO)
      expect(asNode).toMatchObject({ changed: true, owner: FROM, deputy: TO })
      // Vedení, které není správce.
      expect(await change('pripady', ids.caseA, VEDENI, FROM, null)).toMatchObject({ changed: true, deputy: null })
      // Vlastník sám (FROM) předá.
      expect(await change('pripady', ids.caseA, FROM, TO, null)).toMatchObject({ changed: true, owner: TO })
      // Původní vlastník už věc nedrží → už nesmí.
      await expect(change('pripady', ids.caseA, FROM, FROM, null)).rejects.toThrow(/smí měnit/)
      // Správce smí kdykoli.
      expect(await change('pripady', ids.caseA, ADMIN, FROM, TO)).toMatchObject({ changed: true })
    })

    test('příjemce: deaktivovaný a Partner nejdou vybrat, zástupce ≠ vlastník, zástupce bez vlastníka', async () => {
      await expect(change('pripady', ids.caseB, ADMIN, GONE, null)).rejects.toThrow(/aktivního člena týmu/)
      await expect(change('pripady', ids.caseB, ADMIN, PARTNER, null)).rejects.toThrow(/aktivního člena týmu/)
      await expect(change('pripady', ids.caseB, ADMIN, TO, GONE)).rejects.toThrow(/aktivního člena týmu/)
      await expect(change('pripady', ids.caseB, ADMIN, TO, TO)).rejects.toThrow(/jiný člověk než vlastník/)
      await expect(change('pripady', ids.caseNoOwner, ADMIN, null, TO)).rejects.toThrow(/bez vlastníka/)
      expect((await one<{ o: string }>(`SELECT lead_owner_id AS o FROM work_case WHERE id = ${ids.caseB}`)).o).toBe(FROM)
    })

    test('existujícího vlastníka nejde jen odebrat; deaktivovaný, který na věci už je, nebrání změně zástupce', async () => {
      await expect(change('pripady', ids.caseB, ADMIN, null, null)).rejects.toThrow(/nejde jen odebrat/)
      // Věc, kde je deaktivovaný člověk stávajícím vlastníkem: zástupce lze doplnit a vlastníka předat.
      const gone = await ins(`INSERT INTO work_case (title, node, status, lead_owner_id, created_by) VALUES ('Po odchodu', 'obchod', 'open', '${GONE}', 'system:test')`)
      expect(await change('pripady', gone, ADMIN, GONE, TO)).toMatchObject({ changed: true, owner: GONE, deputy: TO })
      expect(await change('pripady', gone, ADMIN, TO, null)).toMatchObject({ changed: true, owner: TO, freed_deputy: 1 })
    })

    test('uzavřená věc (případ, milník, dodávka, obchod) se jednotlivě předat nedá', async () => {
      await expect(change('pripady', ids.caseCancelled, ADMIN, TO, null)).rejects.toThrow(/Uzavřenou věc/)
      await expect(change('milniky', ids.msClosed, ADMIN, TO, null)).rejects.toThrow(/Uzavřenou věc/)
      await expect(change('dodavky', ids.engClosed, ADMIN, TO, null)).rejects.toThrow(/Uzavřenou věc/)
      await expect(change('obchody', ids.dealWon, ADMIN, TO, null)).rejects.toThrow(/Uzavřenou věc/)
    })

    test('obchod a cílový seznam zástupce nemají; obchod bez vlastníka lze obsadit', async () => {
      await expect(change('obchody', ids.dealOpen, ADMIN, TO, FROM)).rejects.toThrow(/zástupce nemá/)
      await expect(change('seznamy', ids.list1, ADMIN, TO, FROM)).rejects.toThrow(/zástupce nemá/)
      expect(await change('obchody', ids.dealNoOwner, ADMIN, TO, null)).toMatchObject({ changed: true, owner: TO, before_owner: null, account_id: accountId })
      expect((await one<{ o: string }>(`SELECT owner_id AS o FROM deal WHERE id = ${ids.dealNoOwner}`)).o).toBe(TO)
    })

    test('souběh: p_expect z minulosti neprojde, aktuální ano', async () => {
      await expect(change('milniky', ids.msOpen, ADMIN, TO, null, { expect: { owner: TO, deputy: null } })).rejects.toThrow(/mezitím změnil/)
      const r = await change('milniky', ids.msOpen, ADMIN, TO, FROM, { expect: { owner: FROM, deputy: TO } })
      expect(r).toMatchObject({ changed: true, kind: 'milniky', id: ids.msOpen, account_id: accountId, engagement_id: ids.engA, owner: TO, deputy: FROM })
    })

    test('beze změny se nic nezapíše ani neauditue', async () => {
      const before = (await one<{ n: number }>(`SELECT max(id)::int AS n FROM audit_event`)).n
      expect(await change('milniky', ids.msOpen, ADMIN, TO, FROM)).toEqual({ changed: false, kind: 'milniky', id: ids.msOpen })
      expect((await one<{ n: number }>(`SELECT max(id)::int AS n FROM audit_event`)).n).toBe(before)
    })

    test('dodávka a cílový seznam: změna, řádkový audit s aktérem, souhrn bez názvů', async () => {
      const before = (await one<{ n: number }>(`SELECT max(id)::int AS n FROM audit_event`)).n
      const r = await change('dodavky', ids.engA, VEDENI, TO, null)
      expect(r).toMatchObject({ changed: true, role: 'owner', owner: TO, deputy: null, freed_deputy: 1, engagement_id: ids.engA })
      expect(await q(`SELECT owner_id, deputy_id FROM engagement WHERE id = ${ids.engA}`)).toEqual([{ owner_id: TO, deputy_id: null }])
      const summary = await one<Row>(`SELECT * FROM audit_event WHERE id = ${r.audit_id as number}`)
      expect(summary).toMatchObject({
        action: 'team_member.work_item_reassigned', actor_type: 'user', actor_id: VEDENI, entity_table: 'team_member',
        entity_id: null, entity_ref: FROM, info_state: 'human_confirmed',
      })
      expect(summary.before).toEqual({ owner: FROM, deputy: TO })
      expect(summary.after).toMatchObject({
        kind: 'dodavky', item_id: ids.engA, account_id: accountId, engagement_id: ids.engA, role: 'owner',
        from_member_id: FROM, to_member_id: TO, to: { owner: TO, deputy: null }, counts: { dodavky: 1, bez_zastupce: 1 },
      })
      expect(JSON.stringify(summary)).not.toMatch(/Firma|Případ|@enter|Seznam/)
      // Řádkový audit dodávky nese uživatele z hlavičky, ne service_role.
      const rowAudit = await one<Row>(`SELECT * FROM audit_event WHERE entity_table = 'engagement' AND entity_id = ${ids.engA} AND id > ${before} AND action = 'engagement.updated' ORDER BY id DESC LIMIT 1`)
      expect(rowAudit).toMatchObject({ actor_type: 'user', actor_id: VEDENI })

      const list = await change('seznamy', ids.list1, FROM, TO, null)
      expect(list).toMatchObject({ changed: true, owner: TO, account_id: null })
      expect((await one<Row>(`SELECT * FROM audit_event WHERE entity_table = 'target_list' AND entity_id = ${ids.list1} ORDER BY id DESC LIMIT 1`)))
        .toMatchObject({ action: 'target_list.updated', actor_id: FROM })
    })

    test('změna jen zástupce: role deputy, entity_ref předchozí zástupce', async () => {
      const r = await change('pripady', ids.caseA, ADMIN, FROM, TO)
      expect(r).toMatchObject({ changed: false })
      const before = await one<{ o: string | null; d: string | null }>(`SELECT lead_owner_id AS o, deputy_id AS d FROM work_case WHERE id = ${ids.caseA}`)
      expect(before).toEqual({ o: FROM, d: TO })
      const chg = await change('pripady', ids.caseA, FROM, FROM, null)
      expect(chg).toMatchObject({ changed: true, role: 'deputy', deputy: null, before_deputy: TO })
      const summary = await one<Row>(`SELECT * FROM audit_event WHERE id = ${chg.audit_id as number}`)
      expect(summary.entity_ref).toBe(TO)
      expect(summary.after).toMatchObject({ role: 'deputy', from_member_id: TO, to_member_id: null })
    })

    describe('vrácení (toast Zpět)', () => {
      test('stejný aktér vrátí vlastní změnu i po ztrátě práv; druhé vrácení a cizí aktér ne', async () => {
        const c = await ins(`INSERT INTO work_case (title, node, status, lead_owner_id, deputy_id, created_by) VALUES ('Zpět', 'obchod', 'open', '${FROM}', '${TO}', 'system:test')`)
        const first = await change('pripady', c, FROM, TO, null, { expect: { owner: FROM, deputy: TO } })
        expect(first).toMatchObject({ changed: true, owner: TO, freed_deputy: 1 })
        // FROM už případ nedrží, ale svou změnu vrátit smí.
        await expect(change('pripady', c, OUTSIDER, FROM, TO, { undoOf: first.audit_id as number })).rejects.toThrow(/už nejde vrátit/)
        const undone = await change('pripady', c, FROM, FROM, TO, { undoOf: first.audit_id as number })
        expect(undone).toMatchObject({ changed: true, owner: FROM, deputy: TO })
        expect(await q(`SELECT lead_owner_id, deputy_id FROM work_case WHERE id = ${c}`)).toEqual([{ lead_owner_id: FROM, deputy_id: TO }])
        const undoEvent = await one<Row>(`SELECT * FROM audit_event WHERE id = ${undone.audit_id as number}`)
        expect(undoEvent.after).toMatchObject({ undo_of: first.audit_id })
        // Totéž vrácení podruhé: věc už není ve stavu po změně.
        await expect(change('pripady', c, FROM, FROM, TO, { undoOf: first.audit_id as number })).rejects.toThrow(/mezitím změnil/)
        // Vrácení vrácení nejde.
        await expect(change('pripady', c, FROM, TO, null, { undoOf: undone.audit_id as number })).rejects.toThrow(/už nejde vrátit/)
      })

      test('nevrátí, když věc mezitím změnil někdo jiný, nebo nejsou to původní hodnoty', async () => {
        const c = await ins(`INSERT INTO work_case (title, node, status, lead_owner_id, created_by) VALUES ('Souběh', 'obchod', 'open', '${FROM}', 'system:test')`)
        const first = await change('pripady', c, FROM, TO, null)
        await change('pripady', c, ADMIN, NODE_OWNER, null)
        await expect(change('pripady', c, FROM, FROM, null, { undoOf: first.audit_id as number })).rejects.toThrow(/mezitím změnil/)
        const c2 = await ins(`INSERT INTO work_case (title, node, status, lead_owner_id, created_by) VALUES ('Podvrh', 'obchod', 'open', '${FROM}', 'system:test')`)
        const f2 = await change('pripady', c2, FROM, TO, null)
        // Vrácení nesmí posloužit k přiřazení někomu jinému, než kdo tam byl.
        await expect(change('pripady', c2, FROM, NODE_OWNER, null, { undoOf: f2.audit_id as number })).rejects.toThrow(/už nejde vrátit/)
        // Záznam jiné věci.
        await expect(change('pripady', ids.caseB, FROM, FROM, null, { undoOf: f2.audit_id as number })).rejects.toThrow(/už nejde vrátit/)
      })

      test('starší než 30 minut se nevrací; vrácení do stavu bez vlastníka projde', async () => {
        const d = await ins(`INSERT INTO deal (account_id, title, stage) VALUES (${accountId}, 'Bez pána', 'kvalifikace')`)
        const first = await change('obchody', d, ADMIN, TO, null)
        await run(`UPDATE audit_event SET occurred_at = now() - interval '31 minutes' WHERE id = ${first.audit_id as number}`)
        await expect(change('obchody', d, ADMIN, null, null, { undoOf: first.audit_id as number })).rejects.toThrow(/už nejde vrátit/)
        await run(`UPDATE audit_event SET occurred_at = now() WHERE id = ${first.audit_id as number}`)
        const undone = await change('obchody', d, ADMIN, null, null, { undoOf: first.audit_id as number })
        expect(undone).toMatchObject({ changed: true, owner: null, before_owner: TO })
        expect((await one<{ o: string | null }>(`SELECT owner_id AS o FROM deal WHERE id = ${d}`)).o).toBeNull()
      })
    })
  })
})
