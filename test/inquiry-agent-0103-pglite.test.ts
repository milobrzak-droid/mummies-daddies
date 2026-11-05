// Migrace 0103 (agent příchozích poptávek) proti CELÉMU řetězu migrací
// (PGlite, bez sítě): fronta inquiry_agent_run, CRM zápis inquiry_agent_found
// pro B2B, B2C, existující firmu a opakovanou poptávku, převzetí webových
// poptávek a audit bez textu. Stub Supabase stejný jako web-intake-0102.
import { readdirSync, readFileSync } from 'node:fs'
import { beforeAll, describe, expect, test } from 'vitest'
import { webInquiryPayload, webInquirySchema } from '@/core/webInquiry'
import { inquiryFoundPayload, leadCompany, leadLine, parseFoundResult, type AgentVerdict } from '@/domain/crm/inquiryAgent'
import { COMPANY } from '@/config'

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

const SALES = 'b1111111-1111-4111-8111-111111111111'
const PM = 'b3333333-3333-4333-8333-333333333333'
const NEEDS_VAULT = new Set(['0031_encrypt_calendar_tokens.sql', '0032_drop_calendar_token_plaintext.sql'])

const STUB = `
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid PRIMARY KEY, email text, raw_user_meta_data jsonb, raw_app_meta_data jsonb DEFAULT '{}', banned_until timestamptz, invited_at timestamptz);
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('request.jwt.claim.sub', true), ''),
                  (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub'))::uuid $$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT coalesce(nullif(current_setting('request.jwt.claim', true), ''),
                  nullif(current_setting('request.jwt.claims', true), ''))::jsonb $$;
CREATE FUNCTION auth.role() RETURNS text LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role' $$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE SCHEMA storage;
CREATE TABLE storage.buckets (id text PRIMARY KEY, name text, public boolean DEFAULT false, file_size_limit bigint, allowed_mime_types text[]);
CREATE TABLE storage.objects (id uuid DEFAULT gen_random_uuid() PRIMARY KEY, bucket_id text, name text, owner uuid, metadata jsonb, created_at timestamptz DEFAULT now());
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
CREATE FUNCTION storage.foldername(name text) RETURNS text[] LANGUAGE sql AS $$ SELECT string_to_array(name, '/') $$;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO authenticated, service_role, anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated, service_role, anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
`

const MSG_B2B = '<poptavka-1@alfa.example>'
const MSG_B2C = '<oslava-1@mail.example>'

describe.skipIf(!PGliteCtor)('0103: fronta agenta poptávek a zápis leadu (PGlite)', () => {
  let db: Db
  // Id řádků fronty (sekvence přeskočí id při ON CONFLICT, proto ne natvrdo).
  const run: Record<string, number> = {}

  async function as<T = Row>(who: { role: 'authenticated' | 'service_role' | 'anon'; sub?: string }, sql: string, params: unknown[] = []): Promise<T[]> {
    await db.query('BEGIN')
    try {
      await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ role: who.role, aal: 'aal2', ...(who.sub ? { sub: who.sub } : {}) }),
      ])
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
  const svc = <T = Row>(sql: string, params: unknown[] = []) => as<T>({ role: 'service_role' }, sql, params)
  const rpc = async <T = Row>(fn: string, p: unknown) => (await svc<{ r: T }>(`SELECT ${fn}($1::jsonb) AS r`, [JSON.stringify(p)]))[0].r
  const enqueue = (mid: string, gid: string) =>
    rpc<{ run_id: number; duplicate: boolean }>('inquiry_agent_enqueue', {
      internet_message_id: mid, graph_message_id: gid, thread_id: `t-${gid}`, mailbox: 'Obchod@Test.example',
      mailbox_member_id: SALES, received_at: '2026-11-05T08:00:00Z',
    })
  const found = (over: Record<string, unknown>) => rpc<Record<string, unknown>>('inquiry_agent_found', {
    source: 'email', source_key: MSG_B2B, run_id: run.b2b, occurred_at: '2026-11-05T08:00:00Z', owner_id: SALES, dedup_days: 14,
    email: 'Karel.Ukazkovy@alfa.example', person_name: 'Karel Ukázkový',
    company: { name: 'Firma Alfa s.r.o.', domain: 'alfa.example', ico: null },
    deal: {
      title: 'Poptávka — Firma Alfa s.r.o. — Coffee break', pillar: 'b2b_akce', revenue_line: 'catering_firemni',
      revenue_category: 'one_time', next_step: 'Zkontrolovat odeslání nabídky', next_step_due: '2026-11-06', note: null, amount: 14_000,
    },
    activity: { subject: 'Poptávka z e-mailu: Coffee break, 10. 3. 2027, 40 hostů' },
    task: null,
    scope: { amount: 14_000, text: 'Coffee break — 40 hostů (mapa ilustracni-2026-11)' },
    ...over,
  })

  beforeAll(async () => {
    db = new PGliteCtor!()
    await db.exec(STUB)
    for (const f of readdirSync('supabase/migrations').filter((x) => x.endsWith('.sql')).sort()) {
      if (NEEDS_VAULT.has(f)) continue
      try {
        await db.exec(readFileSync(`supabase/migrations/${f}`, 'utf8'))
      } catch (e) {
        await db.exec('ROLLBACK').catch(() => undefined)
        throw new Error(`${f}: ${(e as Error).message}`)
      }
    }
    for (const [id, email, role] of [[SALES, 'obchod@test.example', 'obchodnik'], [PM, 'pm@test.example', 'projektak']]) {
      await db.query(`INSERT INTO auth.users (id, email, raw_user_meta_data, invited_at) VALUES ($1, $2, '{}', now())`, [id, email])
      await db.query(`UPDATE team_member SET role = $2::team_role WHERE id = $1`, [id, role])
    }
  }, 300_000)

  test('zařazení do fronty je idempotentní podle Message-ID (stejná zpráva ve dvou schránkách)', async () => {
    const a = await enqueue(MSG_B2B, 'g1')
    expect(a.duplicate).toBe(false)
    run.b2b = a.run_id
    expect(await enqueue(MSG_B2B, 'g1-jina-schranka')).toEqual({ run_id: run.b2b, duplicate: true })
    run.b2c = (await enqueue(MSG_B2C, 'g2')).run_id
    const r = await one(`SELECT status, mailbox, attempts FROM inquiry_agent_run WHERE id = $1`, [run.b2b])
    expect(r).toEqual({ status: 'pending', mailbox: 'obchod@test.example', attempts: 0 })
  })

  test('převzetí: pending → processing, podruhé nic; spadlý běh se vrátí do fronty', async () => {
    const claimed = await svc<{ id: number; status: string; attempts: number }>(`SELECT id, status, attempts FROM inquiry_agent_claim(10)`)
    expect(claimed.map((c) => [c.id, c.status, c.attempts])).toEqual([[run.b2b, 'processing', 1], [run.b2c, 'processing', 1]])
    expect(await svc(`SELECT id FROM inquiry_agent_claim(10)`)).toEqual([])
    await db.query(`UPDATE inquiry_agent_run SET claimed_at = now() - interval '1 hour' WHERE id = $1`, [run.b2c])
    expect((await svc<{ id: number }>(`SELECT id FROM inquiry_agent_claim(10)`)).map((r) => r.id)).toEqual([run.b2c])
  })

  test('B2B: nová firma s aliasem domény, kontakt, obchod v poptávce, aktivita agenta a koncept nabídky', async () => {
    const r = await found({})
    expect(r.status).toBe('created')
    const deal = await one(`SELECT d.phase, d.stage::text AS stage, d.pillar, d.source, d.owner_id, d.amount_one_time::int AS amount,
        a.name AS account, (SELECT alias_domain FROM company_alias WHERE account_id = a.id) AS alias, c.email
      FROM deal d JOIN account a ON a.id = d.account_id JOIN contact c ON c.id = d.primary_contact_id WHERE d.id = $1`, [r.deal_id])
    expect(deal).toEqual({
      phase: 'poptavka', stage: 'kvalifikace', pillar: 'b2b_akce', source: 'email', owner_id: SALES, amount: 14000,
      account: 'Firma Alfa s.r.o.', alias: 'alfa.example', email: 'karel.ukazkovy@alfa.example',
    })
    expect(await one(`SELECT source, external_id, kind::text AS kind FROM sales_activity WHERE id = $1`, [r.activity_id]))
      .toEqual({ source: 'agent:inquiry', external_id: MSG_B2B, kind: 'email' })
    expect(await one(`SELECT status, version, amount_one_time::int AS amount, created_by FROM deal_scope_version WHERE id = $1`, [r.scope_version_id]))
      .toEqual({ status: 'draft', version: 1, amount: 14000, created_by: null })
    expect(await one(`SELECT account_id, contact_id, deal_id, scope_version_id FROM inquiry_agent_run WHERE id = $1`, [run.b2b]))
      .toEqual({ account_id: r.account_id, contact_id: r.contact_id, deal_id: r.deal_id, scope_version_id: r.scope_version_id })
  })

  test('druhé volání se stejným Message-ID nic nezdvojí', async () => {
    const before = await one<{ n: number }>(`SELECT (SELECT count(*) FROM deal) + (SELECT count(*) FROM contact) + (SELECT count(*) FROM account) AS n`)
    const r = await found({})
    expect(r.status).toBe('duplicate')
    expect(r.deal_id).toBeGreaterThan(0)
    expect(await one(`SELECT (SELECT count(*) FROM deal) + (SELECT count(*) FROM contact) + (SELECT count(*) FROM account) AS n`)).toEqual(before)
  })

  test('B2C z veřejné schránky: soukromá osoba bez aliasu domény, úkol k posouzení', async () => {
    const r = await found({
      source_key: MSG_B2C, run_id: run.b2c, email: 'jana.oslava@mail.example', person_name: 'Jana Nováková', company: null,
      deal: { title: 'Poptávka — Jana Nováková — Oslava', pillar: 'b2c_oslavy', revenue_line: 'oslava_soukroma', revenue_category: 'one_time',
        next_step: 'Posoudit poptávku', next_step_due: '2026-11-06' },
      task: { title: 'Posoudit poptávku — Jana Nováková', due_on: '2026-11-06', priority: 'high' },
      scope: null,
    })
    expect(r.status).toBe('created')
    expect(r.scope_version_id).toBeNull()
    const acc = await one(`SELECT a.name, (SELECT count(*)::int FROM company_alias WHERE account_id = a.id) AS aliases FROM account a WHERE a.id = $1`, [r.account_id])
    expect(acc).toEqual({ name: 'Jana Nováková', aliases: 0 })
    expect(await one(`SELECT assignee_id, priority::text AS priority, deal_id FROM task WHERE id = $1`, [r.task_id]))
      .toEqual({ assignee_id: SALES, priority: 'high', deal_id: r.deal_id })
  })

  test('nový kontakt z domény existující firmy: nový obchod u stávajícího klienta', async () => {
    const accountId = (await one<{ id: number }>(`SELECT account_id AS id FROM inquiry_agent_run WHERE id = $1`, [run.b2b]))!.id
    const { run_id } = await enqueue('<poptavka-2@alfa.example>', 'g3')
    const r = await found({ source_key: '<poptavka-2@alfa.example>', run_id, email: 'eva@alfa.example', person_name: 'Eva Kolegová' })
    expect(r.status).toBe('created')
    expect(r.account_id).toBe(accountId)
    expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM account WHERE name = 'Firma Alfa s.r.o.'`))!.n).toBe(1)
  })

  test('další poptávka stejného kontaktu v okně = připojí se k otevřenému obchodu (reused)', async () => {
    const first = await one<{ deal_id: number }>(`SELECT deal_id FROM inquiry_agent_run WHERE id = $1`, [run.b2b])
    const { run_id } = await enqueue('<poptavka-3@alfa.example>', 'g4')
    const deals = (await one<{ n: number }>(`SELECT count(*)::int AS n FROM deal`))!.n
    const r = await found({ source_key: '<poptavka-3@alfa.example>', run_id })
    expect(r).toMatchObject({ status: 'reused', deal_id: first!.deal_id, scope_version_id: null })
    expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM deal`))!.n).toBe(deals)
  })

  test('víc klientů se stejnou doménou = ambiguous, nic se nezapíše', async () => {
    await db.exec(`INSERT INTO account (name, web) VALUES ('Beta 1', 'https://beta.example'), ('Beta 2', 'www.beta.example/kontakt')`)
    run.beta = (await enqueue('<b@beta.example>', 'g5')).run_id
    const before = (await one<{ n: number }>(`SELECT count(*)::int AS n FROM contact`))!.n
    const r = await found({ source_key: '<b@beta.example>', run_id: run.beta, email: 'petr@beta.example', person_name: 'Petr Beta',
      company: { name: 'Beta a.s.', domain: 'beta.example', ico: null } })
    expect(r.status).toBe('ambiguous')
    expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM contact`))!.n).toBe(before)
  })

  test('dokončení: rozhodnutí, koncept odpovědi čeká na odchozí frontu a vrací se v claim', async () => {
    await rpc('inquiry_agent_finish', {
      run_id: run.b2b, status: 'decided', decision_kind: 'send_offer', reason_codes: [], segment: 'b2b', quote_total: 15680,
      price_map_version: 'ilustracni-2026-11', model_called: true,
      reply_draft: { kind: 'offer', subject: 'Re: Poptávka', text: 'Dobrý den, …' },
    })
    const r = await one(`SELECT status, decision_kind, quote_total::int AS total, model_calls, decided_at IS NOT NULL AS decided, reply_draft IS NOT NULL AS draft FROM inquiry_agent_run WHERE id = $1`, [run.b2b])
    expect(r).toEqual({ status: 'decided', decision_kind: 'send_offer', total: 15680, model_calls: 1, decided: true, draft: true })
    expect((await svc<{ id: number; status: string }>(`SELECT id, status FROM inquiry_agent_claim(10)`)).map((x) => [x.id, x.status])).toContainEqual([run.b2b, 'decided'])
    await rpc('inquiry_agent_finish', { run_id: run.b2b, status: 'enqueued', outbox_id: 77, reply_draft: null })
    expect(await one(`SELECT status, outbox_id::int AS outbox_id, reply_draft FROM inquiry_agent_run WHERE id = $1`, [run.b2b]))
      .toEqual({ status: 'enqueued', outbox_id: 77, reply_draft: null })
  })

  test('opakování: pending s odkladem se do odkladu nepřevezme', async () => {
    await rpc('inquiry_agent_finish', { run_id: run.beta, status: 'pending', error_code: 'model_unavailable', retry_after_seconds: 600 })
    expect((await svc<{ id: number }>(`SELECT id FROM inquiry_agent_claim(10)`)).map((r) => r.id)).not.toContain(run.beta)
  })

  test('web: převzetí nových poptávek a zápis rozhodnutí', async () => {
    const w = webInquirySchema.parse({
      clientToken: crypto.randomUUID(), segment: 'b2b', eventType: 'coffee_break', eventDate: '2027-03-10', guests: 40, venue: 'Praha 2',
      customer: { name: 'Karel Ukázkový', email: 'karel@gama.example', phone: null, companyName: 'Gama s.r.o.', ico: null },
      consent: { processing: true },
    })
    const { web_inquiry_id: id } = await rpc<{ web_inquiry_id: number }>('web_inquiry_submit', webInquiryPayload(w))
    const claimed = await svc<{ id: number; status: string; attempts: number }>(`SELECT id, status, attempts FROM web_inquiry_claim(10)`)
    expect(claimed).toEqual([{ id, status: 'processing', attempts: 1 }])
    const r = await found({
      source: 'web', source_key: `web:${id}`, run_id: null, web_inquiry_id: id, email: 'karel@gama.example', person_name: 'Karel Ukázkový',
      company: { name: 'Gama s.r.o.', domain: null, ico: null },
    })
    expect(r.status).toBe('created')
    expect(await one(`SELECT kind::text AS kind FROM sales_activity WHERE id = $1`, [r.activity_id])).toEqual({ kind: 'note' })
    await rpc('web_inquiry_finish', { web_inquiry_id: id, status: 'decided', decision_kind: 'ask_info', reason_codes: ['distanceKm'] })
    expect(await one(`SELECT status, decision_kind, reason_codes, deal_id = $2 AS linked FROM web_inquiry WHERE id = $1`, [id, r.deal_id]))
      .toEqual({ status: 'decided', decision_kind: 'ask_info', reason_codes: ['distanceKm'], linked: true })
    expect(await one(`SELECT source FROM deal WHERE id = $1`, [r.deal_id])).toEqual({ source: 'web' })
  })

  test('payload z domény (inquiryFoundPayload) projde SQL: eskalace B2C se svatbou → svatební hostina, úkol, bez konceptu', async () => {
    const { run_id } = await enqueue('<svatba-1@mail.example>', 'g9')
    const verdict: AgentVerdict = { kind: 'escalate', reasonCodes: ['special_request', 'sender_unverified'], missing: [], quote: null, reply: null }
    const line = leadLine(COMPANY.capabilities.inquiryAgent.leadMapping, 'b2c', 'svatba')
    const p = inquiryFoundPayload({
      source: 'email', sourceKey: '<svatba-1@mail.example>', runId: run_id, occurredAt: '2026-11-05T08:00:00Z', ownerId: SALES, dedupDays: 14,
      email: 'nevesta@mail.example', personName: 'Petra Nevěstová',
      company: leadCompany({ segment: 'b2c', email: 'nevesta@mail.example', companyName: null }),
      verdict, facts: { segment: 'b2c', eventType: 'svatba', eventTypeLabel: 'Svatební hostina', eventDate: '2027-06-12', guests: 80 },
      line: { ...line, revenueCategory: 'one_time' }, today: '2026-11-05',
    })
    const r = parseFoundResult(await rpc('inquiry_agent_found', p))
    expect(r?.status).toBe('created')
    const deal = await one(`SELECT revenue_line::text AS line, pillar, next_step_due::text AS due, title,
        (SELECT count(*)::int FROM task WHERE deal_id = d.id) AS tasks,
        (SELECT count(*)::int FROM deal_scope_version WHERE deal_id = d.id) AS scopes
      FROM deal d WHERE d.id = $1`, [r!.deal_id])
    expect(deal).toEqual({ line: 'svatebni_hostina', pillar: 'b2c_oslavy', due: '2026-11-06', title: 'Svatební hostina — Petra Nevěstová, 12. 6. 2027', tasks: 1, scopes: 0 })
  })

  test('RPC smí jen service_role; tým s obchodní rolí frontu čte, projektak ne', async () => {
    await expect(as({ role: 'authenticated', sub: SALES }, `SELECT inquiry_agent_claim(5)`)).rejects.toThrow(/permission denied/)
    await expect(as({ role: 'authenticated', sub: SALES }, `SELECT inquiry_agent_found('{}'::jsonb)`)).rejects.toThrow(/permission denied/)
    await expect(as({ role: 'anon' }, `SELECT inquiry_agent_enqueue('{}'::jsonb)`)).rejects.toThrow(/permission denied/)
    expect((await as<{ n: number }>({ role: 'authenticated', sub: SALES }, `SELECT count(*)::int AS n FROM inquiry_agent_run`))[0].n).toBeGreaterThan(0)
    expect((await as<{ n: number }>({ role: 'authenticated', sub: PM }, `SELECT count(*)::int AS n FROM inquiry_agent_run`))[0].n).toBe(0)
    await expect(as({ role: 'authenticated', sub: SALES }, `UPDATE inquiry_agent_run SET status = 'skipped'`)).rejects.toThrow(/permission denied/)
  })

  test('VIP příznak kontaktu existuje a je výchozí false', async () => {
    expect(await one(`SELECT bool_or(is_vip) AS any FROM contact`)).toEqual({ any: false })
  })

  test('retence: hotové řádky po lhůtě pryč, nevyřízený koncept odpovědi se zahodí', async () => {
    await db.query(`UPDATE inquiry_agent_run SET decided_at = now() - interval '200 days' WHERE id = $1`, [run.b2b])
    await db.query(`UPDATE inquiry_agent_run SET status = 'decided', reply_draft = '{"text":"x"}' WHERE id = $1`, [run.b2c])
    await db.exec(`ALTER TABLE inquiry_agent_run DISABLE TRIGGER inquiry_agent_run_set_updated_at`)
    await db.query(`UPDATE inquiry_agent_run SET updated_at = now() - interval '200 days' WHERE id = $1`, [run.b2c])
    await db.exec(`ALTER TABLE inquiry_agent_run ENABLE TRIGGER inquiry_agent_run_set_updated_at`)
    const n = (await svc<{ n: number }>(`SELECT inquiry_agent_purge(90) AS n`))[0].n
    expect(n).toBe(1)
    expect(await one(`SELECT reply_draft, error_code FROM inquiry_agent_run WHERE id = $1`, [run.b2c])).toEqual({ reply_draft: null, error_code: 'reply_expired' })
    expect(await one(`SELECT count(*)::int AS n FROM inquiry_agent_run WHERE id = $1`, [run.b2b])).toEqual({ n: 0 })
  })

  test('audit fronty nenese Message-ID, schránku, jméno ani e-mail', async () => {
    const rows = (await db.query<{ payload: unknown }>(`SELECT to_jsonb(a) AS payload FROM audit_event a WHERE entity_table = 'inquiry_agent_run'`)).rows
    expect(rows.length).toBeGreaterThan(0)
    const text = JSON.stringify(rows)
    for (const s of [MSG_B2B, MSG_B2C, 'obchod@test.example', 'Karel', 'alfa.example', 'Dobrý den', 'ilustracni']) expect(text).not.toContain(s)
  })
})
