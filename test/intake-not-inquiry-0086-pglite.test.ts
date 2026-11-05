// 0086 v opravdovém Postgresu (PGlite = PostgreSQL ve WASM), bez sítě a bez
// živé DB. PGlite NENÍ závislost projektu: bez `npm i -D @electric-sql/pglite`
// se celý soubor přeskočí (statické kontroly běží v test/migrations-lint.test.ts
// a test/intake-not-inquiry.test.tsx). Ověřuje slib tlačítka „Není poptávka":
//   * Zpět smaže i to, co k poptávce později přidal automat (další e-mail téže
//     domény, nedotčený follow-up případ, úkol zapsaný do kalendáře),
//   * lidskou práci nesmaže nikdy (a řekne v DETAIL, co brání),
//   * „Uzavřít jako Není poptávka" nic nemaže: obchod do Prohráno s důvodem,
//     úkol hotovo, firma odložená o rok, záznam poptávky 'dismissed'.
//
// Schéma je zúžená kopie skutečných tabulek (názvy sloupců, typy, CHECKy,
// cizí klíče a triggery, na které funkce sahají), ne celá historie migrací.
// Nad ním běží 0081 a pak 0086 (dvakrát — idempotence).
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, test, vi } from 'vitest'

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 })

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

const MIG_0081 = readFileSync('supabase/migrations/0081_auto_intake.sql', 'utf8')
const MIG_0086 = readFileSync('supabase/migrations/0086_intake_not_inquiry.sql', 'utf8')
const MIG_0095 = readFileSync('supabase/migrations/0095_security_review_hardening.sql', 'utf8')
// Jen část auto_intake_dismiss z 0096 (zbytek 0096 chce jiné tabulky, viz test/security-0096-pglite.test.ts).
const MIG_0096_FULL = readFileSync('supabase/migrations/0096_security_round2.sql', 'utf8')
const MIG_0096 = (() => {
  const start = MIG_0096_FULL.indexOf('-- 4) D3 (zbytek)')
  const end = MIG_0096_FULL.indexOf('-- 5) D7')
  if (start < 0 || end < start) throw new Error('0096: struktura se změnila, uprav vytažení části auto_intake_dismiss v testu')
  return MIG_0096_FULL.slice(start, end)
})()
const VIKTOR = '11111111-1111-4111-8111-111111111111' // vedení (obchodní role)
const LENKA = '22222222-2222-4222-8222-222222222222' // projekťák (bez obchodní role)
const STRANGER = '99999999-9999-4999-8999-999999999999' // není člen týmu

const SCHEMA = `
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid $$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claims', true), '')::jsonb $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role' $$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
GRANT USAGE ON SCHEMA public TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;

CREATE TABLE schema_migration (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now(), note text);
CREATE TABLE team_member (id uuid PRIMARY KEY, full_name text, email text, role text NOT NULL DEFAULT 'partner');
INSERT INTO team_member VALUES ('${VIKTOR}', 'Viktor', 'viktor@mummiesdaddies.com', 'vedeni'), ('${LENKA}', 'Lenka', 'lenka@mummiesdaddies.com', 'projektak');
CREATE FUNCTION is_team_member() RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM team_member WHERE id = auth.uid()) $$;
CREATE FUNCTION can_see_sales() RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM team_member WHERE id = auth.uid() AND role IN ('vedeni', 'obchodnik')) $$;
CREATE FUNCTION loop_actor() RETURNS text LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Nepřihlášený uživatel' USING ERRCODE = '42501'; END IF;
  IF coalesce(auth.jwt() ->> 'aal', '') <> 'aal2' THEN RAISE EXCEPTION 'Vyžadováno dvoufázové ověření (AAL2)' USING ERRCODE = '42501'; END IF;
  IF NOT is_team_member() THEN RAISE EXCEPTION 'Jen pro člena týmu' USING ERRCODE = '42501'; END IF;
  RETURN 'user:' || auth.uid()::text;
END $$;

-- Audit: zjednodušený trigger (skutečný je v 0064) — aktér jako v audit_request_context.
CREATE TABLE audit_event (
  id bigserial PRIMARY KEY, actor_type text NOT NULL, actor_id text, action text NOT NULL,
  entity_table text NOT NULL, entity_id bigint, before jsonb, after jsonb
);
CREATE FUNCTION audit_row_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO audit_event (actor_type, actor_id, action, entity_table, entity_id, before, after)
  VALUES (CASE WHEN auth.uid() IS NOT NULL THEN 'user' ELSE 'system' END,
          coalesce(auth.uid()::text, auth.role()),
          TG_TABLE_NAME || '.' || lower(TG_OP), TG_TABLE_NAME,
          coalesce((to_jsonb(NEW) ->> 'id')::bigint, (to_jsonb(OLD) ->> 'id')::bigint),
          CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END,
          CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE to_jsonb(NEW) END);
  RETURN NULL;
END $$;

CREATE TYPE revenue_category AS ENUM ('one_time', 'recurring', 'royalty');
CREATE TYPE revenue_line AS ENUM ('catering_firemni', 'oslava_soukroma', 'svatebni_hostina', 'cheesecaky_eshop', 'firemni_pravidelny', 'pronajem_prostor', 'provize');
CREATE TYPE deal_stage AS ENUM ('lead', 'nabídka', 'kvalifikace', 'diagnostika', 'rozsah_nabidka', 'rozhodovani', 'vyhráno', 'prohráno', 'odloženo');
CREATE TYPE task_status AS ENUM ('todo', 'in_progress', 'blocked', 'done');
CREATE TYPE task_priority AS ENUM ('low', 'normal', 'high');
CREATE TYPE sales_activity_kind AS ENUM ('call', 'email', 'meeting', 'note', 'other');
CREATE TYPE sales_activity_outcome AS ENUM ('completed', 'no_answer', 'follow_up', 'cancelled');

CREATE TABLE partner (id bigserial PRIMARY KEY, name text NOT NULL);
CREATE TABLE account (
  id bigserial PRIMARY KEY, name text NOT NULL, web text, ico text, notes text,
  owner_id uuid REFERENCES team_member(id) ON DELETE SET NULL,
  last_inbound_at timestamptz, last_outbound_at timestamptz, snooze_until date,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE contact (
  id bigserial PRIMARY KEY, account_id bigint REFERENCES account(id) ON DELETE CASCADE,
  partner_id bigint REFERENCES partner(id) ON DELETE CASCADE,
  full_name text NOT NULL, role text, email text,
  CONSTRAINT contact_belongs_to_one CHECK ((account_id IS NOT NULL AND partner_id IS NULL) OR (account_id IS NULL AND partner_id IS NOT NULL))
);
CREATE TABLE deal (
  id bigserial PRIMARY KEY, account_id bigint NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  title text NOT NULL, revenue_line revenue_line NOT NULL, revenue_category revenue_category NOT NULL,
  stage deal_stage NOT NULL DEFAULT 'kvalifikace', probability_pct integer CHECK (probability_pct BETWEEN 0 AND 100),
  amount_one_time numeric(14,2) DEFAULT 0,
  owner_id uuid REFERENCES team_member(id) ON DELETE SET NULL,
  primary_contact_id bigint REFERENCES contact(id) ON DELETE SET NULL,
  next_step text, next_step_due date, note text, last_activity_at timestamptz,
  lost_reason text, closed_at date, won_at date,
  forecast_category text NOT NULL DEFAULT 'pipeline' CHECK (forecast_category IN ('pipeline', 'best_case', 'commit', 'closed'))
);
-- Pravidlo přechodu z 0052: do Prohráno jen s důvodem (CR002).
CREATE FUNCTION deal_stage_transition_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD.stage IS NOT DISTINCT FROM NEW.stage THEN RETURN NEW; END IF;
  IF NEW.stage::text = 'prohráno' AND (NEW.lost_reason IS NULL OR btrim(NEW.lost_reason) = '') THEN
    RAISE EXCEPTION 'Prohraný obchod musí mít důvod prohry.' USING ERRCODE = 'CR002';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER deal_stage_transition_guard_trigger BEFORE INSERT OR UPDATE OF stage ON deal
  FOR EACH ROW EXECUTE FUNCTION deal_stage_transition_guard();
CREATE TABLE deal_partner (deal_id bigint NOT NULL REFERENCES deal(id) ON DELETE CASCADE, partner_id bigint NOT NULL REFERENCES partner(id) ON DELETE CASCADE, program text NOT NULL, PRIMARY KEY (deal_id, partner_id, program));
CREATE TABLE task (
  id bigserial PRIMARY KEY, title text NOT NULL, status task_status NOT NULL DEFAULT 'todo', priority task_priority NOT NULL DEFAULT 'normal',
  assignee_id uuid REFERENCES team_member(id) ON DELETE SET NULL, due_on date,
  account_id bigint REFERENCES account(id) ON DELETE SET NULL, deal_id bigint REFERENCES deal(id) ON DELETE SET NULL, ms_event_id text
);
CREATE TABLE sales_activity (
  id bigserial PRIMARY KEY, account_id bigint REFERENCES account(id) ON DELETE CASCADE,
  partner_id bigint REFERENCES partner(id) ON DELETE CASCADE,
  deal_id bigint REFERENCES deal(id) ON DELETE SET NULL, contact_id bigint REFERENCES contact(id) ON DELETE SET NULL,
  kind sales_activity_kind NOT NULL, outcome sales_activity_outcome NOT NULL DEFAULT 'completed',
  subject text NOT NULL, body text, occurred_at timestamptz NOT NULL DEFAULT now(), follow_up_on date,
  created_by uuid REFERENCES team_member(id) ON DELETE SET NULL, source text, external_id text
);
CREATE UNIQUE INDEX sales_activity_external_idx ON sales_activity(source, external_id) WHERE external_id IS NOT NULL;
CREATE TABLE company_alias (
  id bigserial PRIMARY KEY, account_id bigint NOT NULL REFERENCES account(id) ON DELETE CASCADE,
  alias_domain text, alias_name text
);
CREATE TABLE evidence (id bigserial PRIMARY KEY, source_kind text NOT NULL, source_id text NOT NULL, web_link text);
CREATE TABLE mail_event (
  id bigserial PRIMARY KEY, internet_message_id text NOT NULL, direction text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  occurred_at timestamptz NOT NULL, account_id bigint REFERENCES account(id) ON DELETE CASCADE,
  contact_id bigint REFERENCES contact(id) ON DELETE SET NULL,
  match_status text NOT NULL CHECK (match_status IN ('matched', 'ambiguous', 'unknown')),
  counterpart_domain text, created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mail_event_msg_dir_unique UNIQUE (internet_message_id, direction),
  CONSTRAINT mail_event_matched_has_account CHECK ((match_status = 'matched' AND account_id IS NOT NULL) OR (match_status <> 'matched' AND account_id IS NULL AND contact_id IS NULL))
);
CREATE TABLE engagement (id bigserial PRIMARY KEY, account_id bigint NOT NULL REFERENCES account(id) ON DELETE CASCADE, deal_id bigint REFERENCES deal(id) ON DELETE SET NULL);
-- Zástupce dokumentů z 0094 jen proto, aby prošel guard 0095 (jeho chování ověřuje test/security-0095-documents-pglite.test.ts).
CREATE TABLE engagement_document (
  id bigserial PRIMARY KEY, drive_id text, item_id text, e_tag text, c_tag text, version_label text, last_modified_at timestamptz,
  last_modified_by text, source_state text, source_checked_at timestamptz, status text NOT NULL DEFAULT 'draft', approved_version_id bigint
);
CREATE FUNCTION engagement_document_workflow_guard() RETURNS trigger LANGUAGE plpgsql SET search_path = public, pg_temp AS $$ BEGIN RETURN NEW; END $$;
CREATE TABLE case_proposal (id bigserial PRIMARY KEY, account_id bigint REFERENCES account(id) ON DELETE CASCADE, status text NOT NULL DEFAULT 'pending', created_by text NOT NULL);

-- Loop Core (0039/0057/0062), zúženě: případ, krok, rozhodnutí, schválení, alokace.
CREATE TABLE work_case (
  id bigserial PRIMARY KEY, title text NOT NULL, status text NOT NULL DEFAULT 'open',
  account_id bigint REFERENCES account(id) ON DELETE SET NULL, deal_id bigint REFERENCES deal(id) ON DELETE SET NULL,
  created_by text,
  CONSTRAINT work_case_status_check CHECK (status IN ('open', 'in_progress', 'waiting', 'done', 'cancelled'))
);
CREATE TABLE case_step (
  id bigserial PRIMARY KEY, case_id bigint NOT NULL REFERENCES work_case(id) ON DELETE CASCADE,
  position integer NOT NULL DEFAULT 0, title text NOT NULL, status text NOT NULL DEFAULT 'todo'
);
CREATE TABLE decision (id bigserial PRIMARY KEY, case_id bigint NOT NULL REFERENCES work_case(id) ON DELETE RESTRICT, question text NOT NULL);
CREATE TABLE approval_request (id bigserial PRIMARY KEY, case_id bigint REFERENCES work_case(id) ON DELETE RESTRICT, status text NOT NULL DEFAULT 'pending');
CREATE TABLE allocation (id bigserial PRIMARY KEY, work_case_id bigint REFERENCES work_case(id) ON DELETE CASCADE, hours_per_week numeric NOT NULL);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['account', 'contact', 'deal', 'task', 'sales_activity', 'company_alias', 'work_case', 'case_step'] LOOP
    EXECUTE format('CREATE TRIGGER audit_row_change AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION audit_row_change()', t);
  END LOOP;
END $$;
`

function payload(over: Row = {}): string {
  const base = {
    message_id: '<m1@acme-stroje.cz>',
    domain: 'acme-stroje.cz',
    occurred_at: '2026-09-29T07:30:00Z',
    today: '2026-09-29',
    daily_limit: 10,
    owner_id: VIKTOR,
    reasons: ['corporate_domain', 'personal_sender'],
    account: { name: 'Acme Stroje', notes: 'Vzniklo automaticky z e-mailu.' },
    contact: { full_name: 'Jan Novák', email: 'jan.novak@acme-stroje.cz' },
    deal: {
      title: 'Poptávka z e-mailu — Acme Stroje', revenue_line: 'catering_firemni', revenue_category: 'one_time',
      stage: 'kvalifikace', next_step: 'Odpovědět na poptávku', next_step_due: '2026-09-30', note: 'Vzniklo automaticky z e-mailu.',
    },
    task: { title: 'Odpovědět na poptávku — Acme Stroje', due_on: '2026-09-30', priority: 'high' },
    activity: { subject: 'Příchozí e-mail (poptávka, vzniklo automaticky)' },
    ...over,
  }
  return JSON.stringify(base).replace(/'/g, "''")
}

type PgError = Error & { code?: string; detail?: string }

describe.skipIf(!PGliteCtor)('0086 „Není poptávka" v Postgresu (PGlite)', () => {
  let db: Db

  async function run<T = Row>(claims: Row, role: string, sql: string): Promise<T[]> {
    await db.exec(`BEGIN;\nSELECT set_config('request.jwt.claims', '${JSON.stringify(claims)}', true);\nSET LOCAL ROLE ${role};`)
    try {
      const r = await db.query<T>(sql)
      await db.exec('COMMIT')
      return r.rows
    } catch (e) {
      await db.exec('ROLLBACK').catch(() => undefined)
      throw e
    }
  }
  /** Jako service_role (cron, webhook, follow-up hlídač). */
  const svc = <T = Row>(sql: string) => run<T>({ role: 'service_role' }, 'service_role', sql)
  /** Jako přihlášený člověk. */
  const as = <T = Row>(sub: string | null, aal: string, sql: string) =>
    run<T>({ role: 'authenticated', aal, ...(sub ? { sub } : {}) }, 'authenticated', sql)
  const q = async <T = Row>(sql: string) => (await db.query<T>(sql)).rows
  const count = async (table: string) => Number((await q<{ n: string }>(`SELECT count(*) AS n FROM ${table}`))[0].n)
  const found = async (over: Row = {}) =>
    (await svc<{ r: Row }>(`SELECT auto_intake_found('${payload(over)}'::jsonb) AS r`))[0].r
  const undo = async (id = 1, sub = VIKTOR, aal = 'aal2') =>
    (await as<{ r: Row }>(sub, aal, `SELECT auto_intake_undo(${id}) AS r`))[0].r
  const dismiss = async (id = 1, sub = VIKTOR, aal = 'aal2') =>
    (await as<{ r: Row }>(sub, aal, `SELECT auto_intake_dismiss(${id}) AS r`))[0].r
  /** Chyba z Postgresu i s kódem a DETAIL (co brání vrácení). */
  async function failure(p: Promise<unknown>): Promise<{ code?: string; detail?: string; message: string }> {
    try {
      await p
    } catch (e) {
      const err = e as PgError
      return { code: err.code, detail: err.detail, message: err.message }
    }
    throw new Error('očekávaná chyba nenastala')
  }
  const pragueToday = async () =>
    (await q<{ d: string }>(`SELECT ((now() AT TIME ZONE 'Europe/Prague')::date)::text AS d`))[0].d
  const plusDays = async (days: number) =>
    (await q<{ d: string }>(`SELECT (((now() AT TIME ZONE 'Europe/Prague')::date) + ${days})::text AS d`))[0].d

  async function reset() {
    await db.exec(`
      TRUNCATE auto_intake, audit_event, mail_event, case_proposal, engagement, deal_partner, allocation, approval_request,
               decision, case_step, work_case, task, sales_activity, company_alias, contact, deal, account, evidence
               RESTART IDENTITY CASCADE;`)
  }
  /** Jedna poptávka s vysokou jistotou (klient 1, kontakt 1, obchod 1, úkol 1, aktivita 1). */
  async function seed(over: Row = {}) {
    await reset()
    return found(over)
  }
  /** Follow-up hlídač (service_role, 'system:follow-up-watch'): případ s krokem „Ozvat se klientovi". */
  async function followUpCase(): Promise<number> {
    const [c] = await svc<{ id: number }>(`
      INSERT INTO work_case (title, status, account_id, deal_id, created_by)
      VALUES ('Follow-up: Poptávka z e-mailu — Acme Stroje', 'open', 1, 1, 'system:follow-up-watch') RETURNING id`)
    await svc(`INSERT INTO case_step (case_id, position, title, status) VALUES (${c.id}, 1, 'Ozvat se klientovi', 'todo')`)
    return c.id
  }

  beforeAll(async () => {
    db = new PGliteCtor!()
    await db.exec(SCHEMA)
    await db.exec(MIG_0081)
    await db.exec(MIG_0086)
    await db.exec(MIG_0086) // idempotence
    await db.exec(MIG_0095)
    await db.exec(MIG_0095) // idempotence
    await db.exec(MIG_0096)
    await db.exec(MIG_0096) // idempotence
  }, 60_000)

  test('ledger nese 0086 právě jednou; stav smí být dismissed jen s rozhodnutím', async () => {
    expect(Number((await q<{ n: string }>(`SELECT count(*) AS n FROM schema_migration WHERE version = '0086'`))[0].n)).toBe(1)
    await reset()
    await expect(db.exec(`INSERT INTO auto_intake (source_key, domain, occurred_at, created_day, status) VALUES ('k1', 'firma.cz', now(), current_date, 'dismissed')`)).rejects.toThrow()
    await db.exec(`INSERT INTO auto_intake (source_key, domain, occurred_at, created_day, status, decided_by, decided_at) VALUES ('k2', 'firma.cz', now(), current_date, 'dismissed', 'user:x', now())`)
    await expect(db.exec(`INSERT INTO auto_intake (source_key, domain, occurred_at, created_day, status) VALUES ('k3', 'firma.cz', now(), current_date, 'jiny')`)).rejects.toThrow()
  })

  describe('Zpět smaže i to, co přidal automat', () => {
    test('další e-mail téže domény (aktivita automatu) nebrání a odejde s poptávkou', async () => {
      await seed()
      expect(await found({ message_id: '<m2@acme-stroje.cz>' })).toMatchObject({ status: 'attached' })
      expect(await count('sales_activity')).toBe(2)
      const r = await undo()
      expect(r).toMatchObject({ status: 'undone', calendar_event: false, deleted: { extra_activities: 1, activity: 1, account: 1 } })
      for (const t of ['account', 'contact', 'deal', 'task', 'sales_activity', 'company_alias']) expect(await count(t), t).toBe(0)
      expect((await q<Row>('SELECT status FROM auto_intake'))[0]).toEqual({ status: 'undone' })
    })

    test('nedotčený follow-up případ systému odejde i s krokem', async () => {
      await seed()
      await followUpCase()
      const r = await undo()
      expect(r).toMatchObject({ status: 'undone', deleted: { cases: 1, deal: 1, account: 1 } })
      expect(await count('work_case')).toBe(0)
      expect(await count('case_step')).toBe(0)
      // smazání auditují triggery s aktérem = člověk
      const del = await q<{ actor_type: string; actor_id: string }>(`SELECT actor_type, actor_id FROM audit_event WHERE action = 'work_case.delete'`)
      expect(del).toEqual([{ actor_type: 'user', actor_id: VIKTOR }])
    })

    test('úkol zapsaný do Outlooku nebrání; výsledek řekne, ať člověk smaže událost v kalendáři', async () => {
      await seed()
      await db.exec(`UPDATE task SET ms_event_id = 'AAMk-udalost' WHERE id = 1`)
      expect(await undo()).toMatchObject({ status: 'undone', calendar_event: true, deleted: { task: 1 } })
      expect(await count('task')).toBe(0)
    })

    test('všechno najednou: druhý e-mail, follow-up případ, úkol v kalendáři a čekající systémový návrh', async () => {
      await seed()
      await found({ message_id: '<m2@acme-stroje.cz>' })
      await followUpCase()
      await db.exec(`UPDATE task SET ms_event_id = 'AAMk' WHERE id = 1;
        INSERT INTO case_proposal (account_id, status, created_by) VALUES (1, 'pending', 'system:mail_to_case');`)
      expect(await undo()).toMatchObject({ status: 'undone', calendar_event: true })
      for (const t of ['account', 'deal', 'task', 'sales_activity', 'work_case', 'case_step', 'case_proposal']) expect(await count(t), t).toBe(0)
    })
  })

  describe('lidskou práci Zpět nesmaže nikdy — a řekne, co brání', () => {
    const cases: [string, string, string][] = [
      ['aktivita od člověka', `INSERT INTO sales_activity (account_id, kind, subject, created_by) VALUES (1, 'meeting', 'Schůzka', '${VIKTOR}')`, 'sales_activity'],
      ['úkol od člověka', `INSERT INTO task (title, account_id) VALUES ('Zavolat', 1)`, 'task'],
      ['úkol se řeší', `UPDATE task SET status = 'in_progress' WHERE id = 1`, 'task_started'],
      ['obchod se posunul', `UPDATE deal SET stage = 'diagnostika' WHERE id = 1`, 'deal_moved'],
      ['dodávka', `INSERT INTO engagement (account_id) VALUES (1)`, 'engagement'],
      ['případ od člověka', `INSERT INTO work_case (title, account_id, created_by) VALUES ('Nabídka', 1, 'user:${VIKTOR}')`, 'work_case'],
    ]
    for (const [label, sql, detail] of cases) {
      test(label, async () => {
        await seed()
        await db.exec(sql)
        const err = await failure(undo())
        expect(err.code, label).toBe('AI001')
        expect(err.detail, label).toBe(detail)
        expect(await count('account')).toBe(1)
        expect((await q<Row>('SELECT status FROM auto_intake'))[0]).toEqual({ status: 'active' })
      })
    }

    test('follow-up případ, na který člověk sáhl, je lidská práce', async () => {
      const touched: [string, (caseId: number) => Promise<unknown>][] = [
        ['krok rozpracovaný', (id) => db.exec(`UPDATE case_step SET status = 'doing' WHERE case_id = ${id}`)],
        ['případ v práci', (id) => db.exec(`UPDATE work_case SET status = 'in_progress' WHERE id = ${id}`)],
        ['krok přidal člověk (audit)', (id) => as(VIKTOR, 'aal2', `INSERT INTO case_step (case_id, position, title) VALUES (${id}, 2, 'Poslat podklady')`)],
        ['případ upravil člověk (audit)', (id) => as(VIKTOR, 'aal2', `UPDATE work_case SET title = 'Follow-up: Acme — volat' WHERE id = ${id}`)],
        ['rozhodnutí', (id) => db.exec(`INSERT INTO decision (case_id, question) VALUES (${id}, 'Pokračovat?')`)],
        ['schválení', (id) => db.exec(`INSERT INTO approval_request (case_id) VALUES (${id})`)],
        ['alokace', (id) => db.exec(`INSERT INTO allocation (work_case_id, hours_per_week) VALUES (${id}, 4)`)],
      ]
      for (const [label, touch] of touched) {
        await seed()
        const id = await followUpCase()
        await touch(id)
        const err = await failure(undo())
        expect(err.code, label).toBe('AI001')
        expect(err.detail, label).toBe('work_case')
        expect(await count('work_case'), label).toBe(1)
        expect(await count('account'), label).toBe(1)
      }
    })

    test('poptávka bez kontaktu: kontakt přidaný člověkem brání (chyba 0081 s NULL)', async () => {
      await seed({ contact: null })
      await db.exec(`INSERT INTO contact (account_id, full_name, email) VALUES (1, 'Petr', 'petr@acme-stroje.cz')`)
      const err = await failure(undo())
      expect(err).toMatchObject({ code: 'AI001', detail: 'contact' })
      expect(await count('contact')).toBe(1)
    })
  })

  describe('Uzavřít jako Není poptávka (bez mazání)', () => {
    test('obchod do Prohráno s důvodem, úkol hotovo, firma odložená o rok, poptávka dismissed — nic nezmizí', async () => {
      await seed()
      await db.exec(`INSERT INTO sales_activity (account_id, kind, subject, created_by) VALUES (1, 'call', 'Telefonát', '${VIKTOR}')`)
      const mark = Number((await q<{ m: string }>('SELECT coalesce(max(id), 0) AS m FROM audit_event'))[0].m)
      const r = await dismiss()
      const year = await plusDays(365)
      expect(r).toMatchObject({ status: 'dismissed', deal: 'lost', task: 'done', snooze_until: year })

      const [deal] = await q<Row>(`SELECT stage::text AS stage, lost_reason, closed_at::text AS closed, forecast_category, probability_pct, next_step, next_step_due FROM deal`)
      expect(deal).toEqual({
        stage: 'prohráno', lost_reason: 'Nebyla to poptávka', closed: await pragueToday(), forecast_category: 'closed',
        probability_pct: 0, next_step: null, next_step_due: null,
      })
      expect((await q<Row>(`SELECT status::text AS status FROM task`))[0]).toEqual({ status: 'done' })
      expect((await q<Row>(`SELECT snooze_until::text AS s FROM account`))[0]).toEqual({ s: year })
      const [ledger] = await q<Row>(`SELECT status, decided_by, account_id, deal_id, task_id FROM auto_intake`)
      expect(ledger).toEqual({ status: 'dismissed', decided_by: `user:${VIKTOR}`, account_id: 1, deal_id: 1, task_id: 1 })
      for (const [t, n] of [['account', 1], ['contact', 1], ['deal', 1], ['task', 1], ['sales_activity', 2], ['company_alias', 1]] as const) {
        expect(await count(t), t).toBe(n)
      }
      // změny firmy, záznamu poptávky, obchodu a úkolu nesou jako aktéra člověka, který klikl
      const changes = await q<{ entity_table: string; actor_type: string; actor_id: string }>(
        `SELECT entity_table, actor_type, actor_id FROM audit_event WHERE id > ${mark} AND action LIKE '%.update' ORDER BY entity_table`)
      expect(changes).toEqual([
        { entity_table: 'account', actor_type: 'user', actor_id: VIKTOR },
        { entity_table: 'auto_intake', actor_type: 'user', actor_id: VIKTOR },
        { entity_table: 'deal', actor_type: 'user', actor_id: VIKTOR },
        { entity_table: 'task', actor_type: 'user', actor_id: VIKTOR },
      ])
    })

    test('delší odklad firmy se nezkracuje, prohraný obchod ani hotový úkol se nemění', async () => {
      await seed()
      await db.exec(`UPDATE account SET snooze_until = '2031-01-01';
        UPDATE deal SET stage = 'prohráno', lost_reason = 'Jiný důvod' WHERE id = 1;
        UPDATE task SET status = 'done' WHERE id = 1;`)
      expect(await dismiss()).toMatchObject({ status: 'dismissed', deal: 'already_lost', task: 'none', snooze_until: '2031-01-01' })
      expect((await q<Row>(`SELECT lost_reason FROM deal`))[0]).toEqual({ lost_reason: 'Jiný důvod' })
    })

    test('0095: s obchodem se už pracuje (jiná fáze nebo částka) → AI003, nic se nezmění', async () => {
      for (const work of [`UPDATE deal SET stage = 'diagnostika' WHERE id = 1`, `UPDATE deal SET amount_one_time = 45000 WHERE id = 1`, `UPDATE deal SET stage = 'rozhodovani', amount_one_time = 1 WHERE id = 1`]) {
        await seed()
        await db.exec(work)
        const before = await q<Row>(`SELECT stage::text AS stage, lost_reason, forecast_category, probability_pct, next_step, closed_at, amount_one_time::text AS amount FROM deal`)
        const err = await failure(dismiss())
        expect(err, work).toMatchObject({ code: 'AI003', detail: 'deal_moved' })
        expect(await q<Row>(`SELECT stage::text AS stage, lost_reason, forecast_category, probability_pct, next_step, closed_at, amount_one_time::text AS amount FROM deal`), work).toEqual(before)
        // ani úkol, ani firma, ani záznam poptávky se nedotknou
        expect((await q<Row>(`SELECT status::text AS s FROM task`))[0]).toEqual({ s: 'todo' })
        expect((await q<Row>(`SELECT snooze_until FROM account`))[0]).toEqual({ snooze_until: null })
        expect((await q<Row>(`SELECT status FROM auto_intake`))[0]).toEqual({ status: 'active' })
      }
    })

    test('0095: prohraný obchod s částkou zůstane already_lost a uzavření projde', async () => {
      await seed()
      await db.exec(`UPDATE deal SET stage = 'prohráno', lost_reason = 'Cena', amount_one_time = 100 WHERE id = 1`)
      expect(await dismiss()).toMatchObject({ status: 'dismissed', deal: 'already_lost' })
      expect((await q<Row>(`SELECT lost_reason FROM deal`))[0]).toEqual({ lost_reason: 'Cena' })
    })

    test('0095: podpis, práva a ledger se nezměnily', async () => {
      const [fn] = await q<{ sig: string; def: string }>(`SELECT pg_get_function_identity_arguments(p.oid) AS sig, prosecdef::text AS def FROM pg_proc p WHERE proname = 'auto_intake_dismiss'`)
      expect(fn).toEqual({ sig: 'p_id bigint', def: 'true' })
      expect(Number((await q<{ n: string }>(`SELECT count(*) AS n FROM schema_migration WHERE version = '0095'`))[0].n)).toBe(1)
    })

    test('0096: rozpracovaný nebo zablokovaný úkol se nezavře (task kept), zbytek se uzavře', async () => {
      for (const status of ['in_progress', 'blocked']) {
        await seed()
        await db.exec(`UPDATE task SET status = '${status}' WHERE id = 1`)
        const r = await dismiss()
        expect(r, status).toMatchObject({ status: 'dismissed', deal: 'lost', task: 'kept', account: 'snoozed' })
        expect((await q<Row>(`SELECT status::text AS s FROM task`))[0], status).toEqual({ s: status })
        expect((await q<Row>(`SELECT status FROM auto_intake`))[0]).toEqual({ status: 'dismissed' })
      }
    })

    test('0096: firma s jiným obchodem se neodloží (account kept); jeho prohraný obchod nevadí', async () => {
      await seed()
      await db.exec(`INSERT INTO deal (account_id, title, revenue_line, revenue_category, stage) VALUES (1, 'Starší obchod', 'oslava_soukroma', 'one_time', 'diagnostika')`)
      const r = await dismiss()
      expect(r).toMatchObject({ status: 'dismissed', deal: 'lost', task: 'done', snooze_until: null, account: 'kept' })
      expect((await q<Row>(`SELECT snooze_until FROM account`))[0]).toEqual({ snooze_until: null })
      // Vlastní obchod poptávky je prohraný, cizí zůstal.
      expect((await q<Row>(`SELECT id, stage::text AS stage FROM deal ORDER BY id`))).toEqual([{ id: 1, stage: 'prohráno' }, { id: 2, stage: 'diagnostika' }])

      await seed()
      await db.exec(`INSERT INTO deal (account_id, title, revenue_line, revenue_category, stage, lost_reason) VALUES (1, 'Prohraný dřív', 'oslava_soukroma', 'one_time', 'prohráno', 'Cena')`)
      expect(await dismiss()).toMatchObject({ status: 'dismissed', account: 'snoozed', snooze_until: await plusDays(365) })
    })

    test('0096: firma s dodávkou nebo vyhraným obchodem (skutečný klient) se neodloží', async () => {
      await seed()
      await db.exec(`INSERT INTO engagement (account_id) VALUES (1)`)
      expect(await dismiss()).toMatchObject({ status: 'dismissed', account: 'kept', snooze_until: null })
      expect((await q<Row>(`SELECT snooze_until FROM account`))[0]).toEqual({ snooze_until: null })

      await seed()
      await db.exec(`INSERT INTO deal (account_id, title, revenue_line, revenue_category, stage) VALUES (1, 'Vyhraný', 'oslava_soukroma', 'one_time', 'vyhráno')`)
      expect(await dismiss()).toMatchObject({ status: 'dismissed', account: 'kept' })
    })

    test('0096: podpis, práva a ledger; klíče výsledku jen přibyly', async () => {
      const [fn] = await q<{ sig: string; def: string }>(`SELECT pg_get_function_identity_arguments(p.oid) AS sig, prosecdef::text AS def FROM pg_proc p WHERE proname = 'auto_intake_dismiss'`)
      expect(fn).toEqual({ sig: 'p_id bigint', def: 'true' })
      await seed()
      expect(Object.keys(await dismiss()).sort()).toEqual(['account', 'deal', 'id', 'snooze_until', 'status', 'task'])
    })

    test('vyhraný obchod: poptávka to byla — nic se nezmění (AI002)', async () => {
      await seed()
      await db.exec(`UPDATE deal SET stage = 'vyhráno' WHERE id = 1`)
      expect((await failure(dismiss())).code).toBe('AI002')
      expect((await q<Row>(`SELECT status FROM auto_intake`))[0]).toEqual({ status: 'active' })
      expect((await q<Row>(`SELECT status::text AS s FROM task`))[0]).toEqual({ s: 'todo' })
      expect((await q<Row>(`SELECT snooze_until FROM account`))[0]).toEqual({ snooze_until: null })
    })

    test('po uzavření: Zpět ani druhé uzavření nejde, další e-mail domény se jen připíše k firmě', async () => {
      await seed()
      await dismiss()
      expect(await failure(dismiss())).toMatchObject({ code: '22023', message: expect.stringMatching(/uzavřeno/) })
      expect(await failure(undo())).toMatchObject({ code: '22023', message: expect.stringMatching(/uzavřeno/) })
      expect(await found({ message_id: '<m3@acme-stroje.cz>' })).toMatchObject({ status: 'attached', account_id: 1 })
      expect(await count('account')).toBe(1)
    })

    test('po vrácení už uzavřít nejde', async () => {
      await seed()
      await undo()
      expect(await failure(dismiss())).toMatchObject({ code: '22023', message: expect.stringMatching(/vráceno/) })
    })

    test('jen obchodní role s AAL2; anonym funkci vůbec nespustí', async () => {
      await seed()
      expect(await failure(dismiss(1, VIKTOR, 'aal1'))).toMatchObject({ code: '42501' })
      expect(await failure(dismiss(1, STRANGER))).toMatchObject({ code: '42501' })
      expect(await failure(dismiss(1, LENKA))).toMatchObject({ code: '42501' })
      expect((await failure(run({ role: 'anon' }, 'anon', 'SELECT auto_intake_dismiss(1)'))).message).toMatch(/permission denied/)
      expect((await q<Row>(`SELECT status FROM auto_intake`))[0]).toEqual({ status: 'active' })
      expect((await q<Row>(`SELECT stage::text AS s FROM deal`))[0]).toEqual({ s: 'kvalifikace' })
    })

    test('neexistující záznam', async () => {
      await reset()
      expect((await failure(dismiss(999))).code).toBe('P0002')
    })
  })
})
