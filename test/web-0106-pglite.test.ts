// Migrace 0106 (balík P6, veřejný web) proti CELÉMU řetězu migrací (PGlite,
// bez sítě): záznam souhlasu a doplňky objednávky v RPC webu, změna stavu
// objednávky z Cockpitu (shop_order_set_status: člen týmu, AAL2, povolené
// přechody, souběh) a retence (výmaz spamu, anonymizace starých záznamů).
// Payloady skládá stejný kód jako route handlery (domain/web/*).
import { readdirSync, readFileSync } from 'node:fs'
import { beforeAll, describe, expect, test } from 'vitest'
import { webInquiryPayload } from '@/core/webInquiry'
import { checkFormInquiry, toAgentInquiry, webInquiryRpcPayload } from '@/domain/web/inquiry'
import { checkFormOrder, orderRpcPayload, toShopOrder } from '@/domain/web/order'
import { SHOP_ORDER_STATUSES, SHOP_ORDER_TRANSITIONS, canTransition } from '@/domain/web/shopOrders'
import type { CheesecakeOrder, WebInquiry } from '@/lib/web/api'

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

const TODAY = '2026-11-05'

const form = (patch: Partial<WebInquiry> = {}): WebInquiry => ({
  eventType: 'coffee-break', customerKind: 'firma', segment: 'b2b', company: { name: 'Firma Alfa s.r.o.', ico: '12345678' },
  eventDate: '2026-12-10', timeFrom: null, timeTo: null, venue: { address: 'Praha 2', needsVenue: false, venueSlug: null },
  guests: 40, serviceFormat: null, budgetPerPerson: null, diets: [], dietNote: null, serviceLevel: null, drinks: [], extras: [],
  note: null, contact: { name: 'Karel Ukázkový', email: 'karel@alfa.example', phone: null }, consent: true,
  source: { channel: 'formular', page: '/poptavka', ref: null },
  ...patch,
})

function inquiryPayload(f: WebInquiry): Record<string, unknown> {
  const c = checkFormInquiry(f, TODAY)
  if (!c.ok) throw new Error('form')
  const m = toAgentInquiry(c.form, crypto.randomUUID())
  if (!m.ok) throw new Error('map')
  return webInquiryRpcPayload(m.mapped, webInquiryPayload(m.mapped.inquiry))
}

const cart = (patch: Partial<CheesecakeOrder> = {}): CheesecakeOrder => ({
  items: [{ slug: 'daddy-vanilkovy', quantity: 1, inscription: 'Pro Janu' }, { slug: 'mini-cheesecaky-10-ks', quantity: 1, miniFlavors: Array(10).fill('jahoda') }],
  fulfillment: { method: 'praha', address: 'Ulice 1, Praha', date: '2026-11-20', note: null },
  customer: { name: 'Jana Nováková', email: 'jana@email.example', phone: '+420 600 000 001' },
  company: { name: 'Firma Beta s.r.o.', ico: '87654321', dic: 'CZ87654321' }, payment: 'prevod', note: 'Zazvonit dvakrát', consent: true,
  ...patch,
})

function orderPayload(o: CheesecakeOrder): Record<string, unknown> {
  const c = checkFormOrder(o, TODAY)
  if (!c.ok) throw new Error('form')
  const m = toShopOrder(c.form, crypto.randomUUID(), TODAY)
  if (!m.ok) throw new Error('map')
  return orderRpcPayload(m.mapped, c.form)
}

describe.skipIf(!PGliteCtor)('0106: web — souhlas, objednávka, změna stavu, retence (PGlite)', () => {
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

  const submitOrder = async (p: Record<string, unknown>) =>
    (await svc<{ r: { shop_order_id: number } }>(`SELECT shop_order_submit($1::jsonb) AS r`, [JSON.stringify(p)]))[0].r.shop_order_id
  const setStatus = (who: { role: 'authenticated'; sub: string; aal?: string }, id: number, status: string, expected: string | null = null) =>
    asAal(who, `SELECT shop_order_set_status($1, $2, $3) AS r`, [id, status, expected])

  async function asAal<T = Row>(who: { role: 'authenticated'; sub: string; aal?: string }, sql: string, params: unknown[] = []): Promise<T[]> {
    await db.query('BEGIN')
    try {
      await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify({ role: who.role, aal: who.aal ?? 'aal2', sub: who.sub })])
      await db.query(`SET LOCAL ROLE ${who.role}`)
      const res = await db.query<T>(sql, params)
      await db.query('COMMIT')
      return res.rows
    } catch (e) {
      await db.query('ROLLBACK').catch(() => undefined)
      throw e
    }
  }

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
  }, 300_000)

  test('0106 je v ledgeru s vlastní poznámkou (ne zástupce)', async () => {
    const r = await one<{ note: string }>(`SELECT note FROM schema_migration WHERE version = '0106'`)
    expect(r?.note).toMatch(/shop_order_set_status/)
  })

  test('poptávka z webu nese verzi souhlasu a doplňky webu bez kontaktu', async () => {
    const r = (await svc<{ r: { web_inquiry_id: number } }>(`SELECT web_inquiry_submit($1::jsonb) AS r`, [JSON.stringify(inquiryPayload(form()))]))[0].r
    const row = await one<Row>(`SELECT consent_version, marketing_consent, marketing_consent_text, inquiry -> 'web_details' ->> 'customer_kind' AS kind, status FROM web_inquiry WHERE id = $1`, [r.web_inquiry_id])
    expect(row).toEqual({ consent_version: 'web-2026-11', marketing_consent: false, marketing_consent_text: null, kind: 'firma', status: 'new' })
  })

  test('marketingový text se uloží jen se souhlasem', async () => {
    const p = { ...inquiryPayload(form()), marketing_consent: false, marketing_consent_text: 'Chci novinky' }
    const id = (await svc<{ r: { web_inquiry_id: number } }>(`SELECT web_inquiry_submit($1::jsonb) AS r`, [JSON.stringify(p)]))[0].r.web_inquiry_id
    expect((await one<Row>(`SELECT marketing_consent_text FROM web_inquiry WHERE id = $1`, [id]))?.marketing_consent_text).toBeNull()
    const p2 = { ...inquiryPayload(form()), marketing_consent: true, marketing_consent_text: 'Chci novinky' }
    const id2 = (await svc<{ r: { web_inquiry_id: number } }>(`SELECT web_inquiry_submit($1::jsonb) AS r`, [JSON.stringify(p2)]))[0].r.web_inquiry_id
    expect((await one<Row>(`SELECT marketing_consent_text FROM web_inquiry WHERE id = $1`, [id2]))?.marketing_consent_text).toBe('Chci novinky')
  })

  test('objednávka: pásmo, platba, firma, nápis a mini příchutě v položkách', async () => {
    const id = await submitOrder(orderPayload(cart()))
    const row = await one<Row>(`SELECT fulfilment, delivery_zone, delivery_czk, total_czk, payment_method, company_name, ico, dic, source_page, consent_version,
      dedication, items -> 0 ->> 'inscription' AS inscription, jsonb_array_length(items -> 1 -> 'mini_flavors') AS minis FROM shop_order WHERE id = $1`, [id])
    expect(row).toEqual({
      fulfilment: 'delivery', delivery_zone: 'praha', delivery_czk: 300, total_czk: 790 + 575 + 300, payment_method: 'prevod',
      company_name: 'Firma Beta s.r.o.', ico: '87654321', dic: 'CZ87654321', source_page: '/kosik', consent_version: 'web-2026-11',
      dedication: 'Pro Janu', inscription: 'Pro Janu', minis: 10,
    })
  })

  test('změna stavu: člen týmu s AAL2, povolené přechody, kdo a kdy', async () => {
    const id = await submitOrder(orderPayload(cart({ fulfillment: { method: 'vyzvednuti', address: null, date: '2026-11-21', note: null } })))
    const r = (await setStatus({ role: 'authenticated', sub: PM }, id, 'confirmed', 'new'))[0] as { r: Record<string, unknown> }
    expect(r.r).toEqual({ shop_order_id: id, status: 'confirmed', previous_status: 'new', changed: true })
    const row = await one<Row>(`SELECT status, status_changed_by, status_changed_at IS NOT NULL AS at FROM shop_order WHERE id = $1`, [id])
    expect(row).toEqual({ status: 'confirmed', status_changed_by: PM, at: true })
    // Stejný stav = bez změny.
    expect(((await setStatus({ role: 'authenticated', sub: PM }, id, 'confirmed'))[0] as { r: { changed: boolean } }).r.changed).toBe(false)
    // Souběh: očekávaný stav nesedí.
    await expect(setStatus({ role: 'authenticated', sub: SALES }, id, 'ready', 'new')).rejects.toThrow(/SO013/)
    // Nepovolený přechod a konečný stav.
    await expect(setStatus({ role: 'authenticated', sub: PM }, id, 'handed_over')).rejects.toThrow(/SO014/)
    await setStatus({ role: 'authenticated', sub: PM }, id, 'ready')
    await setStatus({ role: 'authenticated', sub: PM }, id, 'handed_over')
    await expect(setStatus({ role: 'authenticated', sub: PM }, id, 'new')).rejects.toThrow(/SO014/)
    // Bez AAL2 a cizí uživatel.
    await expect(setStatus({ role: 'authenticated', sub: PM, aal: 'aal1' }, id, 'cancelled')).rejects.toThrow(/SO011|aal|permission/)
    await expect(setStatus({ role: 'authenticated', sub: 'c9999999-9999-4999-8999-999999999999' }, id, 'cancelled')).rejects.toThrow(/SO010/)
    await expect(setStatus({ role: 'authenticated', sub: PM }, 999_999, 'confirmed')).rejects.toThrow(/SO012/)
    // Anon funkci nevolá vůbec.
    await expect(as({ role: 'anon' }, `SELECT shop_order_set_status($1, 'confirmed')`, [id])).rejects.toThrow(/permission denied/)
  })

  test('přechody v Cockpitu (domain/web/shopOrders.ts) sedí s SQL funkcí', async () => {
    for (const from of SHOP_ORDER_STATUSES) {
      for (const to of SHOP_ORDER_STATUSES) {
        if (from === to) continue
        await db.query(`UPDATE shop_order SET status = $1 WHERE id = (SELECT min(id) FROM shop_order)`, [from])
        const id = (await one<{ id: number }>(`SELECT min(id)::int AS id FROM shop_order`))!.id
        let ok = true
        try { await setStatus({ role: 'authenticated', sub: PM }, id, to, from) } catch { ok = false }
        expect(ok, `${from} → ${to}`).toBe(canTransition(from, to))
      }
    }
    expect(SHOP_ORDER_TRANSITIONS.handed_over).toEqual([])
  })

  test('retence: spam po 30 dnech pryč, vyřízené poptávky po 12 měsících a předané objednávky po 24 měsících bez osobních údajů', async () => {
    const spam = (await svc<{ r: { web_inquiry_id: number } }>(`SELECT web_inquiry_submit($1::jsonb) AS r`, [JSON.stringify(inquiryPayload(form({ contact: { name: 'Spam Robot', email: 'spam@robot.example', phone: null } })))]))[0].r.web_inquiry_id
    const old = (await svc<{ r: { web_inquiry_id: number } }>(`SELECT web_inquiry_submit($1::jsonb) AS r`, [JSON.stringify(inquiryPayload(form({ contact: { name: 'Stará Poptávka', email: 'stara@alfa.example', phone: '+420 600 000 009' } })))]))[0].r.web_inquiry_id
    const fresh = (await svc<{ r: { web_inquiry_id: number } }>(`SELECT web_inquiry_submit($1::jsonb) AS r`, [JSON.stringify(inquiryPayload(form({ contact: { name: 'Nová Poptávka', email: 'nova@alfa.example', phone: null } })))]))[0].r.web_inquiry_id
    await db.query(`UPDATE web_inquiry SET status = 'spam', received_at = now() - interval '40 days' WHERE id = $1`, [spam])
    await db.query(`UPDATE web_inquiry SET status = 'decided', received_at = now() - interval '13 months' WHERE id = $1`, [old])
    await db.query(`UPDATE web_inquiry SET status = 'decided' WHERE id = $1`, [fresh])
    const oid = await submitOrder(orderPayload(cart({ customer: { name: 'Stará Objednávka', email: 'stara@email.example', phone: '+420 600 000 002' } })))
    await db.query(`UPDATE shop_order SET status = 'handed_over', fulfilment_date = (now() - interval '25 months')::date WHERE id = $1`, [oid])

    await expect(as({ role: 'authenticated', sub: SALES }, `SELECT web_intake_retention()`)).rejects.toThrow(/permission denied/)
    const res = (await svc<{ r: Record<string, number> }>(`SELECT web_intake_retention() AS r`))[0].r
    expect(res.spam_deleted).toBeGreaterThanOrEqual(1)
    expect(res.inquiries_anonymized).toBeGreaterThanOrEqual(1)
    expect(res.orders_anonymized).toBeGreaterThanOrEqual(1)

    expect(await one(`SELECT id FROM web_inquiry WHERE id = $1`, [spam])).toBeUndefined()
    const a = await one<Row>(`SELECT customer_name, email, phone, company_name, status, guests, anonymized_at IS NOT NULL AS anon FROM web_inquiry WHERE id = $1`, [old])
    expect(a).toEqual({ customer_name: 'Anonymizováno', email: 'anonymizovano@invalid', phone: null, company_name: null, status: 'decided', guests: 40, anon: true })
    expect((await one<Row>(`SELECT customer_name FROM web_inquiry WHERE id = $1`, [fresh]))?.customer_name).toBe('Nová Poptávka')
    const o = await one<Row>(`SELECT customer_name, email, phone, delivery_address, dedication, note, company_name, dic, total_czk, items::text AS items FROM shop_order WHERE id = $1`, [oid])
    expect(o).toMatchObject({ customer_name: 'Anonymizováno', email: 'anonymizovano@invalid', phone: 'smazáno', delivery_address: 'smazáno', dedication: null, note: null, company_name: null, dic: null, total_czk: 1665 })
    expect(String(o?.items)).not.toContain('Pro Janu')
    expect(String(o?.items)).not.toContain('mini_flavors')
    // Druhý běh nic nového neudělá.
    const again = (await svc<{ r: Record<string, number> }>(`SELECT web_intake_retention() AS r`))[0].r
    expect(again).toEqual({ spam_deleted: 0, inquiries_anonymized: 0, orders_anonymized: 0 })
  })

  test('audit objednávek a poptávek nenese osobní údaje ani nové textové sloupce', async () => {
    const rows = (await db.query<{ payload: unknown }>(`SELECT to_jsonb(a) AS payload FROM audit_event a WHERE entity_table IN ('web_inquiry', 'shop_order')`)).rows
    expect(rows.length).toBeGreaterThan(0)
    const text = JSON.stringify(rows)
    for (const s of ['karel@alfa.example', 'Karel Ukázkový', 'Jana Nováková', 'jana@email.example', 'Firma Beta', 'CZ87654321', 'Pro Janu', 'Zazvonit', 'Chci novinky', 'Ulice 1']) expect(text).not.toContain(s)
  })
})
