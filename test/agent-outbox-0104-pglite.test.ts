// Odchozí fronta agenta (0104) proti CELÉMU řetězu migrací (PGlite, bez sítě):
// idempotentní zařazení, claim jen jednou, denní limit a limit na příjemce,
// potvrzení (verze nabídky → odesláno, fáze → nabidka), strážce SV006,
// schválení člověkem vrací zprávu do fronty, zastaralá rezervace, retence.
import { readdirSync, readFileSync } from 'node:fs'
import { beforeAll, describe, expect, test } from 'vitest'
import { outboxEnqueuePayload, type OutboxEnqueue } from '@/core/agents/outboxPort'

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

describe.skipIf(!PGliteCtor)('odchozí fronta agenta 0104 (PGlite)', () => {
  let db: Db
  let seq = 1000

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
  const user = (sub: string) => ({ role: 'authenticated' as const, sub })

  const enqueue = async (x: OutboxEnqueue) =>
    (await svc<{ r: { outbox_id: number; duplicate: boolean } }>(`SELECT agent_outbox_enqueue($1::jsonb) AS r`, [JSON.stringify(outboxEnqueuePayload(x))]))[0].r
  const claim = async (id: number, recipient: string, opts: { autonomous?: boolean; daily?: number; perRecipient?: number; kinds?: string[] } = {}) =>
    (await svc<{ r: { ok: boolean; reason?: string } }>(
      `SELECT agent_outbox_claim($1, $2, $3, $4, $5, $6::text[], $7) AS r`,
      [id, recipient, `<ao-${id}-${seq++}@cockpit.test>`, opts.autonomous ?? true, opts.daily ?? 20, opts.kinds ?? null, opts.perRecipient ?? 2],
    ))[0].r
  const confirm = async (id: number, msgId = `m${id}x${seq++}`) =>
    (await svc<{ r: { ok: boolean; duplicate: boolean } }>(`SELECT agent_outbox_confirm($1, $2, $3, $4) AS r`, [id, msgId, 'thr1', null]))[0].r
  const finish = async (id: number, status: string, reason: string, task: string | null = null) =>
    (await svc<{ r: { ok: boolean; reason?: string; task_id?: number } }>(`SELECT agent_outbox_finish($1, $2, $3, NULL, $4, NULL) AS r`, [id, status, reason, task]))[0].r
  const row = (id: number) => one<Row>(`SELECT * FROM agent_outbox WHERE id = $1`, [id])

  async function newDeal(phase = 'poptavka'): Promise<number> {
    const r = await one<{ id: number }>(
      `INSERT INTO deal (account_id, title, revenue_line, revenue_category, stage, probability_pct, pillar, phase, owner_id)
       VALUES (1, 'Testovací akce ' || $1::text, 'catering_firemni', 'one_time', 'kvalifikace', 10, 'b2b_akce', $2, $3) RETURNING id`,
      [seq++, phase, SALES],
    )
    return r!.id
  }
  async function newDraft(dealId: number, amount = 30000): Promise<number> {
    const r = await svc<{ id: number }>(
      `INSERT INTO deal_scope_version (deal_id, version, scope, amount_one_time, status, created_by)
       VALUES ($1, coalesce((SELECT max(version) FROM deal_scope_version WHERE deal_id = $1), 0) + 1, 'Nabídka z mapy', $2, 'draft', NULL) RETURNING id`,
      [dealId, amount],
    )
    return r[0].id
  }
  const setPolicy = async (kind: string, level: string) => {
    await db.query(`UPDATE authority_policy SET active = false WHERE action_kind = $1 AND active`, [kind])
    await db.query(`INSERT INTO authority_policy (action_kind, level, active, note, updated_by) VALUES ($1, $2, true, 'test', 'test')`, [kind, level])
  }
  const offer = (dealId: number, versionId: number, over: Partial<OutboxEnqueue> = {}): OutboxEnqueue => ({
    kind: 'offer', sourceRef: `inquiry:${seq++}`, dealId, scopeVersionId: versionId, mailboxMemberId: SALES,
    mode: { reply: `msg${seq++}` }, subject: 'Re: Poptávka', text: 'Dobrý den, posíláme nabídku.', priceMapVersion: 'v1', ...over,
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
    await db.query(`UPDATE loop_node SET owner_id = $1 WHERE node = 'obchod'`, [SALES])
    await db.exec(readFileSync('supabase/seed.sql', 'utf8'))
  }, 300_000)

  test('ledger, RLS a výchozí pravidla pravomoci L2', async () => {
    expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM schema_migration WHERE version = '0104'`))!.n).toBe(1)
    const pol = (await db.query<{ action_kind: string; level: string }>(
      `SELECT action_kind, level FROM authority_policy WHERE active AND action_kind LIKE 'send_%' AND action_kind <> 'send_offer' ORDER BY action_kind`,
    )).rows
    expect(pol).toEqual([
      { action_kind: 'send_follow_up', level: 'L2' },
      { action_kind: 'send_info_request', level: 'L2' },
      { action_kind: 'send_standard_offer', level: 'L2' },
    ])
    const rls = await one<{ rls: boolean }>(`SELECT relrowsecurity AS rls FROM pg_class WHERE relname = 'agent_outbox'`)
    expect(rls!.rls).toBe(true)
  })

  test('zařazení je idempotentní podle source_ref; klient nevolá ani nečte bez obchodní role', async () => {
    const deal = await newDeal()
    const item: OutboxEnqueue = { kind: 'info_request', sourceRef: `web:${seq++}`, dealId: deal, mailboxMemberId: SALES, mode: { to: 'Karel@Alfa.example' }, subject: 'Doplnění poptávky', text: 'Dobrý den, doplňte prosím počet hostů.' }
    const a = await enqueue(item)
    const b = await enqueue(item)
    expect(a.duplicate).toBe(false)
    expect(b).toEqual({ outbox_id: a.outbox_id, duplicate: true })
    expect((await row(a.outbox_id))).toMatchObject({ status: 'queued', mode: 'to', to_email: 'karel@alfa.example' })

    await expect(as(user(SALES), `SELECT agent_outbox_enqueue($1::jsonb)`, [JSON.stringify(outboxEnqueuePayload({ ...item, sourceRef: 'web:1' }))])).rejects.toThrow(/permission denied/)
    await expect(as({ role: 'anon' }, `SELECT agent_outbox_claim(1, 'a@b.cz', '<a@b>', true, 1, NULL, 1)`)).rejects.toThrow(/permission denied/)
    expect((await as(user(SALES), `SELECT id FROM agent_outbox WHERE id = $1`, [a.outbox_id])).length).toBe(1)
    expect((await as(user(PM), `SELECT id FROM agent_outbox WHERE id = $1`, [a.outbox_id])).length).toBe(0)
    expect((await as({ ...user(SALES), aal: 'aal1' }, `SELECT id FROM agent_outbox WHERE id = $1`, [a.outbox_id])).length).toBe(0)
    await expect(as(user(SALES), `UPDATE agent_outbox SET status = 'sent' WHERE id = $1`, [a.outbox_id])).rejects.toThrow(/permission denied/)
  })

  test('neplatné vstupy zařazení skončí srozumitelnou chybou', async () => {
    const deal = await newDeal()
    const v = await newDraft(deal)
    await expect(enqueue(offer(deal, v, { sourceRef: 'jinde:1' }))).rejects.toThrow(/AO001/)
    await expect(enqueue(offer(deal, v, { scopeVersionId: null }))).rejects.toThrow(/AO003/)
    await expect(enqueue(offer(deal, v, { mailboxMemberId: '00000000-0000-4000-8000-000000000000' }))).rejects.toThrow(/AO002/)
    await expect(enqueue(offer(deal, v, { mode: { to: 'neni-adresa' } }))).rejects.toThrow(/AO001/)
    const other = await newDeal()
    await expect(enqueue(offer(other, v))).rejects.toThrow(/AO003/)
  })

  test('samostatný claim bez L4 neprojde (druhá pojistka v SQL); s L4 proběhne jen jednou', async () => {
    const deal = await newDeal()
    const v = await newDraft(deal)
    const { outbox_id: id } = await enqueue(offer(deal, v))
    expect(await claim(id, 'karel@alfa.example')).toEqual({ ok: false, reason: 'not_authorized' })
    expect(await claim(id, 'karel@alfa.example', { autonomous: false })).toEqual({ ok: false, reason: 'not_approved' })
    await setPolicy('send_standard_offer', 'L4')
    try {
      expect((await claim(id, 'karel@alfa.example')).ok).toBe(true)
      expect(await claim(id, 'karel@alfa.example')).toEqual({ ok: false, reason: 'not_queued' })
      const r = await row(id)
      expect(r).toMatchObject({ status: 'claimed', autonomous: true, attempts: 1, recipient: 'karel@alfa.example' })
      expect(r!.prague_day).not.toBeNull()

      // Potvrzení: verze → odesláno (SV006 pustí jen tuto cestu), fáze → nabidka, aktivita, audit.
      expect(await confirm(id, 'gm1abc')).toEqual({ ok: true, duplicate: false })
      expect(await confirm(id, 'gm1abc')).toEqual({ ok: true, duplicate: true })
      await expect(confirm(id, 'jine')).rejects.toThrow(/AO012/)
      expect(await one(`SELECT status FROM deal_scope_version WHERE id = $1`, [v])).toEqual({ status: 'sent' })
      expect(await one(`SELECT phase FROM deal WHERE id = $1`, [deal])).toEqual({ phase: 'nabidka' })
      const act = await one<{ source: string; subject: string }>(`SELECT source, subject FROM sales_activity WHERE external_id = $1`, [`outbox:${id}`])
      expect(act!.source).toBe('agent:outbox')
      const ev = await one<{ action: string; after: Row }>(`SELECT action, after FROM audit_event WHERE entity_table = 'agent_outbox' AND entity_id = $1 AND action LIKE '%sent' ORDER BY id DESC LIMIT 1`, [String(id)])
      expect(ev!.action).toBe('offer.auto_sent')
      expect(JSON.stringify(ev!.after)).not.toMatch(/Dobrý den|karel@/)
      // Tvrdý audit řádku nenese text ani adresu.
      const rowAudit = (await db.query<{ after: unknown }>(`SELECT after FROM audit_event WHERE entity_table = 'agent_outbox' AND entity_id = $1`, [String(id)])).rows
      expect(JSON.stringify(rowAudit)).not.toMatch(/Dobrý den|karel@|Poptávka/)
    } finally {
      await setPolicy('send_standard_offer', 'L2')
    }
  })

  test('strážce SV006: koncept → odesláno mimo frontu ani INSERT rovnou „sent" bez autora neprojde', async () => {
    const deal = await newDeal()
    const v = await newDraft(deal)
    await expect(svc(`UPDATE deal_scope_version SET status = 'sent' WHERE id = $1`, [v])).rejects.toThrow(/bez schválené žádosti/)
    // Příznak bez řádku fronty 'sent' nepomůže.
    await db.query('BEGIN')
    try {
      await db.query(`SELECT set_config('app.agent_send', $1, true)`, [String(v)])
      await expect(db.query(`UPDATE deal_scope_version SET status = 'sent' WHERE id = $1`, [v])).rejects.toThrow(/bez schválené žádosti/)
    } finally {
      await db.query('ROLLBACK')
    }
    await expect(svc(
      `INSERT INTO deal_scope_version (deal_id, version, scope, amount_one_time, status, created_by) VALUES ($1, 99, 'x', 1, 'sent', NULL)`, [deal],
    )).rejects.toThrow(/bez autora/)
    // Import člověkem (autor vyplněný) zůstává povolený.
    await svc(`INSERT INTO deal_scope_version (deal_id, version, scope, amount_one_time, status, created_by) VALUES ($1, 98, 'x', 1, 'sent', $2)`, [deal, SALES])
  })

  test('nabídka bez pravomoci → žádost send_offer; schválení vrátí zprávu do fronty a odešle se bez úkolu „pošli sám"', async () => {
    const deal = await newDeal()
    const v = await newDraft(deal)
    const { outbox_id: id } = await enqueue(offer(deal, v))
    const req = (await svc<{ r: { ok: boolean; approval_request_id: number } }>(`SELECT agent_outbox_request_offer_approval($1) AS r`, [id]))[0].r
    expect(req.ok).toBe(true)
    expect(await row(id)).toMatchObject({ status: 'blocked', stop_reason: 'approval_required' })
    // Opakované volání nezaloží druhou žádost.
    const again = (await svc<{ r: { approval_request_id: number } }>(`SELECT agent_outbox_request_offer_approval($1) AS r`, [id]))[0].r
    expect(again.approval_request_id).toBe(req.approval_request_id)

    const tasksBefore = (await one<{ n: number }>(`SELECT count(*)::int AS n FROM task WHERE deal_id = $1`, [deal]))!.n
    expect((await as<{ s: string }>(user(SALES), `SELECT decide_approval($1, true, NULL) AS s`, [req.approval_request_id]))[0].s).toBe('approved')
    expect(await row(id)).toMatchObject({ status: 'queued', approval_request_id: req.approval_request_id })
    expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM task WHERE deal_id = $1`, [deal]))!.n).toBe(tasksBefore)

    // Odeslání po schválení: claim bez autonomie projde, potvrzení verzi označí odeslanou.
    expect((await claim(id, 'karel@alfa.example', { autonomous: false })).ok).toBe(true)
    await confirm(id)
    expect(await one(`SELECT status FROM deal_scope_version WHERE id = $1`, [v])).toEqual({ status: 'sent' })
    const ev = await one<{ action: string }>(`SELECT action FROM audit_event WHERE entity_table = 'agent_outbox' AND entity_id = $1 AND action LIKE '%sent' ORDER BY id DESC LIMIT 1`, [String(id)])
    expect(ev!.action).toBe('offer.approved_sent')
  })

  test('cesta 0084 bez fronty beze změny: schválení založí úkol „Odeslat nabídku klientovi"', async () => {
    const deal = await newDeal()
    const v = await newDraft(deal)
    const [{ id: reqId }] = await as<{ id: number }>(user(SALES), `SELECT request_action_approval('send_offer', $1, '{}'::jsonb, NULL) AS id`, [v])
    // Vlastní žádost schválit nejde (v provozu schvaluje jiný člen uzlu).
    await expect(as(user(SALES), `SELECT decide_approval($1, true, NULL)`, [reqId])).rejects.toThrow(/Vlastní požadavek/)
    await db.query(`UPDATE approval_request SET requested_by = 'system:test' WHERE id = $1`, [reqId])
    await as(user(SALES), `SELECT decide_approval($1, true, NULL)`, [reqId])
    const t = await one<{ title: string }>(`SELECT title FROM task WHERE deal_id = $1 ORDER BY id DESC LIMIT 1`, [deal])
    expect(t!.title).toMatch(/Odeslat nabídku klientovi/)
    expect(await one(`SELECT status FROM deal_scope_version WHERE id = $1`, [v])).toEqual({ status: 'draft' })
  })

  test('denní limit a limit na příjemce; vrácená rezervace (throttled) uvolní místo', async () => {
    await setPolicy('send_info_request', 'L4')
    try {
      const deal = await newDeal()
      const mk = async (to: string) => (await enqueue({ kind: 'info_request', sourceRef: `web:${seq++}`, dealId: deal, mailboxMemberId: SALES, mode: { to }, subject: 'Doplnění', text: 'Text' })).outbox_id
      const ids = [await mk('a@limit.example'), await mk('b@limit.example'), await mk('c@limit.example')]
      const today = (await one<{ n: number }>(`SELECT count(*)::int AS n FROM agent_outbox WHERE prague_day = agent_outbox_today() AND kind = 'info_request' AND status IN ('claimed','sent','needs_attention')`))!.n
      const daily = today + 2
      expect((await claim(ids[0], 'a@limit.example', { daily })).ok).toBe(true)
      expect((await claim(ids[1], 'b@limit.example', { daily })).ok).toBe(true)
      expect(await claim(ids[2], 'c@limit.example', { daily })).toEqual({ ok: false, reason: 'daily_limit' })
      expect((await row(ids[2]))!.status).toBe('queued')
      // Gmail zprávu prokazatelně nepřijal (429) → zpět do fronty, den uvolněn.
      expect((await finish(ids[1], 'queued', 'throttled')).ok).toBe(true)
      expect(await row(ids[1])).toMatchObject({ status: 'queued', prague_day: null, rfc_message_id: null })
      expect((await claim(ids[2], 'c@limit.example', { daily })).ok).toBe(true)

      const r1 = await mk('d@limit.example')
      const r2 = await mk('d@limit.example')
      expect((await claim(r1, 'D@limit.example', { daily: 1000, perRecipient: 1 })).ok).toBe(true)
      expect(await claim(r2, 'd@limit.example', { daily: 1000, perRecipient: 1 })).toEqual({ ok: false, reason: 'recipient_limit' })
    } finally {
      await setPolicy('send_info_request', 'L2')
    }
  })

  test('selhání → failed + úkol; povolené přechody; uvolnění člověkem', async () => {
    await setPolicy('send_follow_up', 'L4')
    try {
      const deal = await newDeal('nabidka')
      const { outbox_id: id } = await enqueue({ kind: 'follow_up', sourceRef: `followup:${deal}:1`, dealId: deal, mailboxMemberId: SALES, mode: { to: 'e@fail.example' }, subject: 'Připomínka', text: 'Text' })
      expect(await finish(id, 'failed', 'forbidden')).toEqual({ ok: false, reason: 'transition_not_allowed', status: 'queued' })
      expect((await claim(id, 'e@fail.example', { daily: 1000 })).ok).toBe(true)
      const f = await finish(id, 'failed', 'forbidden', 'Odeslání selhalo')
      expect(f.ok).toBe(true)
      expect(f.task_id).toBeGreaterThan(0)
      const task = await one<{ assignee_id: string; deal_id: number }>(`SELECT assignee_id, deal_id FROM task WHERE id = $1`, [f.task_id])
      expect(task).toEqual({ assignee_id: SALES, deal_id: deal })
      expect((await one<{ action: string }>(`SELECT action FROM audit_event WHERE entity_table = 'agent_outbox' AND entity_id = $1 AND action LIKE 'follow_up.%' ORDER BY id DESC LIMIT 1`, [String(id)]))!.action).toBe('follow_up.send_failed')

      await expect(as(user(PM), `SELECT agent_outbox_release($1)`, [id])).rejects.toThrow(/obchodní role/)
      expect((await as<{ s: string }>(user(SALES), `SELECT agent_outbox_release($1) AS s`, [id]))[0].s).toBe('queued')
      expect((await row(id))!.approved_by).toBe(`user:${SALES}`)
    } finally {
      await setPolicy('send_follow_up', 'L2')
    }
  })

  test('zastaralá rezervace → needs_attention + úkol; fronta ji sama znovu nepošle, potvrdit ji jde', async () => {
    await setPolicy('send_info_request', 'L4')
    try {
      const deal = await newDeal()
      const { outbox_id: id } = await enqueue({ kind: 'info_request', sourceRef: `web:${seq++}`, dealId: deal, mailboxMemberId: SALES, mode: { to: 'f@stale.example' }, subject: 'Doplnění', text: 'Text' })
      expect((await claim(id, 'f@stale.example', { daily: 1000, perRecipient: 100 })).ok).toBe(true)
      await db.query(`UPDATE agent_outbox SET claimed_at = now() - interval '2 hours' WHERE id = $1`, [id])
      const stale = (await svc<{ r: number[] }>(`SELECT agent_outbox_mark_stale(30) AS r`))[0].r
      expect(stale).toContain(id)
      expect(await row(id)).toMatchObject({ status: 'needs_attention', stop_reason: 'stale_claim' })
      expect((await row(id))!.task_id).not.toBeNull()
      expect(await claim(id, 'f@stale.example')).toEqual({ ok: false, reason: 'not_queued' })
      // Úloha zprávu dohledala v Odeslané poště podle Message-ID → potvrzení.
      expect((await confirm(id)).ok).toBe(true)
      expect((await row(id))!.status).toBe('sent')
      // Uvolnit nejistou zprávu jde jen s potvrzením, že neodešla.
      const { outbox_id: id2 } = await enqueue({ kind: 'info_request', sourceRef: `web:${seq++}`, dealId: deal, mailboxMemberId: SALES, mode: { to: 'g@stale.example' }, subject: 'Doplnění', text: 'Text' })
      await claim(id2, 'g@stale.example', { daily: 1000, perRecipient: 100 })
      await finish(id2, 'needs_attention', 'uncertain')
      await expect(as(user(SALES), `SELECT agent_outbox_release($1)`, [id2])).rejects.toThrow(/Odeslané poště/)
      expect((await as<{ s: string }>(user(SALES), `SELECT agent_outbox_release($1, true) AS s`, [id2]))[0].s).toBe('queued')
    } finally {
      await setPolicy('send_info_request', 'L2')
    }
  })

  test('retence a výmaz podle adresy smažou text i adresu, řádek zůstane', async () => {
    const deal = await newDeal()
    const { outbox_id: id } = await enqueue({ kind: 'info_request', sourceRef: `web:${seq++}`, dealId: deal, mailboxMemberId: SALES, mode: { to: 'gdpr@erase.example' }, subject: 'Doplnění', text: 'Osobní text' })
    expect((await svc<{ n: number }>(`SELECT agent_outbox_erase_address('GDPR@erase.example') AS n`))[0].n).toBeGreaterThanOrEqual(1)
    expect(await row(id)).toMatchObject({ status: 'blocked', stop_reason: 'gdpr_erased', subject: null, body: null, to_email: null })
    await expect(svc(`SELECT agent_outbox_purge_text(5)`)).rejects.toThrow(/AO030/)
    await db.query(`UPDATE agent_outbox SET updated_at = now() - interval '400 days' WHERE status = 'sent'`)
    await svc(`SELECT agent_outbox_purge_text(365)`)
    expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM agent_outbox WHERE status = 'sent' AND body IS NOT NULL AND coalesce(sent_at, updated_at) < now() - interval '365 days'`))!.n).toBe(0)
  })
})
