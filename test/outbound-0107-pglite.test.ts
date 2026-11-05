// Outbound agent (P7, migrace 0107) proti CELÉMU řetězu migrací v PGlite
// (bez sítě): signály idempotentně, lead do CRM se zdrojem agenta,
// odhlášení přes otisk e-mailu, rozhodnutí CSO, RLS a audit bez textu.
import { readdirSync, readFileSync } from 'node:fs'
import { beforeAll, describe, expect, test } from 'vitest'
import { emailHash } from '@/core/outbound/unsubscribe'
import { signalUpsertPayload } from '@/core/outbound/signal'
import { outreachEnqueuePayload } from '@/core/outbound/outbox'

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

describe.skipIf(!PGliteCtor)('0107 outbound agent (PGlite, celý řetěz)', () => {
  let db: Db

  async function as<T = Row>(who: { role: 'authenticated' | 'service_role' | 'anon'; sub?: string; aal?: string }, sql: string, params: unknown[] = []): Promise<T[]> {
    await db.query('BEGIN')
    try {
      await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [
        JSON.stringify({ role: who.role, aal: who.aal ?? 'aal2', ...(who.sub ? { sub: who.sub } : {}) }),
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
  const upsert = async (p: Record<string, unknown>) =>
    (await svc<{ r: { signal_id: number; duplicate: boolean } }>(`SELECT outbound_signal_upsert($1::jsonb) AS r`, [JSON.stringify(p)]))[0].r
  const review = (sub: string, p: Record<string, unknown>, aal = 'aal2') =>
    as<{ r: Record<string, unknown> }>({ role: 'authenticated', sub, aal }, `SELECT outbound_review($1::jsonb) AS r`, [JSON.stringify(p)])

  const tender = (ref: string) => signalUpsertPayload({
    source: 'vvz', kind: 'public_tender', externalRef: ref,
    title: 'Zajištění cateringu pro konferenci', url: 'https://vvz.example/zakazka/1', signalDate: '2026-11-20',
    company: { ico: '00064581', name: 'Úřad Ukázka' },
    facts: [{ key: 'akce', value: 'konference', sourceUrl: 'https://vvz.example/zakazka/1' }],
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
    await db.exec(readFileSync('supabase/seed.sql', 'utf8'))
  }, 300_000)

  test('0107 je v ledgeru', async () => {
    expect(await one(`SELECT version FROM schema_migration WHERE version = '0107'`)).toEqual({ version: '0107' })
  })

  test('signál: zápis a idempotence podle zdroje a klíče', async () => {
    const a = await upsert(tender('vvz-1'))
    expect(a.duplicate).toBe(false)
    expect(await upsert(tender('vvz-1'))).toEqual({ signal_id: a.signal_id, duplicate: true })
    const r = await one(`SELECT status, source, kind, ico, jsonb_array_length(facts) AS n FROM outbound_signal WHERE id = $1`, [a.signal_id])
    expect(r).toEqual({ status: 'new', source: 'vvz', kind: 'public_tender', ico: '00064581', n: 1 })
  })

  test('lead: nová firma podle IČO, obchod v poptávce se zdrojem agenta, idempotentní', async () => {
    const { signal_id } = await upsert(tender('vvz-2'))
    const r = (await svc<{ r: Row }>(`SELECT outbound_lead_create($1::jsonb) AS r`, [JSON.stringify({ signal_id })]))[0].r
    expect(r.created_account).toBe(true)
    const d = await one(`SELECT source, phase, pillar, stage::text AS stage FROM deal WHERE id = $1`, [r.deal_id])
    expect(d).toEqual({ source: 'agent:outbound:vvz', phase: 'poptavka', pillar: 'b2b_akce', stage: 'kvalifikace' })
    const again = (await svc<{ r: Row }>(`SELECT outbound_lead_create($1::jsonb) AS r`, [JSON.stringify({ signal_id })]))[0].r
    expect(again).toMatchObject({ deal_id: r.deal_id, duplicate: true })
    // Druhý signál stejné firmy se připojí ke stejnému klientovi.
    const s3 = await upsert(tender('vvz-3'))
    const r3 = (await svc<{ r: Row }>(`SELECT outbound_lead_create($1::jsonb) AS r`, [JSON.stringify({ signal_id: s3.signal_id })]))[0].r
    expect(r3).toMatchObject({ account_id: r.account_id, created_account: false })
    expect(await one(`SELECT status FROM outbound_signal WHERE id = $1`, [signal_id])).toEqual({ status: 'converted' })
  })

  test('RPC úlohy smí jen service_role; klient tabulky nezapisuje a bez obchodní role nečte', async () => {
    const p = JSON.stringify(tender('vvz-x'))
    await expect(as({ role: 'anon' }, `SELECT outbound_signal_upsert($1::jsonb)`, [p])).rejects.toThrow(/permission denied/)
    await expect(as({ role: 'authenticated', sub: SALES }, `SELECT outbound_signal_upsert($1::jsonb)`, [p])).rejects.toThrow(/permission denied/)
    await expect(as({ role: 'authenticated', sub: SALES }, `SELECT outbound_unsubscribe('{}'::jsonb)`)).rejects.toThrow(/permission denied/)
    await expect(as({ role: 'authenticated', sub: SALES }, `UPDATE outbound_signal SET status = 'converted'`)).rejects.toThrow(/permission denied/)
    expect((await as<{ n: number }>({ role: 'authenticated', sub: SALES }, `SELECT count(*)::int AS n FROM outbound_signal`))[0].n).toBeGreaterThan(0)
    expect((await as<{ n: number }>({ role: 'authenticated', sub: PM }, `SELECT count(*)::int AS n FROM outbound_signal`))[0].n).toBe(0)
    expect((await as<{ n: number }>({ role: 'authenticated', sub: SALES, aal: 'aal1' }, `SELECT count(*)::int AS n FROM outbound_signal`))[0].n).toBe(0)
  })

  test('CSO: zamítnutí a znovuotevření signálu; projektant ani AAL1 nesmí', async () => {
    const { signal_id } = await upsert(tender('vvz-4'))
    await expect(review(PM, { target: 'signal', id: signal_id, action: 'dismiss' })).rejects.toThrow(/OR401/)
    await expect(review(SALES, { target: 'signal', id: signal_id, action: 'dismiss' }, 'aal1')).rejects.toThrow(/OR401/)
    expect((await review(SALES, { target: 'signal', id: signal_id, action: 'dismiss' }))[0].r).toEqual({ ok: true, status: 'dismissed' })
    expect((await review(SALES, { target: 'signal', id: signal_id, action: 'reopen' }))[0].r).toEqual({ ok: true, status: 'review' })
    const lead = (await review(SALES, { target: 'signal', id: signal_id, action: 'create_lead' }))[0].r
    expect(lead.deal_id).toBeTruthy()
    expect(await one(`SELECT decided_by FROM outbound_signal WHERE id = $1`, [signal_id])).toEqual({ decided_by: SALES })
  })

  test('oslovení bez právního titulu nesmí být e-mail (CHECK) a nejde schválit', async () => {
    await expect(db.query(`INSERT INTO outbound_outreach (account_id, channel, basis) VALUES (1, 'auto_email', 'none')`)).rejects.toThrow(/basis_channel/)
    const { id } = (await db.query<{ id: number }>(`INSERT INTO outbound_outreach (account_id, channel, basis, subject, body) VALUES (1, 'manual', 'none', 'Návrh', 'Zavolat') RETURNING id`)).rows[0]
    expect((await review(SALES, { target: 'outreach', id, action: 'approve' }))[0].r).toEqual({ ok: false, status: 'draft' })
    expect((await review(SALES, { target: 'outreach', id, action: 'done' }))[0].r).toEqual({ ok: true, status: 'done' })
  })

  test('odhlášení: otisk v suppression, kontakt nesouhlasí, koncepty přeskočené, souhlas odvolaný', async () => {
    const hash = emailHash('Karel@Alfa.example ')
    expect(await one(`SELECT outbound_email_hash('karel@alfa.example') AS h`)).toEqual({ h: hash })
    const contact = await one<{ id: number }>(`SELECT id FROM contact WHERE email = 'karel@alfa.example'`)
    await db.query(`INSERT INTO outreach_consent (contact_id, email_hash, wording, wording_version, granted_at, source)
                    VALUES ($1, $2, 'Souhlasím se zasíláním nabídek firemních akcí.', 'v1', now(), 'event')`, [contact!.id, hash])
    const { id } = (await db.query<{ id: number }>(
      `INSERT INTO outbound_outreach (account_id, contact_id, channel, basis, email_hash, subject, body) VALUES (1, $1, 'review_email', 'existing_customer', $2, 'Vánoce', 'Text') RETURNING id`,
      [contact!.id, hash])).rows[0]
    const r = (await svc<{ r: Row }>(`SELECT outbound_unsubscribe($1::jsonb) AS r`, [JSON.stringify({ email_hash: hash, outreach_id: id })]))[0].r
    expect(r).toEqual({ suppressed: true, contacts: 1 })
    expect(await one(`SELECT do_not_contact FROM contact WHERE id = $1`, [contact!.id])).toEqual({ do_not_contact: true })
    expect(await one(`SELECT status FROM outbound_outreach WHERE id = $1`, [id])).toEqual({ status: 'skipped' })
    expect(await one(`SELECT withdrawn_at IS NOT NULL AS w FROM outreach_consent WHERE email_hash = $1`, [hash])).toEqual({ w: true })
    // Opakované odhlášení nic nerozbije.
    expect((await svc<{ r: Row }>(`SELECT outbound_unsubscribe($1::jsonb) AS r`, [JSON.stringify({ email_hash: hash })]))[0].r).toEqual({ suppressed: true, contacts: 0 })
    await expect(svc(`SELECT outbound_unsubscribe('{"email_hash":"x"}'::jsonb)`)).rejects.toThrow(/OU000/)
  })

  test('fronta 0104 přijme oslovení: hlavičky odhlášení, schválení člověkem, po odeslání stav sent', async () => {
    const { signal_id } = await upsert(tender('vvz-outbox'))
    const lead = (await svc<{ r: Row }>(`SELECT outbound_lead_create($1::jsonb) AS r`, [JSON.stringify({ signal_id })]))[0].r
    const dealId = Number(lead.deal_id)
    const mk = async (status: string, decidedBy: string | null) => (await db.query<{ id: number }>(
      `INSERT INTO outbound_outreach (account_id, deal_id, channel, status, basis, subject, body, decided_by, decided_at)
       VALUES ($1, $2, 'review_email', $3, 'existing_customer', 'Rok od akce', 'Text', $4, CASE WHEN $4::uuid IS NULL THEN NULL ELSE now() END) RETURNING id`,
      [lead.account_id, dealId, status, decidedBy])).rows[0].id
    const payload = (id: number) => outreachEnqueuePayload({
      outreachId: id, dealId, mailboxMemberId: SALES, to: 'nakup@firma.example', subject: 'Rok od akce', text: 'Text\n--\nOdhlášení: https://x.example/o?t=1',
      listUnsubscribeUrl: 'https://x.example/o?t=1',
    })
    const enqueue = (p: Record<string, unknown>) => svc<{ r: { outbox_id: number; duplicate: boolean } }>(`SELECT agent_outbox_enqueue($1::jsonb) AS r`, [JSON.stringify(p)])

    // Neschválené (koncept) oslovení se do fronty nedostane.
    const draft = await mk('draft', null)
    await expect(enqueue(payload(draft))).rejects.toThrow(/OB010/)
    // Bez hlaviček odhlášení ne; hlavičky u jiného druhu taky ne.
    const ok = await mk('approved', SALES)
    await expect(enqueue({ ...payload(ok), headers: undefined })).rejects.toThrow(/AO004/)
    await expect(enqueue({ ...payload(ok), kind: 'follow_up', source_ref: `followup:${dealId}:9` })).rejects.toThrow(/AO004/)

    const { outbox_id: id } = (await enqueue(payload(ok)))[0].r
    const row = await one<Row>(`SELECT kind, mode, headers, approved_at IS NOT NULL AS approved, approved_by FROM agent_outbox WHERE id = $1`, [id])
    expect(row).toEqual({
      kind: 'outreach', mode: 'to', approved: true, approved_by: `user:${SALES}`,
      headers: { 'List-Unsubscribe': '<https://x.example/o?t=1>', 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' },
    })
    expect((await enqueue(payload(ok)))[0].r).toEqual({ outbox_id: id, duplicate: true })

    // Claim (schváleno člověkem) → confirm → oslovení 'sent'.
    const c = (await svc<{ r: Row }>(`SELECT agent_outbox_claim($1, $2, $3, false, 15, ARRAY['outreach']::text[], 1) AS r`,
      [id, 'nakup@firma.example', `<ao.${id}.x@mummiesdaddies.com>`]))[0].r
    expect(c).toMatchObject({ ok: true })
    await svc(`SELECT agent_outbox_confirm($1, 'gm1', 'th1', NULL)`, [id])
    expect(await one(`SELECT status, outbox_id, outbox_source_ref FROM outbound_outreach WHERE id = $1`, [ok]))
      .toEqual({ status: 'sent', outbox_id: id, outbox_source_ref: `outreach:${ok}` })
  })

  test('audit nenese název, text, e-mail ani otisk', async () => {
    const rows = (await db.query<{ payload: unknown }>(
      `SELECT to_jsonb(a) AS payload FROM audit_event a WHERE entity_table IN ('outbound_signal', 'outbound_outreach', 'outreach_consent', 'outreach_suppression')`)).rows
    expect(rows.length).toBeGreaterThan(0)
    const text = JSON.stringify(rows)
    for (const s of ['Zajištění cateringu', 'Úřad Ukázka', '00064581', 'karel@alfa.example', emailHash('karel@alfa.example'), 'Souhlasím']) {
      expect(text).not.toContain(s)
    }
  })
})
