// 0081 v opravdovém Postgresu (PGlite = PostgreSQL ve WASM), bez sítě a bez
// živé DB. PGlite je v devDependencies, v bráně (build:release) i v CI běží;
// kdyby chyběl, červeně selže test/pglite-dependency.test.ts.
// (Statické kontroly migrací běží také v
// test/migrations-lint.test.ts). Ověřuje to, na čem stojí slib
// „nezaloží nic dvakrát a Zpět nenechá sirotky": atomické založení, limit,
// duplicity, paměť zamítnuté domény, kontrolu cizí práce při Zpět a RLS.
//
// Schéma níž je zúžená kopie skutečných tabulek (názvy sloupců, typy, CHECKy
// a unikátní indexy, na které RPC sahá), ne celá historie migrací.
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, test, vi } from 'vitest'

// PGlite je pod zátěží celé sady pomalé; výchozích 5 s nestačí.
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

const MIG = readFileSync('supabase/migrations/0081_auto_intake.sql', 'utf8')
const VIKTOR = '11111111-1111-4111-8111-111111111111' // obchodník (vedení)
const LENKA = '22222222-2222-4222-8222-222222222222' // člen týmu bez obchodní role
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
-- Supabase dává novým tabulkám v public plná práva; migrace je má omezit sama.
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
-- Audit: zjednodušený trigger, jen zapíše řádek (skutečný je v 0064).
CREATE TABLE audit_event (id bigserial PRIMARY KEY, action text NOT NULL, entity_table text NOT NULL, entity_id bigint, actor text, after jsonb);
CREATE FUNCTION audit_row_change() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp AS $$
BEGIN
  INSERT INTO audit_event (action, entity_table, entity_id, actor)
  VALUES (TG_TABLE_NAME || '.' || lower(TG_OP), TG_TABLE_NAME, coalesce((to_jsonb(NEW) ->> 'id')::bigint, (to_jsonb(OLD) ->> 'id')::bigint),
          coalesce(auth.uid()::text, auth.role()));
  RETURN NULL;
END $$;

CREATE TYPE revenue_category AS ENUM ('one_time', 'recurring', 'royalty');
CREATE TYPE revenue_line AS ENUM ('catering_firemni', 'oslava_soukroma', 'svatebni_hostina', 'cheesecaky_eshop', 'firemni_pravidelny', 'pronajem_prostor', 'provize');
CREATE TYPE deal_stage AS ENUM ('lead', 'nabídka', 'kvalifikace', 'diagnostika', 'rozsah_nabidka', 'rozhodovani', 'vyhráno', 'prohráno');
CREATE TYPE task_status AS ENUM ('todo', 'in_progress', 'blocked', 'done');
CREATE TYPE task_priority AS ENUM ('low', 'normal', 'high');
CREATE TYPE sales_activity_kind AS ENUM ('call', 'email', 'meeting', 'note', 'other');
CREATE TYPE sales_activity_outcome AS ENUM ('completed', 'no_answer', 'follow_up', 'cancelled');

CREATE TABLE partner (id bigserial PRIMARY KEY, name text NOT NULL);
CREATE TABLE account (
  id bigserial PRIMARY KEY, name text NOT NULL, web text, ico text, notes text,
  owner_id uuid REFERENCES team_member(id) ON DELETE SET NULL,
  last_inbound_at timestamptz, last_outbound_at timestamptz,
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
  stage deal_stage NOT NULL DEFAULT 'kvalifikace', amount_one_time numeric(14,2) DEFAULT 0,
  owner_id uuid REFERENCES team_member(id) ON DELETE SET NULL,
  primary_contact_id bigint REFERENCES contact(id) ON DELETE SET NULL,
  next_step text, next_step_due date, note text, last_activity_at timestamptz
);
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
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['account', 'contact', 'deal', 'task', 'sales_activity', 'company_alias'] LOOP
    EXECUTE format('CREATE TRIGGER audit_row_change AFTER INSERT OR UPDATE OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION audit_row_change()', t);
  END LOOP;
END $$;
-- Dvě tabulky, které jsou „cizí práce" u klienta.
CREATE TABLE engagement (id bigserial PRIMARY KEY, account_id bigint NOT NULL REFERENCES account(id) ON DELETE CASCADE, deal_id bigint REFERENCES deal(id) ON DELETE SET NULL);
CREATE TABLE case_proposal (id bigserial PRIMARY KEY, account_id bigint REFERENCES account(id) ON DELETE CASCADE, status text NOT NULL DEFAULT 'pending', created_by text NOT NULL);
`

const DAY = '2026-09-29'
const OWNER = VIKTOR

function payload(over: Row = {}): string {
  const base = {
    message_id: '<m1@acme-stroje.cz>',
    domain: 'acme-stroje.cz',
    occurred_at: '2026-09-29T07:30:00Z',
    today: DAY,
    daily_limit: 10,
    owner_id: OWNER,
    reasons: ['corporate_domain', 'personal_sender'],
    account: { name: 'Acme Stroje', notes: 'Vzniklo automaticky z e-mailu.' },
    contact: { full_name: 'Jan Novák', email: 'Jan.Novak@ACME-stroje.cz' },
    deal: {
      title: 'Acme Stroje — poptávka z e-mailu', revenue_line: 'catering_firemni', revenue_category: 'one_time',
      stage: 'kvalifikace', next_step: 'Odpovědět na poptávku', next_step_due: '2026-09-30', note: 'Vzniklo automaticky z e-mailu.',
    },
    task: { title: 'Odpovědět na poptávku — Acme Stroje', due_on: '2026-09-30', priority: 'high' },
    activity: { subject: 'Příchozí e-mail (poptávka, vzniklo automaticky)' },
    ...over,
  }
  return JSON.stringify(base).replace(/'/g, "''")
}

describe.skipIf(!PGliteCtor)('0081 auto_intake v Postgresu (PGlite)', () => {
  let db: Db

  /** Jako service_role (cron / webhook). */
  async function svc<T = Row>(sql: string): Promise<T[]> {
    await db.exec(`BEGIN;\nSELECT set_config('request.jwt.claims', '${JSON.stringify({ role: 'service_role' })}', true);\nSET LOCAL ROLE service_role;`)
    try {
      const r = await db.query<T>(sql)
      await db.exec('COMMIT')
      return r.rows
    } catch (e) {
      await db.exec('ROLLBACK').catch(() => undefined)
      throw e
    }
  }
  /** Jako přihlášený člověk. */
  async function as<T = Row>(sub: string | null, aal: string, sql: string): Promise<T[]> {
    const claims = JSON.stringify({ role: 'authenticated', aal, ...(sub ? { sub } : {}) })
    await db.exec(`BEGIN;\nSELECT set_config('request.jwt.claims', '${claims}', true);\nSET LOCAL ROLE authenticated;`)
    try {
      const r = await db.query<T>(sql)
      await db.exec('COMMIT')
      return r.rows
    } catch (e) {
      await db.exec('ROLLBACK').catch(() => undefined)
      throw e
    }
  }
  const q = async <T = Row>(sql: string) => (await db.query<T>(sql)).rows
  const count = async (table: string) => Number((await q<{ n: string }>(`SELECT count(*) AS n FROM ${table}`))[0].n)
  const found = async (over: Row = {}) =>
    (await svc<{ r: Row }>(`SELECT auto_intake_found('${payload(over)}'::jsonb) AS r`))[0].r
  const undo = async (id: number, sub = VIKTOR, aal = 'aal2') =>
    (await as<{ r: Row }>(sub, aal, `SELECT auto_intake_undo(${id}) AS r`))[0].r

  async function reset() {
    await db.exec(`
      TRUNCATE auto_intake, audit_event, mail_event, case_proposal, engagement, deal_partner, task, sales_activity,
               company_alias, contact, deal, account, evidence RESTART IDENTITY CASCADE;`)
  }

  beforeAll(async () => {
    db = new PGliteCtor!()
    await db.exec(SCHEMA)
    await db.exec(MIG)
    await db.exec(MIG) // idempotence
  }, 60_000)

  test('ledger nese 0081 právě jednou a tabulka má RLS', async () => {
    expect(Number((await q<{ n: string }>(`SELECT count(*) AS n FROM schema_migration WHERE version = '0081'`))[0].n)).toBe(1)
    expect((await q<{ relrowsecurity: boolean }>(`SELECT relrowsecurity FROM pg_class WHERE relname = 'auto_intake'`))[0].relrowsecurity).toBe(true)
  })

  describe('auto_intake_found', () => {
    test('založí všechno v jedné transakci a napojí metadata pošty', async () => {
      await reset()
      await db.exec(`
        INSERT INTO evidence (source_kind, source_id) VALUES ('email_message', '<m1@acme-stroje.cz>');
        INSERT INTO mail_event (internet_message_id, direction, occurred_at, match_status, counterpart_domain) VALUES
          ('<m1@acme-stroje.cz>', 'inbound', '2026-09-29T07:30:00Z', 'unknown', 'acme-stroje.cz'),
          ('<old@acme-stroje.cz>', 'outbound', '2026-09-25T10:00:00Z', 'unknown', 'acme-stroje.cz'),
          ('<other@jina.cz>', 'inbound', '2026-09-29T06:00:00Z', 'unknown', 'jina.cz');`)
      const r = await found({ evidence_id: 1 })
      expect(r).toMatchObject({ status: 'created' })
      expect(await count('account')).toBe(1)

      const [acc] = await q<Row>('SELECT * FROM account')
      expect(acc).toMatchObject({ name: 'Acme Stroje', owner_id: VIKTOR })
      expect(new Date(acc.last_inbound_at as string).toISOString()).toBe('2026-09-29T07:30:00.000Z')
      expect(new Date(acc.last_outbound_at as string).toISOString()).toBe('2026-09-25T10:00:00.000Z')

      expect((await q<Row>('SELECT alias_domain FROM company_alias'))[0]).toEqual({ alias_domain: 'acme-stroje.cz' })
      const [contact] = await q<Row>('SELECT * FROM contact')
      expect(contact).toMatchObject({ full_name: 'Jan Novák', email: 'jan.novak@acme-stroje.cz' })
      const [deal] = await q<Row>('SELECT *, next_step_due::text AS due FROM deal')
      expect(deal).toMatchObject({
        stage: 'kvalifikace', owner_id: VIKTOR, next_step: 'Odpovědět na poptávku', primary_contact_id: contact.id, revenue_category: 'one_time',
      })
      expect(deal.due).toBe('2026-09-30')
      const [task] = await q<Row>('SELECT * FROM task')
      expect(task).toMatchObject({ status: 'todo', priority: 'high', assignee_id: VIKTOR, account_id: acc.id, deal_id: deal.id })
      const [act] = await q<Row>('SELECT * FROM sales_activity')
      expect(act).toMatchObject({ kind: 'email', source: 'auto_intake', external_id: '<m1@acme-stroje.cz>', deal_id: deal.id, contact_id: contact.id })

      // zprávy téže domény jsou spárované, cizí doména zůstala; kontakt jen u zprávy, ze které to vzniklo
      const events = await q<Row>('SELECT internet_message_id, match_status, account_id, contact_id, counterpart_domain FROM mail_event ORDER BY id')
      expect(events).toEqual([
        { internet_message_id: '<m1@acme-stroje.cz>', match_status: 'matched', account_id: acc.id, contact_id: contact.id, counterpart_domain: null },
        { internet_message_id: '<old@acme-stroje.cz>', match_status: 'matched', account_id: acc.id, contact_id: null, counterpart_domain: null },
        { internet_message_id: '<other@jina.cz>', match_status: 'unknown', account_id: null, contact_id: null, counterpart_domain: 'jina.cz' },
      ])

      const [ledger] = await q<Row>('SELECT *, created_day::text AS day FROM auto_intake')
      expect(ledger).toMatchObject({
        status: 'active', domain: 'acme-stroje.cz', source_key: '<m1@acme-stroje.cz>', account_id: acc.id, contact_id: contact.id,
        deal_id: deal.id, task_id: task.id, activity_id: act.id, evidence_id: 1, created_by: 'system:auto_intake',
      })
      expect(ledger.day).toBe(DAY)
      expect(ledger.reasons).toEqual(['corporate_domain', 'personal_sender'])
      // audit řádků, které RPC založila (zjednodušený trigger; skutečný je 0064)
      const actions = (await q<{ action: string }>('SELECT action FROM audit_event ORDER BY id')).map((a) => a.action)
      expect(actions).toEqual(expect.arrayContaining(['account.insert', 'contact.insert', 'deal.insert', 'task.insert', 'sales_activity.insert', 'company_alias.insert', 'auto_intake.insert']))
    })

    test('stejná zpráva podruhé nezaloží nic (idempotence)', async () => {
      await reset()
      const first = await found()
      const second = await found()
      expect(first).toMatchObject({ status: 'created' })
      expect(second).toMatchObject({ status: 'duplicate', account_id: (first as Row).account_id })
      expect([await count('account'), await count('deal'), await count('task'), await count('contact'), await count('auto_intake'), await count('sales_activity')])
        .toEqual([1, 1, 1, 1, 1, 1])
    })

    test('kontakt je nepovinný', async () => {
      await reset()
      const r = await found({ contact: null })
      expect(r).toMatchObject({ status: 'created', contact_id: null })
      expect(await count('contact')).toBe(0)
    })

    test('druhá zpráva téže domény nezaloží druhého klienta, jen aktivitu', async () => {
      await reset()
      await found()
      const r = await found({ message_id: '<m2@acme-stroje.cz>' })
      expect(r).toMatchObject({ status: 'attached' })
      expect(await count('account')).toBe(1)
      expect(await count('deal')).toBe(1)
      expect(await count('sales_activity')).toBe(2)
      // a znovu tatáž = duplicate
      expect(await found({ message_id: '<m2@acme-stroje.cz>' })).toMatchObject({ status: 'duplicate' })
      expect(await count('sales_activity')).toBe(2)
    })

    test('doména už v CRM je (alias, kontakt, web) → jen aktivita, nikdy druhý klient', async () => {
      for (const seed of [
        `INSERT INTO account (name) VALUES ('Někdo'); INSERT INTO company_alias (account_id, alias_domain) VALUES (1, '@Acme-Stroje.cz');`,
        `INSERT INTO account (name) VALUES ('Někdo'); INSERT INTO contact (account_id, full_name, email) VALUES (1, 'Petr', 'petr@ACME-stroje.cz');`,
        `INSERT INTO account (name, web) VALUES ('Někdo', 'https://www.Acme-Stroje.cz:8080/kontakt?x=1');`,
        `INSERT INTO account (name, web) VALUES ('Někdo', 'acme-stroje.cz');`,
      ]) {
        await reset()
        await db.exec(seed)
        const r = await found()
        expect(r).toMatchObject({ status: 'attached', account_id: 1 })
        expect(await count('account')).toBe(1)
        expect(await count('deal')).toBe(0)
        expect(await count('auto_intake')).toBe(0)
        expect((await q<Row>('SELECT kind, source, account_id FROM sales_activity'))[0]).toEqual({ kind: 'email', source: 'auto_intake', account_id: 1 })
      }
    })

    test('web jiné firmy s podobným řetězcem doménu nezabere', async () => {
      await reset()
      await db.exec(`INSERT INTO account (name, web) VALUES ('Jiná', 'https://acme-stroje.cz.evil.example/'), ('Další', 'https://notacme-stroje.cz');`)
      expect(await found()).toMatchObject({ status: 'created' })
    })

    test('doména vede na víc klientů → ambiguous, nic se nezaloží', async () => {
      await reset()
      await db.exec(`INSERT INTO account (name) VALUES ('A'), ('B');
        INSERT INTO company_alias (account_id, alias_domain) VALUES (1, 'acme-stroje.cz'), (2, 'acme-stroje.cz');`)
      const r = await found()
      expect(r).toMatchObject({ status: 'ambiguous', account_ids: [1, 2] })
      expect(await count('account')).toBe(2)
      expect(await count('sales_activity')).toBe(0)
      expect(await count('auto_intake')).toBe(0)
    })

    test('firma stejného názvu už existuje → name_conflict', async () => {
      await reset()
      await db.exec(`INSERT INTO account (name) VALUES ('  ACME STROJE ');`)
      expect(await found()).toMatchObject({ status: 'name_conflict' })
      expect(await count('account')).toBe(1)
    })

    test('denní limit: nad limit nic, jiný den znovu; vrácené se počítají', async () => {
      await reset()
      const lim = { daily_limit: 2 }
      expect(await found({ ...lim, message_id: '<a@a.cz>', domain: 'a-firma.cz', account: { name: 'A Firma' } })).toMatchObject({ status: 'created' })
      expect(await found({ ...lim, message_id: '<b@b.cz>', domain: 'b-firma.cz', account: { name: 'B Firma' } })).toMatchObject({ status: 'created' })
      const third = await found({ ...lim, message_id: '<c@c.cz>', domain: 'c-firma.cz', account: { name: 'C Firma' } })
      expect(third).toMatchObject({ status: 'limit', count: 2 })
      expect(await count('account')).toBe(2)
      // vrácení místo neuvolní
      await undo(1)
      expect(await found({ ...lim, message_id: '<c@c.cz>', domain: 'c-firma.cz', account: { name: 'C Firma' } })).toMatchObject({ status: 'limit' })
      // další pražský den
      expect(await found({ ...lim, today: '2026-09-30', message_id: '<c@c.cz>', domain: 'c-firma.cz', account: { name: 'C Firma' } })).toMatchObject({ status: 'created' })
    })

    test('neplatný vstup skončí chybou a nezapíše nic', async () => {
      await reset()
      for (const bad of [
        { domain: 'gmail' }, { domain: 'a@b.cz' }, { domain: '' }, { message_id: '' }, { daily_limit: 0 }, { owner_id: 'není-uuid' },
        { occurred_at: 'včera' }, { account: { name: '' } }, { deal: { title: '' } }, { contact: { full_name: 'Jan', email: '' } },
        { deal: { title: 'X', revenue_line: 'nic', revenue_category: 'one_time', stage: 'kvalifikace' } },
      ]) {
        await expect(found(bad as Row)).rejects.toThrow()
      }
      expect(await count('account')).toBe(0)
      expect(await count('auto_intake')).toBe(0)
    })

    test('selhání uprostřed (neexistující vlastník) nezanechá sirotky', async () => {
      await reset()
      await expect(found({ owner_id: '33333333-3333-4333-8333-333333333333' })).rejects.toThrow()
      for (const t of ['account', 'contact', 'deal', 'task', 'sales_activity', 'company_alias', 'auto_intake']) expect(await count(t)).toBe(0)
    })

    test('volat smí jen service_role', async () => {
      await reset()
      await expect(as(VIKTOR, 'aal2', `SELECT auto_intake_found('${payload()}'::jsonb)`)).rejects.toThrow(/permission denied/)
      await expect(as(null, 'aal2', `SELECT auto_intake_found('${payload()}'::jsonb)`)).rejects.toThrow(/permission denied/)
      expect(await count('account')).toBe(0)
    })
  })

  describe('auto_intake_undo (Zpět)', () => {
    async function seedOne() {
      await reset()
      await db.exec(`INSERT INTO mail_event (internet_message_id, direction, occurred_at, match_status, counterpart_domain)
        VALUES ('<m1@acme-stroje.cz>', 'inbound', '2026-09-29T07:30:00Z', 'unknown', 'acme-stroje.cz');
        INSERT INTO evidence (source_kind, source_id) VALUES ('email_message', '<m1@acme-stroje.cz>');`)
      return found({ evidence_id: 1 })
    }

    test('smaže všechno, co vzniklo, zapamatuje doménu a nezanechá sirotky', async () => {
      await seedOne()
      const r = await undo(1)
      expect(r).toMatchObject({ status: 'undone', deleted: { task: 1, activity: 1, deal: 1, contact: 1, alias: 1, account: 1 } })
      for (const t of ['account', 'contact', 'deal', 'task', 'sales_activity', 'company_alias', 'mail_event']) expect(await count(t)).toBe(0)
      const [ledger] = await q<Row>('SELECT * FROM auto_intake')
      expect(ledger).toMatchObject({
        status: 'undone', domain: 'acme-stroje.cz', decided_by: `user:${VIKTOR}`,
        account_id: null, contact_id: null, deal_id: null, task_id: null, activity_id: null, alias_id: null,
      })
      expect(ledger.decided_at).toBeTruthy()
      // evidence (ukazatel) zůstává
      expect(await count('evidence')).toBe(1)
      // aktér smazání je člověk
      const del = await q<{ action: string; actor: string }>(`SELECT action, actor FROM audit_event WHERE action LIKE '%.delete' ORDER BY id`)
      expect(del.map((d) => d.action).sort()).toEqual(['account.delete', 'company_alias.delete', 'contact.delete', 'deal.delete', 'sales_activity.delete', 'task.delete'])
      expect(new Set(del.map((d) => d.actor))).toEqual(new Set([VIKTOR]))
    })

    test('doména je po Zpět zamítnutá: další zpráva z ní nezaloží nic', async () => {
      await seedOne()
      await undo(1)
      expect(await found({ message_id: '<m9@acme-stroje.cz>' })).toMatchObject({ status: 'rejected' })
      expect(await count('account')).toBe(0)
      // jiná doména dál jde
      expect(await found({ message_id: '<x@x.cz>', domain: 'x-firma.cz', account: { name: 'X Firma' } })).toMatchObject({ status: 'created' })
    })

    test('druhé Zpět, neexistující záznam', async () => {
      await seedOne()
      await undo(1)
      await expect(undo(1)).rejects.toThrow(/Už bylo vráceno/)
      await expect(undo(999)).rejects.toThrow(/neexistuje/)
    })

    // Chování samotné 0081. Migrace 0086 (test/intake-not-inquiry-0086-pglite.test.ts)
    // funkci nahrazuje: úkol v kalendáři a práce automatů už Zpět nebrání.
    test('odmítne, když u klienta vznikla cizí práce — a nesmaže vůbec nic', async () => {
      const others: [string, string][] = [
        ['jiná aktivita', `INSERT INTO sales_activity (account_id, kind, subject) VALUES (1, 'meeting', 'Schůzka')`],
        ['jiný obchod', `INSERT INTO deal (account_id, title, revenue_line, revenue_category) VALUES (1, 'Druhý', 'cheesecaky_eshop', 'one_time')`],
        ['další kontakt', `INSERT INTO contact (account_id, full_name, email) VALUES (1, 'Petr', 'petr@acme-stroje.cz')`],
        ['jiný úkol', `INSERT INTO task (title, account_id) VALUES ('Něco', 1)`],
        ['dodávka', `INSERT INTO engagement (account_id) VALUES (1)`],
        ['další alias', `INSERT INTO company_alias (account_id, alias_domain) VALUES (1, 'acme.cz')`],
        ['partner u obchodu (tabulka bez id)', `INSERT INTO partner (name) VALUES ('P'); INSERT INTO deal_partner (deal_id, partner_id, program) VALUES (1, 1, 'dodavatel_napoju')`],
        ['obchod se pohnul', `UPDATE deal SET stage = 'diagnostika' WHERE id = 1`],
        ['u obchodu je částka', `UPDATE deal SET amount_one_time = 50000 WHERE id = 1`],
        ['úkol je hotový', `UPDATE task SET status = 'done' WHERE id = 1`],
        ['úkol je v kalendáři', `UPDATE task SET ms_event_id = 'AAMk' WHERE id = 1`],
        ['návrh od člověka', `INSERT INTO case_proposal (account_id, status, created_by) VALUES (1, 'accepted', 'user:x')`],
      ]
      for (const [label, sql] of others) {
        await seedOne()
        await db.exec(sql)
        await expect(undo(1), label).rejects.toThrow(/zpět to nejde/)
        expect(await count('account'), label).toBe(1)
        expect(await count('deal'), label).toBeGreaterThanOrEqual(1)
        expect((await q<Row>('SELECT status FROM auto_intake'))[0], label).toEqual({ status: 'active' })
      }
    })

    test('čekající systémový návrh smí odejít s klientem', async () => {
      await seedOne()
      await db.exec(`INSERT INTO case_proposal (account_id, status, created_by) VALUES (1, 'pending', 'system:mail_to_case')`)
      expect(await undo(1)).toMatchObject({ status: 'undone' })
      expect(await count('case_proposal')).toBe(0)
    })

    test('klient už smazaný ručně: Zpět jen označí a zapamatuje doménu', async () => {
      await seedOne()
      await db.exec('DELETE FROM account WHERE id = 1')
      const [before] = await q<Row>('SELECT account_id, status FROM auto_intake')
      expect(before).toEqual({ account_id: null, status: 'active' })
      expect(await undo(1)).toMatchObject({ status: 'undone', deleted: {} })
      expect(await found({ message_id: '<again@acme-stroje.cz>' })).toMatchObject({ status: 'rejected' })
    })

    test('bez AAL2, bez přihlášení, mimo tým a bez obchodní role nejde', async () => {
      await seedOne()
      await expect(undo(1, VIKTOR, 'aal1')).rejects.toThrow(/AAL2/)
      await expect(as(null, 'aal2', 'SELECT auto_intake_undo(1)')).rejects.toThrow(/Nepřihlášený/)
      await expect(undo(1, STRANGER)).rejects.toThrow(/člena týmu/)
      await expect(undo(1, LENKA)).rejects.toThrow(/obchodní role/)
      await expect(as(null, 'aal2', 'SELECT auto_intake_undo(1)').catch((e) => { throw e })).rejects.toThrow()
      expect(await count('account')).toBe(1)
    })
  })

  describe('RLS a práva tabulky', () => {
    test('vidí jen obchodní role s AAL2; klient nezapíše nic', async () => {
      await reset()
      await found()
      expect((await as(VIKTOR, 'aal2', 'SELECT id FROM auto_intake')).length).toBe(1)
      expect((await as(VIKTOR, 'aal1', 'SELECT id FROM auto_intake')).length).toBe(0)
      expect((await as(LENKA, 'aal2', 'SELECT id FROM auto_intake')).length).toBe(0)
      expect((await as(STRANGER, 'aal2', 'SELECT id FROM auto_intake')).length).toBe(0)
      await expect(as(VIKTOR, 'aal2', `INSERT INTO auto_intake (source_key, domain, occurred_at, created_day) VALUES ('x', 'x.cz', now(), current_date)`)).rejects.toThrow(/permission denied/)
      await expect(as(VIKTOR, 'aal2', `UPDATE auto_intake SET status = 'undone'`)).rejects.toThrow(/permission denied/)
      await expect(as(VIKTOR, 'aal2', 'DELETE FROM auto_intake')).rejects.toThrow(/permission denied/)
    })

    test('CHECKy: vrácený řádek nesmí držet vazby, doména bez @ a malými písmeny', async () => {
      await reset()
      await expect(db.exec(`INSERT INTO auto_intake (source_key, domain, occurred_at, created_day, status) VALUES ('k1', 'A@b.cz', now(), current_date, 'active')`)).rejects.toThrow()
      await expect(db.exec(`INSERT INTO auto_intake (source_key, domain, occurred_at, created_day, status) VALUES ('k2', 'Firma.cz', now(), current_date, 'active')`)).rejects.toThrow()
      await expect(db.exec(`INSERT INTO auto_intake (source_key, domain, occurred_at, created_day, status) VALUES ('k3', 'firma.cz', now(), current_date, 'undone')`)).rejects.toThrow()
      await db.exec(`INSERT INTO auto_intake (source_key, domain, occurred_at, created_day) VALUES ('k4', 'firma.cz', now(), current_date)`)
      await expect(db.exec(`INSERT INTO auto_intake (source_key, domain, occurred_at, created_day) VALUES ('k4', 'jina.cz', now(), current_date)`)).rejects.toThrow(/unique|duplicate/i)
    })
  })
})
