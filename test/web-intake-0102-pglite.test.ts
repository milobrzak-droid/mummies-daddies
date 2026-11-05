// Základ systému proti CELÉMU řetězu migrací (PGlite, bez sítě): hodnoty
// firmy přímo v migracích (uzly, pilíře, týmy, linky, šablony realizace),
// ukázková data supabase/seed.sql a vstup webu z 0102 (web_inquiry_submit,
// shop_order_submit). Stub Supabase stejný jako bulk-import-fullchain.
import { readdirSync, readFileSync } from 'node:fs'
import { beforeAll, describe, expect, test } from 'vitest'
import { COMPANY } from '@/config'
import { webInquiryPayload, webInquirySchema } from '@/core/webInquiry'
import { priceShopOrder, shopOrderPayload, shopOrderSchema } from '@/core/cheesecakeOrder'

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

const inquiry = (over: Partial<Record<string, unknown>> = {}) => webInquirySchema.parse({
  clientToken: crypto.randomUUID(),
  segment: 'b2b', eventType: 'coffee_break', eventDate: '2027-03-10', guests: 40, venue: 'Praha 2',
  specialRequests: null,
  customer: { name: 'Karel Ukázkový', email: 'karel@alfa.example', phone: null, companyName: 'Firma Alfa s.r.o.', ico: null },
  consent: { processing: true },
  sourcePage: '/catering',
  ...over,
})

describe.skipIf(!PGliteCtor)('základ: migrace firmy, seed a vstup webu 0102 (PGlite)', () => {
  let db: Db
  const skipped: string[] = []

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
  const submit = async (payload: Record<string, unknown>) =>
    (await svc<{ r: { web_inquiry_id: number; duplicate: boolean } }>(`SELECT web_inquiry_submit($1::jsonb) AS r`, [JSON.stringify(payload)]))[0].r

  beforeAll(async () => {
    db = new PGliteCtor!()
    await db.exec(STUB)
    for (const f of readdirSync('supabase/migrations').filter((x) => x.endsWith('.sql')).sort()) {
      if (NEEDS_VAULT.has(f)) { skipped.push(f); continue }
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

  test('celý řetěz včetně rezervovaných zástupců 0103–0106 je v ledgeru', async () => {
    expect(skipped).toEqual([...NEEDS_VAULT])
    const versions = (await db.query<{ version: string }>(`SELECT version FROM schema_migration WHERE version >= '0102' ORDER BY version`)).rows.map((r) => r.version)
    expect(versions).toEqual(['0102', '0103', '0104', '0105', '0106'])
  })

  test('uzly firmy bez vlastníka, žádný seedovaný admin ani cílový seznam', async () => {
    const nodes = (await db.query<{ node: string; owner_id: string | null }>(`SELECT node, owner_id FROM loop_node ORDER BY node`)).rows
    expect(nodes.map((n) => n.node)).toEqual([...COMPANY.nodes].sort())
    expect(nodes.every((n) => n.owner_id === null)).toBe(true)
    expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM team_member WHERE is_admin`))!.n).toBe(0)
    expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM target_list`))!.n).toBe(0)
  })

  test('ukázková data: pilíře, linky a fáze firmy projdou CHECK i enumem', async () => {
    const deals = (await db.query<{ pillar: string; revenue_line: string }>(`SELECT pillar, revenue_line::text FROM deal`)).rows
    expect(deals.length).toBe(6)
    for (const d of deals) {
      expect(COMPANY.pillars.map((p) => p.key)).toContain(d.pillar)
      expect(COMPANY.revenueLines.map((l) => l.key)).toContain(d.revenue_line)
    }
    const enumValues = (await db.query<{ v: string }>(`SELECT unnest(enum_range(NULL::revenue_line))::text AS v`)).rows.map((r) => r.v)
    expect(enumValues).toEqual(COMPANY.revenueLines.map((l) => l.key))
  })

  test('potvrzená akce založí realizaci s milníky firmy', async () => {
    const e = await one<{ titles: string[] }>(`
      SELECT array_agg(m.title ORDER BY m.id) AS titles
        FROM engagement e JOIN engagement_milestone m ON m.engagement_id = e.id
       WHERE e.deal_id = (SELECT id FROM deal WHERE title = 'Coffee break na konferenci')`)
    expect(e?.titles).toEqual([...COMPANY.autoDelivery.milestoneTemplates.implementace])
  })

  test('approval_action_settings míří na uzel obchodu', async () => {
    const s = await one<{ s: { send_offer: { node: string } } }>(`SELECT approval_action_settings() AS s`)
    expect(s?.s.send_offer.node).toBe(COMPANY.approvalActions.sendOffer.node)
  })

  test('web_inquiry_submit: zápis, idempotence podle client_token, limit na adresu', async () => {
    const w = inquiry()
    const first = await submit(webInquiryPayload(w))
    expect(first.duplicate).toBe(false)
    expect(await submit(webInquiryPayload(w))).toEqual({ web_inquiry_id: first.web_inquiry_id, duplicate: true })
    const r = await one<Row>(`SELECT status, segment, event_type, guests, email, inquiry ->> 'venue' AS venue FROM web_inquiry WHERE id = $1`, [first.web_inquiry_id])
    expect(r).toEqual({ status: 'new', segment: 'b2b', event_type: 'coffee_break', guests: 40, email: 'karel@alfa.example', venue: 'Praha 2' })
    for (let i = 0; i < 4; i++) await submit(webInquiryPayload(inquiry()))
    await expect(submit(webInquiryPayload(inquiry()))).rejects.toThrow(/WI001/)
  })

  test('RPC webu smí jen service_role; klient z tabulek nečte ani nepíše bez obchodní role', async () => {
    const p = JSON.stringify(webInquiryPayload(inquiry({ customer: { name: 'X', email: 'x@y.example', phone: null, companyName: null, ico: null } })))
    await expect(as({ role: 'anon' }, `SELECT web_inquiry_submit($1::jsonb)`, [p])).rejects.toThrow(/permission denied/)
    await expect(as({ role: 'authenticated', sub: SALES }, `SELECT web_inquiry_submit($1::jsonb)`, [p])).rejects.toThrow(/permission denied/)
    expect((await as<{ n: number }>({ role: 'authenticated', sub: SALES }, `SELECT count(*)::int AS n FROM web_inquiry`))[0].n).toBeGreaterThan(0)
    expect((await as<{ n: number }>({ role: 'authenticated', sub: PM }, `SELECT count(*)::int AS n FROM web_inquiry`))[0].n).toBe(0)
    expect((await as<{ n: number }>({ role: 'authenticated', sub: PM }, `SELECT count(*)::int AS n FROM shop_order`))[0].n).toBeGreaterThan(0)
    await expect(as({ role: 'authenticated', sub: SALES }, `UPDATE shop_order SET status = 'cancelled'`)).rejects.toThrow(/permission denied/)
  })

  test('shop_order_submit: cena z ceníku firmy, idempotence', async () => {
    const o = shopOrderSchema.parse({
      clientToken: crypto.randomUUID(),
      items: [{ productKey: 'daddy_vanilka', quantity: 2 }],
      fulfilmentDate: '2026-12-01', fulfilment: 'pickup',
      customer: { name: 'Jan Novák', email: 'jan.novak@email.example', phone: '+420 600 000 001' },
      consent: { processing: true },
    })
    const pricing = priceShopOrder(COMPANY.shop, o, '2026-11-20')
    if (!pricing.ok) throw new Error(pricing.problems.join(','))
    const p = JSON.stringify(shopOrderPayload(o, pricing))
    const first = (await svc<{ r: { shop_order_id: number; duplicate: boolean } }>(`SELECT shop_order_submit($1::jsonb) AS r`, [p]))[0].r
    expect(first.duplicate).toBe(false)
    expect((await svc<{ r: { duplicate: boolean } }>(`SELECT shop_order_submit($1::jsonb) AS r`, [p]))[0].r.duplicate).toBe(true)
    expect(await one(`SELECT total_czk, status FROM shop_order WHERE id = $1`, [first.shop_order_id])).toEqual({ total_czk: 1580, status: 'new' })
  })

  test('audit poptávky nenese jméno, e-mail ani text poptávky', async () => {
    const rows = (await db.query<{ payload: unknown }>(`SELECT to_jsonb(a) AS payload FROM audit_event a WHERE entity_table IN ('web_inquiry', 'shop_order')`)).rows
    expect(rows.length).toBeGreaterThan(0)
    const text = JSON.stringify(rows)
    for (const s of ['karel@alfa.example', 'Karel Ukázkový', 'Praha 2', 'jan.novak@email.example', 'Jan Novák']) expect(text).not.toContain(s)
  })
})
