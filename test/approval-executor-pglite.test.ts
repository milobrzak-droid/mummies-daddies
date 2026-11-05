// 0084 v opravdovém Postgresu (PGlite = PostgreSQL ve WASM), bez sítě a bez
// živé DB. PGlite NENÍ závislost projektu: bez `npm i --no-save
// @electric-sql/pglite` se celý soubor přeskočí (statické kontroly téže
// migrace běží vždy v test/approval-executor-0084.test.ts).
//
// Na zjednodušené základní schéma (tým, firmy, obchody, úkoly, aktivity,
// evidence, audit_event) se pouští SKUTEČNÉ migrace Loop Core 0039, 0053,
// 0057, 0071, verze nabídky 0072, skutečná auditní maškarní z 0064 a 0082
// (funkce + triggery dotčených tabulek) a nakonec 0084 dvakrát (idempotence).
// Požadavek PostgRESTu se simuluje transakcí se set_config('request.jwt.claims'
// | 'request.headers') a SET LOCAL ROLE.
//
// Ověřuje slib z revize (P1.5): schválení → úkol vznikne právě jednou,
// zamítnutí a vypršení → definovaný další stav, žadatel si neschválí sám,
// bez oprávnění se nic nestane; u nabídky se nic neodesílá.
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, test, vi } from 'vitest'
import { offerNeedsSendApproval } from '@/domain/crm/scopeVersion'

// PGlite je pod zátěží celé sady pomalé; výchozích 5 s nestačí.
vi.setConfig({ testTimeout: 60_000, hookTimeout: 120_000 })

type Row = Record<string, unknown>
type Db = {
  exec: (sql: string, opts?: { onNotice?: (n: { severity: string; message: string }) => void }) => Promise<unknown>
  query: <T = Row>(sql: string, params?: unknown[], opts?: { onNotice?: (n: { severity: string; message: string }) => void }) => Promise<{ rows: T[] }>
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
const M0039 = mig('0039_loop_core.sql')
const M0053 = mig('0053_security_hardening.sql')
const M0057 = mig('0057_loop_core_hardening.sql')
const M0071 = mig('0071_work_case_node_fk.sql')
const M0072 = mig('0072_deal_scope_version.sql')
const M0064 = mig('0064_audit_coverage.sql')
const M0082 = mig('0082_audit_gaps_partner_lockdown.sql')
const M0084 = mig('0084_approval_executor.sql')

// Lidé. Viktor vlastní všechny uzly (seed 0039 podle e-mailu), Lenka je
// vedení, Petr obchodník, Pavla projekťačka (bez obchodu), Odešlý deaktivovaný.
const VIKTOR = '11111111-1111-4111-8111-111111111111'
const LENKA = '22222222-2222-4222-8222-222222222222'
const PETR = '33333333-3333-4333-8333-333333333333'
const PAVLA = '44444444-4444-4444-8444-444444444444'
const GONE = '55555555-5555-4555-8555-555555555555'
const STRANGER = '99999999-9999-4999-8999-999999999999'

// Funkce a triggery skutečného auditu z 0064 a 0082 (bez závislosti na všech krytých tabulkách).
function auditMachinery(): string {
  const f64Start = M0064.indexOf('CREATE OR REPLACE FUNCTION audit_request_context(')
  const f64End = M0064.indexOf('-- 4) Napojení tabulek')
  const f82Start = M0082.indexOf('CREATE OR REPLACE FUNCTION audit_row_record(')
  const f82End = M0082.indexOf('-- 3) Napojení tabulek')
  if ([f64Start, f64End, f82Start, f82End].some((i) => i < 0)) throw new Error('0064/0082: struktura se změnila, uprav vytažení auditu v testu')
  const hard = ['work_case', 'case_step', 'decision', 'approval_request', 'authority_policy', 'task', 'sales_activity']
  const hardTriggers = [...M0064.matchAll(/DROP TRIGGER IF EXISTS audit_row_change ON (\w+);\s*CREATE TRIGGER audit_row_change[\s\S]*?\);\n/g)]
    .filter((m) => hard.includes(m[1])).map((m) => m[0])
  const soft = ['deal_scope_version', 'loop_node']
  const softTriggers = [...M0082.matchAll(/DROP TRIGGER IF EXISTS audit_row_change_soft ON (\w+);\s*CREATE TRIGGER audit_row_change_soft[\s\S]*?\);\n/g)]
    .filter((m) => soft.includes(m[1])).map((m) => m[0])
  if (hardTriggers.length !== hard.length || softTriggers.length !== soft.length) throw new Error('0064/0082: nenalezeny všechny triggery auditu')
  return [M0064.slice(f64Start, f64End), M0082.slice(f82Start, f82End), ...hardTriggers, ...softTriggers].join('\n')
}

const BASE = `
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid $$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claims', true), '')::jsonb $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role' $$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
-- Supabase dává novým tabulkám, sekvencím i funkcím v public plná práva;
-- migrace je musí omezit sama (proto REVOKE v 0039/0084).
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

CREATE TABLE schema_migration (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now(), note text);
CREATE TYPE team_role AS ENUM ('vedeni', 'obchodnik', 'projektak', 'lektor', 'partner');
CREATE TABLE team_member (id uuid PRIMARY KEY, email text, full_name text, role team_role NOT NULL DEFAULT 'partner',
  is_admin boolean NOT NULL DEFAULT false, deactivated_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
INSERT INTO team_member (id, email, full_name, role, deactivated_at) VALUES
  ('${VIKTOR}', 'viktor@mummiesdaddies.com', 'Viktor', 'vedeni', NULL),
  ('${LENKA}', 'lenka@mummiesdaddies.com', 'Lenka', 'vedeni', NULL),
  ('${PETR}', 'petr@mummiesdaddies.com', 'Petr', 'obchodnik', NULL),
  ('${PAVLA}', 'pavla@mummiesdaddies.com', 'Pavla', 'projektak', NULL),
  ('${GONE}', 'gone@mummiesdaddies.com', 'Odešlý', 'projektak', now());
-- is_team_member / can_see_sales ve tvaru po 0082 (aktivní, interní role).
CREATE FUNCTION is_team_member() RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM team_member WHERE id = auth.uid() AND deactivated_at IS NULL
                 AND role::text IN ('vedeni', 'obchodnik', 'projektak', 'lektor')) $$;
CREATE FUNCTION can_see_sales() RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM team_member WHERE id = auth.uid() AND deactivated_at IS NULL
                 AND role::text IN ('vedeni', 'obchodnik')) $$;
CREATE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

CREATE TABLE evidence (id bigserial PRIMARY KEY, source_kind text NOT NULL, source_id text NOT NULL, web_link text,
  captured_at timestamptz NOT NULL DEFAULT now(), created_by text);
CREATE TABLE audit_event (id bigserial PRIMARY KEY, actor_type text NOT NULL, actor_id text, action text NOT NULL,
  entity_table text NOT NULL, entity_id bigint, entity_ref text, before jsonb, after jsonb,
  occurred_at timestamptz NOT NULL DEFAULT now(), evidence_id bigint REFERENCES evidence(id) ON DELETE RESTRICT,
  info_state text CHECK (info_state IS NULL OR info_state IN ('source_fact','ai_suggestion','human_confirmed','actual_result')),
  CONSTRAINT audit_event_entity_check CHECK (entity_id IS NOT NULL OR entity_ref IS NOT NULL));

CREATE TYPE deal_currency AS ENUM ('CZK', 'EUR');
CREATE TYPE task_status AS ENUM ('todo', 'in_progress', 'blocked', 'done');
CREATE TYPE task_priority AS ENUM ('low', 'normal', 'high');
CREATE TYPE sales_activity_kind AS ENUM ('call', 'email', 'meeting', 'note', 'other');
CREATE TYPE sales_activity_outcome AS ENUM ('completed', 'no_answer', 'follow_up', 'cancelled', 'planned');

CREATE TABLE partner (id bigserial PRIMARY KEY, name text NOT NULL);
CREATE TABLE account (id bigserial PRIMARY KEY, name text NOT NULL, owner_id uuid REFERENCES team_member(id));
CREATE TABLE deal (id bigserial PRIMARY KEY, account_id bigint NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  title text NOT NULL, owner_id uuid REFERENCES team_member(id), stage text NOT NULL DEFAULT 'rozsah_nabidka',
  currency deal_currency NOT NULL DEFAULT 'CZK', amount_one_time numeric(14,2) DEFAULT 0, amount_one_time_original numeric(14,2),
  fx_rate numeric(10,4), expected_mrr numeric(12,2) DEFAULT 0, last_activity_at timestamptz);
CREATE TABLE engagement_document (id bigserial PRIMARY KEY, url text NOT NULL, created_by uuid);
CREATE TABLE task (id bigserial PRIMARY KEY, title text NOT NULL, description text, status task_status NOT NULL DEFAULT 'todo',
  priority task_priority NOT NULL DEFAULT 'normal', assignee_id uuid REFERENCES team_member(id) ON DELETE SET NULL,
  created_by uuid REFERENCES team_member(id) ON DELETE SET NULL, due_on date,
  account_id bigint REFERENCES account(id) ON DELETE SET NULL, deal_id bigint REFERENCES deal(id) ON DELETE SET NULL,
  engagement_id bigint, ms_event_id text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE sales_activity (id bigserial PRIMARY KEY, account_id bigint REFERENCES account(id) ON DELETE CASCADE,
  partner_id bigint REFERENCES partner(id) ON DELETE CASCADE, deal_id bigint REFERENCES deal(id) ON DELETE SET NULL, contact_id bigint,
  kind sales_activity_kind NOT NULL, outcome sales_activity_outcome NOT NULL DEFAULT 'completed', subject text NOT NULL, body text,
  occurred_at timestamptz NOT NULL DEFAULT now(), follow_up_on date, created_by uuid, created_at timestamptz NOT NULL DEFAULT now(),
  source text, external_id text,
  CONSTRAINT sales_activity_belongs_to_one CHECK ((account_id IS NOT NULL AND partner_id IS NULL) OR (account_id IS NULL AND partner_id IS NOT NULL)));
CREATE UNIQUE INDEX sales_activity_external_idx ON sales_activity(source, external_id) WHERE external_id IS NOT NULL;
-- Trigger aktivity z 0059: posouvá deal.last_activity_at (musí přežít zápis executoru).
CREATE FUNCTION touch_deal_last_activity() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF NEW.deal_id IS NOT NULL THEN
    UPDATE deal SET last_activity_at = GREATEST(COALESCE(last_activity_at, NEW.occurred_at), NEW.occurred_at) WHERE id = NEW.deal_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER sales_activity_touch_deal AFTER INSERT ON sales_activity FOR EACH ROW EXECUTE FUNCTION touch_deal_last_activity();

-- RLS jako v produkci: tým (is_team_member) + RESTRICTIVE AAL2; obchody, aktivity jen obchodní role.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['account', 'deal', 'task', 'sales_activity', 'audit_event', 'team_member', 'evidence'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY team_all ON %I FOR ALL USING (is_team_member()) WITH CHECK (is_team_member())', t);
    EXECUTE format('CREATE POLICY require_aal2 ON %I AS RESTRICTIVE FOR ALL USING ((SELECT auth.jwt() ->> ''aal'') = ''aal2'') WITH CHECK ((SELECT auth.jwt() ->> ''aal'') = ''aal2'')', t);
  END LOOP;
END $$;
CREATE POLICY sales_only ON deal AS RESTRICTIVE FOR ALL USING (can_see_sales()) WITH CHECK (can_see_sales());
CREATE POLICY sales_only ON sales_activity AS RESTRICTIVE FOR ALL USING (can_see_sales()) WITH CHECK (can_see_sales());
REVOKE INSERT, UPDATE, DELETE ON audit_event, team_member, evidence FROM anon, authenticated;
`

const PRE_0084 = [BASE, M0039, M0053, M0057, M0071, M0072]

type Who = { sub?: string; aal?: string; role?: 'authenticated' | 'service_role' | 'anon'; headers?: Record<string, string> }
type Exec = { request_id: number; status: string; request_status: string; result: Row; attempts: number; executed_by: string; case_id: number | null }

describe.skipIf(!PGliteCtor)('0084 v Postgresu (PGlite)', () => {
  let db: Db
  const notices: string[] = []
  const onNotice = (n: { severity: string; message: string }) => notices.push(`${n.severity}: ${n.message}`)

  /** Jeden požadavek jako z PostgRESTu: JWT claims (+ hlavičky), SET LOCAL ROLE. */
  async function as<T = Row>(who: Who, sql: string, params?: unknown[]): Promise<T[]> {
    const role = who.role ?? 'authenticated'
    const claims = JSON.stringify({ role, aal: who.aal ?? 'aal2', ...(who.sub ? { sub: who.sub } : {}) })
    await db.exec([
      'BEGIN;',
      `SELECT set_config('request.jwt.claims', '${claims}', true);`,
      who.headers ? `SELECT set_config('request.headers', '${JSON.stringify(who.headers)}', true);` : '',
      `SET LOCAL ROLE ${role};`,
    ].join('\n'))
    try {
      const r = await db.query<T>(sql, params, { onNotice })
      await db.exec('COMMIT')
      return r.rows
    } catch (e) {
      await db.exec('ROLLBACK').catch(() => undefined)
      throw e
    }
  }
  const user = (sub: string, aal = 'aal2'): Who => ({ sub, aal })
  const CRON: Who = { role: 'service_role', headers: { 'x-cockpit-audit-actor': 'system:approval-expiry' } }
  const q = async <T = Row>(sql: string, params?: unknown[]) => (await db.query<T>(sql, params)).rows
  const one = async <T = Row>(sql: string, params?: unknown[]) => (await q<T>(sql, params))[0]
  const count = async (table: string, where = 'true', params?: unknown[]) =>
    (await one<{ n: number }>(`select count(*)::int as n from ${table} where ${where}`, params)).n
  const today = async () => (await one<{ d: string }>(`select approval_today()::text as d`)).d
  const plusDays = async (n: number) => (await one<{ d: string }>(`select (approval_today() + $1::int)::text as d`, [n])).d
  const execOf = (id: number) => one<Exec>('select * from approval_execution where request_id = $1', [id])
  const reqOf = (id: number) => one<Row & { status: string }>('select * from approval_request where id = $1', [id])
  const snapshot = async () => ({
    steps: await count('case_step'), tasks: await count('task'), execs: await count('approval_execution'),
    acts: await count('sales_activity'),
  })

  let account = 0
  let deal = 0
  let caseId = 0
  let decisionId = 0

  async function requestStep(who: string, title: string, extra: Row = {}): Promise<number> {
    const params = JSON.stringify({ title, assignee_id: PAVLA, due_on: await plusDays(5), decision_id: decisionId, ...extra })
    const [r] = await as<{ id: number }>(user(who), `select request_action_approval('confirm_next_step', $1, $2::jsonb, null) as id`, [caseId, params])
    return Number(r.id)
  }
  async function decide(who: string, id: number, approve: boolean, note: string | null = null): Promise<string> {
    const [r] = await as<{ s: string }>(user(who), 'select decide_approval($1, $2, $3) as s', [id, approve, note])
    return r.s
  }
  async function newVersion(version: number, amount = 150000): Promise<number> {
    const [r] = await as<{ id: number }>(user(PETR),
      `insert into deal_scope_version (deal_id, version, scope, amount_one_time, currency, status)
       values ($1, $2, 'Workshop a procesní mapa', $3, 'CZK', 'draft') returning id`, [deal, version, amount])
    return Number(r.id)
  }
  async function requestOffer(who: string, versionId: number): Promise<number> {
    const [r] = await as<{ id: number }>(user(who), `select request_action_approval('send_offer', $1, '{}'::jsonb, null) as id`, [versionId])
    return Number(r.id)
  }

  beforeAll(async () => {
    db = new PGliteCtor!()
    for (const sql of PRE_0084) await db.exec(sql, { onNotice })
    await db.exec(auditMachinery(), { onNotice })
    await db.exec(M0084, { onNotice })
    await db.exec(M0084, { onNotice }) // idempotence

    account = (await one<{ id: number }>(`insert into account (name, owner_id) values ('Acme Stroje', '${PETR}') returning id`)).id
    deal = (await one<{ id: number }>(`insert into deal (account_id, title, owner_id) values (${account}, 'Pilot Acme', '${PETR}') returning id`)).id
    // Případ vzniká jako servisní zápis (bez auth.uid(): trigger 0057 vyžaduje podpis).
    caseId = (await one<{ id: number }>(
      `insert into work_case (title, node, lead_owner_id, status, account_id, deal_id, created_by)
       values ('Workshop Acme', 'vedeni', '${PAVLA}', 'open', ${account}, ${deal}, 'system:test') returning id`)).id
    decisionId = (await one<{ id: number }>(
      `insert into decision (case_id, question, options, chosen, decided_by, decided_at)
       values (${caseId}, 'Pokračovat technickou analýzou?', '["ano","ne"]', 'ano', 'user:${PAVLA}', now()) returning id`)).id
  })

  test('migrace projde dvakrát: ledger jednou, seed pravidel L2, žádné varování o sloupcích auditu', async () => {
    expect(await count('schema_migration', `version = '0084'`)).toBe(1)
    const policies = await q<{ action_kind: string; level: string }>(
      `select action_kind, level from authority_policy where active and action_kind in ('confirm_next_step', 'send_offer') order by action_kind`)
    expect(policies).toEqual([{ action_kind: 'confirm_next_step', level: 'L2' }, { action_kind: 'send_offer', level: 'L2' }])
    expect(notices.filter((n) => /0084: audit trigger/.test(n))).toEqual([])
    const triggers = await q<{ tgname: string }>(
      `select tgname from pg_trigger where tgrelid = 'approval_execution'::regclass and not tgisinternal`)
    expect(triggers.map((t) => t.tgname)).toEqual(['audit_row_change_soft'])
  })

  describe('Potvrdit další krok (bezpečný interní zápis)', () => {
    let r1 = 0

    test('žádost nese druh akce, cíl, otisk, platnost a jediný přechod; dvojklik nezaloží druhou', async () => {
      r1 = await requestStep(PAVLA, 'Technická analýza')
      const req = await reqOf(r1)
      expect(req).toMatchObject({
        action_type: 'confirm_next_step', action_kind: 'confirm_next_step', target_table: 'work_case', target_id: caseId,
        case_id: caseId, node: 'vedeni', requested_level: 'L2', status: 'pending', requested_by: `user:${PAVLA}`,
        transition: 'active>next_step_confirmed',
      })
      expect(req.params_hash).toMatch(/^[0-9a-f]{64}$/)
      expect(req.params).toMatchObject({ title: 'Technická analýza', assignee_id: PAVLA, decision_id: decisionId })
      const days = (new Date(req.expires_at as string).getTime() - Date.now()) / 86_400_000
      expect(days).toBeGreaterThan(6.9)
      expect(days).toBeLessThan(7.1)
      expect(await requestStep(PAVLA, 'Technická analýza')).toBe(r1)
      expect(await count('approval_request', `action_type = 'confirm_next_step' and status = 'pending'`)).toBe(1)
    })

    test('žadatel si neschválí sám, řadový člen ani AAL1 nic — nic se neprovede', async () => {
      const before = await snapshot()
      await expect(decide(PAVLA, r1, true)).rejects.toThrow(/Vlastní požadavek/)
      await expect(decide(PETR, r1, true)).rejects.toThrow(/Nemáš oprávnění/)
      await expect(as(user(LENKA, 'aal1'), 'select decide_approval($1, true, null)', [r1])).rejects.toThrow(/AAL2/)
      await expect(as(user(STRANGER), 'select decide_approval($1, true, null)', [r1])).rejects.toThrow(/Jen pro člena týmu/)
      await expect(as(user(GONE), 'select decide_approval($1, true, null)', [r1])).rejects.toThrow(/Jen pro člena týmu/)
      await expect(as({ role: 'anon' }, 'select decide_approval($1, true, null)', [r1])).rejects.toThrow(/permission denied/)
      expect(await snapshot()).toEqual(before)
      expect((await reqOf(r1)).status).toBe('pending')
    })

    test('schválení vlastníkem uzlu: krok a úkol vzniknou právě jednou, výsledek completed', async () => {
      const before = await snapshot()
      expect(await decide(VIKTOR, r1, true, 'ok')).toBe('approved')
      const ex = await execOf(r1)
      expect(ex).toMatchObject({ status: 'completed', request_status: 'approved', attempts: 1, executed_by: `user:${VIKTOR}`, case_id: caseId })
      const step = await one<Row & { due: string }>(`select *, (due_at at time zone 'Europe/Prague')::text as due from case_step where id = $1`, [ex.result.step_id])
      expect(step).toMatchObject({ case_id: caseId, title: 'Technická analýza', status: 'todo' })
      expect(step.due.startsWith(await plusDays(6))).toBe(true) // konec dne termínu = půlnoc dalšího dne
      const task = await one<Row & { due: string }>('select *, due_on::text as due from task where id = $1', [ex.result.task_id])
      expect(task).toMatchObject({ title: 'Technická analýza', assignee_id: PAVLA, status: 'todo', account_id: account, deal_id: deal, created_by: null })
      expect(task.due).toBe(await plusDays(5))
      expect(await snapshot()).toEqual({ ...before, steps: before.steps + 1, tasks: before.tasks + 1, execs: before.execs + 1 })
    })

    test('opakované schválení, zopakování i denní úloha nic nezdvojí', async () => {
      const before = await snapshot()
      await expect(decide(LENKA, r1, true)).rejects.toThrow(/už není čekající/)
      await expect(as(user(VIKTOR), 'select retry_approval_execution($1)', [r1])).rejects.toThrow(/není co opakovat/)
      await as(CRON, 'select expire_due_approvals(200)')
      expect(await snapshot()).toEqual(before)
      expect((await execOf(r1)).attempts).toBe(1)
    })

    test('audit: rozhodnutí, výsledek i založené řádky se schvalovatelem jako aktérem; volný text jen názvem', async () => {
      const ex = await execOf(r1)
      const created = await one<{ after: Row }>(
        `select after from audit_event where entity_table = 'approval_request' and entity_id = $1 and action = 'approval_request.created'`, [r1])
      expect(created.after).toMatchObject({ action_type: 'confirm_next_step', target_table: 'work_case', transition: 'active>next_step_confirmed' })
      expect(created.after).not.toHaveProperty('params')
      expect(created.after._columns).toContain('params')
      expect(JSON.stringify(created.after)).not.toContain('Technická analýza')
      const execAudit = await one<{ actor_id: string; after: Row }>(
        `select actor_id, after from audit_event where entity_table = 'approval_execution' and action = 'approval_execution.created' and (after ->> 'request_id')::bigint = $1`, [r1])
      expect(execAudit.actor_id).toBe(VIKTOR)
      expect(execAudit.after).toMatchObject({ status: 'completed', request_status: 'approved', request_id: r1 })
      expect(execAudit.after).not.toHaveProperty('result')
      for (const [table, id] of [['task', ex.result.task_id], ['case_step', ex.result.step_id]] as const) {
        const a = await one<{ actor_type: string; actor_id: string }>(
          `select actor_type, actor_id from audit_event where entity_table = $1 and entity_id = $2 and action = $3`, [table, id, `${table}.created`])
        expect(a).toEqual({ actor_type: 'user', actor_id: VIKTOR })
      }
    })

    test('zamítnutí: případ se vrací vlastníkovi s úkolem, krok nevznikne', async () => {
      const r2 = await requestStep(PAVLA, 'Procesní mapa')
      const steps = await count('case_step')
      expect(await decide(LENKA, r2, false, 'Nejdřív rozpočet')).toBe('rejected')
      const ex = await execOf(r2)
      expect(ex).toMatchObject({ status: 'completed', request_status: 'rejected' })
      expect(ex.result).toMatchObject({ reason: 'returned_to_owner', assignee_id: PAVLA })
      const task = await one<{ title: string; description: string; assignee_id: string; deal_id: number }>('select * from task where id = $1', [ex.result.task_id])
      expect(task.title).toMatch(/^Rozhodnout, jak dál: návrh kroku „Procesní mapa“ zamítnut/)
      expect(task.description).toContain('Nejdřív rozpočet')
      expect(task).toMatchObject({ assignee_id: PAVLA, deal_id: deal })
      expect(await count('case_step')).toBe(steps)
    })

    test('parametry se ověřují: cizí rozhodnutí, odešlý řešitel, termín v minulosti, uzavřený případ', async () => {
      await expect(requestStep(PAVLA, 'X', { decision_id: 999999 })).rejects.toThrow(/nepatří/)
      await expect(requestStep(PAVLA, 'X', { assignee_id: GONE })).rejects.toThrow(/aktivní člen/)
      await expect(requestStep(PAVLA, 'X', { due_on: '2000-01-01' })).rejects.toThrow(/Termín/)
      await expect(requestStep(PAVLA, '')).rejects.toThrow(/1 až 300/)
      await expect(as(user(PAVLA), `select request_action_approval('neco_jineho', $1, '{}'::jsonb, null)`, [caseId])).rejects.toThrow(/Neznámý druh akce/)
      // Obecná žádost nesmí vypadat jako akce (CHECK approval_request_typed_kind).
      await expect(as(user(PAVLA), `select request_approval('confirm_next_step', 'L2', $1, now() + interval '1 day')`, [caseId])).rejects.toThrow(/approval_request_typed_kind/)
    })

    test('zápis mimo RPC nejde: executor, tabulka výsledků ani vypršení klient nezavolá', async () => {
      await expect(as(user(VIKTOR), `select approval_execute($1, 'user:${VIKTOR}')`, [r1])).rejects.toThrow(/permission denied/)
      await expect(as(user(VIKTOR), `insert into approval_execution (request_id, action_type, request_status, status, executed_by) values ($1, 'confirm_next_step', 'approved', 'completed', 'user:x')`, [r1]))
        .rejects.toThrow(/permission denied/)
      await expect(as(user(VIKTOR), `update approval_request set status = 'approved' where id = $1`, [r1])).rejects.toThrow(/permission denied/)
      await expect(as(user(VIKTOR), 'select expire_due_approvals(10)')).rejects.toThrow(/permission denied/)
      await expect(as({ role: 'anon' }, `select request_action_approval('confirm_next_step', $1, '{}'::jsonb, null)`, [caseId])).rejects.toThrow(/permission denied/)
      // Tým výsledky čte (časová osa případu), bez AAL2 nic.
      expect((await as(user(PAVLA), 'select count(*)::int as n from approval_execution'))[0]).toMatchObject({ n: expect.any(Number) })
      expect(await as(user(PAVLA, 'aal1'), 'select * from approval_execution')).toEqual([])
    })
  })

  describe('Vypršení (denní úloha) a odložení', () => {
    test('odložit smí jen schvalovatel; ukládá se na žádost, rozhodnutím se ruší', async () => {
      const r = await requestStep(PAVLA, 'Workshop II')
      const until = new Date(Date.now() + 86_400_000).toISOString()
      await expect(as(user(PAVLA), 'select snooze_approval($1, $2)', [r, until])).rejects.toThrow(/Odložit smí jen/)
      await expect(as(user(PETR), 'select snooze_approval($1, $2)', [r, until])).rejects.toThrow(/Odložit smí jen/)
      await expect(as(user(VIKTOR), `select snooze_approval($1, now() + interval '40 days')`, [r])).rejects.toThrow(/30 dní/)
      await as(user(VIKTOR), 'select snooze_approval($1, $2)', [r, until])
      expect(await reqOf(r)).toMatchObject({ snoozed_by: `user:${VIKTOR}` })
      const a = await one<{ after: Row }>(
        `select after from audit_event where entity_table = 'approval_request' and entity_id = $1 and after ? 'snoozed_until' order by id desc limit 1`, [r])
      expect(a.after._columns).toEqual(['snoozed_by', 'snoozed_until'])
      await as(user(VIKTOR), 'select snooze_approval($1, null)', [r])
      expect(await reqOf(r)).toMatchObject({ snoozed_until: null, snoozed_by: null })
      await as(user(VIKTOR), 'select snooze_approval($1, $2)', [r, until])
      await decide(VIKTOR, r, false)
      expect(await reqOf(r)).toMatchObject({ status: 'rejected', snoozed_until: null, snoozed_by: null })
    })

    test('prošlou žádost nejde rozhodnout ani odložit; denní úloha ji uzavře a vrátí vlastníkovi jednou', async () => {
      const r = await requestStep(PAVLA, 'Pilot')
      const legacy = Number((await as<{ id: number }>(user(PAVLA),
        `select request_approval('external_commitment', 'L2', $1, now() + interval '1 day') as id`, [caseId]))[0].id)
      await db.exec(`update approval_request set expires_at = now() - interval '1 minute' where id in (${r}, ${legacy})`)
      await expect(decide(VIKTOR, r, true)).rejects.toThrow(/vypršel/)
      await expect(as(user(VIKTOR), `select snooze_approval($1, now() + interval '1 day')`, [r])).rejects.toThrow(/vypršel/)
      const before = await snapshot()

      const [{ s }] = await as<{ s: Row }>(CRON, 'select expire_due_approvals(200) as s')
      expect(s).toMatchObject({ expired: 2, completed: 1 })
      expect(await reqOf(r)).toMatchObject({ status: 'expired', decided_by: null })
      expect((await reqOf(r)).decided_at).not.toBeNull()
      expect(await reqOf(legacy)).toMatchObject({ status: 'expired' })
      expect(await count('approval_execution', 'request_id = $1', [legacy])).toBe(0) // žádost „jen záznam" nic neprovádí
      const ex = await execOf(r)
      expect(ex).toMatchObject({ status: 'completed', request_status: 'expired', executed_by: 'system:approval-expiry' })
      const task = await one<{ title: string; assignee_id: string }>('select * from task where id = $1', [ex.result.task_id])
      expect(task.title).toMatch(/vypršel$/)
      expect(task.assignee_id).toBe(PAVLA)
      expect(await snapshot()).toEqual({ ...before, tasks: before.tasks + 1, execs: before.execs + 1 })
      const audit = await one<{ actor_type: string; actor_id: string }>(
        `select actor_type, actor_id from audit_event where entity_table = 'approval_request' and entity_id = $1 and after ->> 'status' = 'expired'`, [r])
      expect(audit).toEqual({ actor_type: 'system', actor_id: 'approval-expiry' })

      const [{ s: again }] = await as<{ s: Row }>(CRON, 'select expire_due_approvals(200) as s')
      expect(again).toMatchObject({ expired: 0, retried: 0 })
      expect(await snapshot()).toEqual({ ...before, tasks: before.tasks + 1, execs: before.execs + 1 })
    })
  })

  describe('Selhání provedení a opakování', () => {
    test('chyba se zachytí (nic se nezapíše), výsledek failed; opakování založí jen jednou', async () => {
      await db.exec(`ALTER TABLE task ADD CONSTRAINT test_no_boom CHECK (title <> 'BOOM')`)
      const r = await requestStep(PAVLA, 'BOOM')
      const before = await snapshot()
      expect(await decide(VIKTOR, r, true)).toBe('approved')
      const failed = await execOf(r)
      expect(failed).toMatchObject({ status: 'failed', attempts: 1 })
      expect(failed.result).toEqual({ sqlstate: '23514' })
      expect(await snapshot()).toEqual({ ...before, execs: before.execs + 1 }) // krok ani úkol nezůstal
      expect(notices.some((n) => /0084: provedení žádosti \d+ selhalo \(SQLSTATE 23514\)/.test(n))).toBe(true)

      await expect(as(user(PETR), 'select retry_approval_execution($1)', [r])).rejects.toThrow(/smí žadatel, schvalovatel nebo vedení/)
      await db.exec('ALTER TABLE task DROP CONSTRAINT test_no_boom')
      const [{ s }] = await as<{ s: string }>(user(PAVLA), 'select retry_approval_execution($1) as s', [r])
      expect(s).toBe('completed')
      expect(await execOf(r)).toMatchObject({ status: 'completed', attempts: 2 })
      expect(await snapshot()).toEqual({ ...before, execs: before.execs + 1, steps: before.steps + 1, tasks: before.tasks + 1 })
      await expect(as(user(PAVLA), 'select retry_approval_execution($1)', [r])).rejects.toThrow(/není co opakovat/)
    })

    test('denní úloha zkusí neúspěšné provedení znovu', async () => {
      await db.exec(`ALTER TABLE task ADD CONSTRAINT test_no_boom CHECK (title <> 'BOOM 2')`)
      const r = await requestStep(PAVLA, 'BOOM 2')
      await decide(VIKTOR, r, true)
      expect((await execOf(r)).status).toBe('failed')
      await db.exec('ALTER TABLE task DROP CONSTRAINT test_no_boom')
      const [{ s }] = await as<{ s: Row }>(CRON, 'select expire_due_approvals(200) as s')
      expect(s).toMatchObject({ retried: 1, completed: 1 })
      expect(await execOf(r)).toMatchObject({ status: 'completed', attempts: 2, executed_by: 'system:approval-expiry' })
    })

    test('uzavřený případ: schválený krok se nezaloží, vlastník dostane úkol ke kontrole (needs_attention)', async () => {
      const closing = (await one<{ id: number }>(
        `insert into work_case (title, node, lead_owner_id, status, created_by) values ('Krátký případ', 'vedeni', '${PAVLA}', 'open', 'system:test') returning id`)).id
      const params = JSON.stringify({ title: 'Závěrečná zpráva', assignee_id: PAVLA, due_on: await plusDays(3) })
      const [{ id }] = await as<{ id: number }>(user(PAVLA), `select request_action_approval('confirm_next_step', $1, $2::jsonb, null) as id`, [closing, params])
      await db.exec(`update work_case set status = 'cancelled' where id = ${closing}`)
      const steps = await count('case_step', 'case_id = $1', [closing])
      await decide(VIKTOR, Number(id), true)
      const ex = await execOf(Number(id))
      expect(ex).toMatchObject({ status: 'needs_attention' })
      expect(ex.result).toMatchObject({ reason: 'case_closed', assignee_id: PAVLA })
      expect(await count('case_step', 'case_id = $1', [closing])).toBe(steps)
      const task = await one<{ title: string }>('select title from task where id = $1', [ex.result.task_id])
      expect(task.title).toBe('Zkontrolovat schválený krok: Závěrečná zpráva')
    })
  })

  describe('Odeslat nabídku klientovi (nic se neodesílá)', () => {
    let v1 = 0
    let r4 = 0

    test('bez schválení nejde verze označit jako odeslaná ani schválená', async () => {
      v1 = await newVersion(1)
      await expect(as(user(PETR), `update deal_scope_version set status = 'sent' where id = $1`, [v1])).rejects.toThrow(/bez schválené žádosti/)
      await expect(as(user(PETR), `update deal_scope_version set send_approved_at = now(), send_approval_request_id = 1 where id = $1`, [v1]))
        .rejects.toThrow(/nastavuje jen schválená žádost/)
      await expect(as(user(PETR),
        `insert into deal_scope_version (deal_id, version, scope, status, send_approved_at, send_approval_request_id) values ($1, 99, 'x', 'draft', now(), 1)`, [deal]))
        .rejects.toThrow(/nastavuje jen schválená žádost/)
      expect(await one('select status, sent_at from deal_scope_version where id = $1', [v1])).toEqual({ status: 'draft', sent_at: null })
    })

    test('žádost: jen obchodní role, parametry bez částek, uzel z konfigurace, dvojklik vrátí stejnou', async () => {
      await expect(requestOffer(PAVLA, v1)).rejects.toThrow(/jen obchodní role/)
      r4 = await requestOffer(PETR, v1)
      const req = await reqOf(r4)
      expect(req).toMatchObject({
        action_type: 'send_offer', target_table: 'deal_scope_version', target_id: v1, case_id: null, node: 'obchod',
        transition: 'draft>send_approved', requested_level: 'L2',
      })
      expect(req.params).toEqual({ deal_id: deal, version_id: v1, version: 1 })
      expect(JSON.stringify(req.params)).not.toContain('150000')
      expect(await requestOffer(PETR, v1)).toBe(r4)
    })

    test('schvalovat smí jen obchodní role s pravomocí; žadatel ne', async () => {
      await expect(decide(PETR, r4, true)).rejects.toThrow(/Vlastní požadavek/)
      // Pavla jako zástupkyně uzlu má pravomoc do L2, ale nabídku nevidí.
      await db.exec(`update loop_node set deputy_id = '${PAVLA}' where node = 'obchod'`)
      await expect(decide(PAVLA, r4, true)).rejects.toThrow(/jen obchodní role/)
      await db.exec(`update loop_node set deputy_id = null where node = 'obchod'`)
      expect(await count('approval_execution', 'request_id = $1', [r4])).toBe(0)
    })

    test('schválení: verze → schváleno k odeslání, úkol vlastníkovi obchodu a záznam do aktivit; nic neodešlo', async () => {
      const before = await snapshot()
      expect(await decide(VIKTOR, r4, true)).toBe('approved')
      const ex = await execOf(r4)
      expect(ex).toMatchObject({ status: 'completed', request_status: 'approved', case_id: null })
      const ver = await one<Row>('select status, sent_at, send_approved_at, send_approval_request_id from deal_scope_version where id = $1', [v1])
      expect(ver).toMatchObject({ status: 'draft', sent_at: null, send_approval_request_id: r4 })
      expect(ver.send_approved_at).not.toBeNull()
      const task = await one<Row & { due: string }>('select *, due_on::text as due from task where id = $1', [ex.result.task_id])
      expect(task).toMatchObject({ title: 'Odeslat nabídku klientovi (verze 1)', assignee_id: PETR, priority: 'high', deal_id: deal, account_id: account })
      expect(String(task.description)).toContain('Cockpit nic neodesílá')
      expect(task.due > (await today())).toBe(true)
      const act = await one<Row>(`select * from sales_activity where source = 'approval' and external_id = $1`, [`approval:${r4}`])
      expect(act).toMatchObject({ deal_id: deal, account_id: account, kind: 'note', subject: 'Nabídka (verze 1) schválena k odeslání' })
      expect(await snapshot()).toEqual({ ...before, tasks: before.tasks + 1, execs: before.execs + 1, acts: before.acts + 1 })
      const a = await one<{ after: Row }>(
        `select after from audit_event where entity_table = 'deal_scope_version' and entity_id = $1 and action = 'deal_scope_version.updated' order by id desc limit 1`, [v1])
      expect(a.after._columns).toEqual(['send_approval_request_id', 'send_approved_at'])
      expect(a.after.send_approval_request_id).toBe(r4)
    })

    test('schválenou verzi nejde měnit; odeslat ji pak smí člověk', async () => {
      await expect(as(user(PETR), `update deal_scope_version set scope = 'jiný rozsah' where id = $1`, [v1])).rejects.toThrow(/Schválenou verzi/)
      await as(user(PETR), `update deal_scope_version set status = 'sent' where id = $1`, [v1])
      const ver = await one<Row>('select status, sent_at from deal_scope_version where id = $1', [v1])
      expect(ver.status).toBe('sent')
      expect(ver.sent_at).not.toBeNull()
      const before = await snapshot()
      await as(CRON, 'select expire_due_approvals(200)')
      expect(await snapshot()).toEqual(before)
    })

    test('verze se po žádosti změnila: schválení se neuplatní (needs_attention) a vlastník dostane úkol', async () => {
      const v2 = await newVersion(2, 180000)
      const r5 = await requestOffer(PETR, v2)
      await as(user(PETR), `update deal_scope_version set amount_one_time = 99000 where id = $1`, [v2])
      await expect(requestOffer(PETR, v2)).rejects.toThrow(/už čeká/)
      expect(await decide(LENKA, r5, true)).toBe('approved')
      const ex = await execOf(r5)
      expect(ex).toMatchObject({ status: 'needs_attention' })
      expect(ex.result).toMatchObject({ reason: 'version_changed', assignee_id: PETR })
      expect(await one('select send_approved_at from deal_scope_version where id = $1', [v2])).toEqual({ send_approved_at: null })
      expect(await count('sales_activity', 'external_id = $1', [`approval:${r5}`])).toBe(0)
      expect((await one<{ title: string }>('select title from task where id = $1', [ex.result.task_id])).title)
        .toBe('Zkontrolovat nabídku (verze 2): schválení k odeslání se neuplatnilo')
    })

    test('zamítnutí: verze zůstává konceptem, vlastník obchodu dostane úkol a obchod záznam', async () => {
      const v3 = await newVersion(3, 120000)
      const r6 = await requestOffer(PETR, v3)
      expect(await decide(LENKA, r6, false, 'Cena je moc nízko')).toBe('rejected')
      const ex = await execOf(r6)
      expect(ex).toMatchObject({ status: 'completed', request_status: 'rejected' })
      expect(ex.result).toMatchObject({ reason: 'returned_to_owner', assignee_id: PETR, version: 3 })
      expect(await one('select status, send_approved_at from deal_scope_version where id = $1', [v3])).toEqual({ status: 'draft', send_approved_at: null })
      const task = await one<{ title: string; description: string }>('select title, description from task where id = $1', [ex.result.task_id])
      expect(task.title).toBe('Nabídka (verze 3): odeslání zamítnuto — upravit, nebo požádat znovu')
      expect(task.description).toContain('Cena je moc nízko')
      expect(await count('sales_activity', 'external_id = $1', [`approval:${r6}`])).toBe(1)
    })
  })

  test('hranice odeslání v SQL == offerNeedsSendApproval v TS (výchozí 0 Kč i jiná hranice)', async () => {
    const samples: [number, number, 'CZK' | 'EUR'][] = [[0, 0, 'CZK'], [99999, 0, 'CZK'], [100000, 0, 'CZK'], [40000, 5000, 'CZK'], [10, 0, 'EUR']]
    const check = async (threshold: number) => {
      for (const [amount, mrr, currency] of samples) {
        const [{ r }] = await q<{ r: boolean }>('select approval_offer_requires_approval($1, $2, $3) as r', [amount, mrr, currency])
        expect(r, `${amount}/${mrr}/${currency} při hranici ${threshold}`).toBe(
          offerNeedsSendApproval({ amount_one_time: amount, expected_mrr: mrr, currency }, threshold))
      }
    }
    await check(0)
    const settings = (await one<{ s: Row }>('select approval_action_settings() as s')).s
    const changed = JSON.stringify({ ...settings, send_offer: { ...(settings.send_offer as Row), require_approval_from_czk: 100000 } })
    await db.exec('BEGIN')
    try {
      await db.exec(`CREATE OR REPLACE FUNCTION approval_action_settings() RETURNS jsonb LANGUAGE sql IMMUTABLE AS $$ SELECT '${changed}'::jsonb $$`)
      await check(100000)
    } finally {
      await db.exec('ROLLBACK')
    }
    await check(0)
  })

  test('pomocné funkce: pracovní dny a aktér', async () => {
    const d = (from: string, n: number) => one<{ d: string }>('select approval_add_working_days($1::date, $2)::text as d', [from, n])
    expect((await d('2026-10-02', 1)).d).toBe('2026-10-05') // pátek + 1 = pondělí
    expect((await d('2026-09-29', 0)).d).toBe('2026-09-29')
    expect((await one<{ u: string | null }>(`select approval_member_uuid('user:${VIKTOR}') as u`)).u).toBe(VIKTOR)
    expect((await one<{ u: string | null }>(`select approval_member_uuid('system:approval-expiry') as u`)).u).toBeNull()
  })

  test('žádost „jen záznam" (bez druhu akce) se chová jako dřív: rozhodnutí bez provedení', async () => {
    const [{ id }] = await as<{ id: number }>(user(PAVLA), `select request_approval('external_commitment', 'L2', $1, null) as id`, [caseId])
    expect(await decide(VIKTOR, Number(id), true)).toBe('approved')
    expect(await count('approval_execution', 'request_id = $1', [id])).toBe(0)
  })
})
