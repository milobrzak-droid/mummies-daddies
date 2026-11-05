// 0089 (politiky úložiště) v opravdovém Postgresu (PGlite = PostgreSQL ve
// WASM, bez sítě a bez živé DB). Schéma storage je zjednodušený stub Supabase
// Storage (storage.buckets, storage.objects s RLS, vlastník jiná role než ta,
// která migraci pouští, jako v Supabase). Požadavek klienta se simuluje
// transakcí se set_config('request.jwt.claims') a SET LOCAL ROLE.
// PGlite je devDependency — import je statický, bez něj soubor selže.
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { beforeAll, describe, expect, test } from 'vitest'

const MIG = readFileSync('supabase/migrations/0089_storage_policies.sql', 'utf8')

const U_VEDENI = '11111111-1111-4111-8111-111111111111'
const U_OBCHOD = '22222222-2222-4222-8222-222222222222'
const U_PROJEKT = '33333333-3333-4333-8333-333333333333'
const U_PARTNER = '44444444-4444-4444-8444-444444444444'
const U_GONE = '55555555-5555-4555-8555-555555555555'

// Supabase: auth.uid()/auth.jwt() z request.jwt.claims, helpery z 0069/0082.
const BASE = `
CREATE ROLE anon NOLOGIN; CREATE ROLE authenticated NOLOGIN; CREATE ROLE service_role NOLOGIN BYPASSRLS;
CREATE SCHEMA auth;
CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')::uuid $$;
CREATE FUNCTION auth.jwt() RETURNS jsonb LANGUAGE sql STABLE AS $$
  SELECT nullif(current_setting('request.jwt.claims', true), '')::jsonb $$;
GRANT USAGE ON SCHEMA auth TO anon, authenticated, service_role;
CREATE TABLE schema_migration (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now(), note text);
CREATE TABLE team_member (id uuid PRIMARY KEY, role text NOT NULL, deactivated_at timestamptz);
INSERT INTO team_member VALUES
  ('${U_VEDENI}', 'vedeni', NULL), ('${U_OBCHOD}', 'obchodnik', NULL), ('${U_PROJEKT}', 'projektak', NULL),
  ('${U_PARTNER}', 'partner', NULL), ('${U_GONE}', 'obchodnik', now());
CREATE FUNCTION is_team_member() RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM team_member WHERE id = auth.uid() AND deactivated_at IS NULL
    AND role IN ('vedeni', 'obchodnik', 'projektak', 'lektor')) $$;
CREATE FUNCTION can_see_sales() RETURNS boolean LANGUAGE sql SECURITY DEFINER SET search_path = public, pg_temp STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM team_member WHERE id = auth.uid() AND role IN ('vedeni', 'obchodnik') AND deactivated_at IS NULL) $$;
GRANT EXECUTE ON FUNCTION is_team_member(), can_see_sales() TO anon, authenticated, service_role;
`

// Stub Supabase Storage. Vlastníkem je storage_admin (jako supabase_storage_admin).
const STORAGE = `
CREATE ROLE storage_admin NOLOGIN;
CREATE SCHEMA storage AUTHORIZATION storage_admin;
CREATE TABLE storage.buckets (id text PRIMARY KEY, name text NOT NULL, public boolean DEFAULT false);
CREATE TABLE storage.objects (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), bucket_id text REFERENCES storage.buckets(id),
  name text NOT NULL, owner uuid, metadata jsonb, created_at timestamptz DEFAULT now());
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
GRANT USAGE ON SCHEMA storage TO anon, authenticated, service_role;
GRANT ALL ON storage.objects, storage.buckets TO anon, authenticated, service_role;
INSERT INTO storage.buckets VALUES ('nabidky', 'nabidky', true), ('jiny', 'jiny', false);
INSERT INTO storage.objects (bucket_id, name) VALUES
  ('nabidky', 'offers/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.pdf'),
  ('nabidky', 'offers/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.navrh.json'),
  ('jiny', 'x.txt');
-- Hypotetický budoucí bucket s volnou permisivní politikou: ukáže, že
-- restriktivní storage_team_aal2 platí pro celé úložiště.
CREATE POLICY test_jiny_all ON storage.objects FOR ALL TO anon, authenticated
  USING (bucket_id = 'jiny') WITH CHECK (bucket_id = 'jiny');
ALTER TABLE storage.objects OWNER TO storage_admin;
ALTER TABLE storage.buckets OWNER TO storage_admin;
`

type Who = { sub?: string; aal?: 'aal1' | 'aal2'; role?: 'authenticated' | 'anon' | 'service_role' }

describe('0089 politiky úložiště v Postgresu (PGlite)', () => {
  let db: PGlite
  const notices: string[] = []

  async function inTx<T>(who: Who, fn: () => Promise<T>): Promise<T> {
    const role = who.role ?? 'authenticated'
    const claims = { role, ...(who.sub ? { sub: who.sub } : {}), ...(who.aal ? { aal: who.aal } : {}) }
    await db.query('BEGIN')
    try {
      await db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)])
      await db.query(`SET LOCAL ROLE ${role}`)
      return await fn()
    } finally {
      await db.query('ROLLBACK')
    }
  }
  const visible = (who: Who, bucket: string) =>
    inTx(who, async () => (await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM storage.objects WHERE bucket_id = $1`, [bucket])).rows[0].n)
  const write = (who: Who, sql: string) => inTx(who, () => db.query(sql))
  const upload = (bucket: string, name: string) => `INSERT INTO storage.objects (bucket_id, name) VALUES ('${bucket}', '${name}')`

  const sales: Who[] = [{ sub: U_VEDENI, aal: 'aal2' }, { sub: U_OBCHOD, aal: 'aal2' }]
  const denied: [string, Who][] = [
    ['projektak (bez obchodní role)', { sub: U_PROJEKT, aal: 'aal2' }],
    ['partner', { sub: U_PARTNER, aal: 'aal2' }],
    ['deaktivovaný obchodník', { sub: U_GONE, aal: 'aal2' }],
    ['obchodník bez 2FA (aal1)', { sub: U_OBCHOD, aal: 'aal1' }],
    ['anon', { role: 'anon' }],
  ]

  beforeAll(async () => {
    db = new PGlite()
    await db.exec(BASE)
    await db.exec(STORAGE)
    await db.exec(MIG, { onNotice: (n: { message?: string }) => notices.push(n.message ?? '') })
    await db.exec(MIG) // idempotence
  }, 60_000)

  test('idempotence: politiky jednou, ledger jednou, bucket nabidky přepnut na privátní', async () => {
    const pol = (await db.query<{ policyname: string; permissive: string; cmd: string }>(
      `SELECT policyname, permissive, cmd FROM pg_policies WHERE schemaname = 'storage' AND tablename = 'objects' ORDER BY policyname`,
    )).rows
    expect(pol).toEqual([
      { policyname: 'nabidky_no_client_delete', permissive: 'RESTRICTIVE', cmd: 'DELETE' },
      { policyname: 'nabidky_no_client_insert', permissive: 'RESTRICTIVE', cmd: 'INSERT' },
      { policyname: 'nabidky_no_client_update', permissive: 'RESTRICTIVE', cmd: 'UPDATE' },
      { policyname: 'nabidky_sales_read', permissive: 'PERMISSIVE', cmd: 'SELECT' },
      { policyname: 'storage_team_aal2', permissive: 'RESTRICTIVE', cmd: 'ALL' },
      { policyname: 'test_jiny_all', permissive: 'PERMISSIVE', cmd: 'ALL' },
    ])
    expect((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM schema_migration WHERE version = '0089'`)).rows[0].n).toBe(1)
    expect((await db.query<{ public: boolean }>(`SELECT public FROM storage.buckets WHERE id = 'nabidky'`)).rows[0].public).toBe(false)
    expect(notices.filter((n) => n.startsWith('0089'))).toEqual([])
  })

  test('nabidky čte jen člen týmu s obchodní rolí a 2FA', async () => {
    for (const who of sales) expect(await visible(who, 'nabidky'), who.sub).toBe(2)
    for (const [label, who] of denied) expect(await visible(who, 'nabidky'), label).toBe(0)
  })

  test('zápis do nabidky přes klienta nikdo — ani vedení (návrh AI nejde podvrhnout)', async () => {
    for (const who of [...sales, ...denied.map(([, w]) => w)]) {
      await expect(write(who, upload('nabidky', 'offers/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.navrh.json')), who.sub ?? 'anon')
        .rejects.toThrow(/row-level security/)
    }
    for (const who of sales) {
      // UPDATE/DELETE bez povolených řádků nic nezmění (RLS je odfiltruje).
      await write(who, `UPDATE storage.objects SET name = 'offers/podvrh.navrh.json' WHERE bucket_id = 'nabidky'`)
      await write(who, `DELETE FROM storage.objects WHERE bucket_id = 'nabidky'`)
    }
    expect((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM storage.objects WHERE bucket_id = 'nabidky' AND name LIKE '%aaaaaaaa%'`)).rows[0].n).toBe(2)
  })

  test('servisní klíč (service_role) dál čte i zapisuje nabidky — aplikace beze změny', async () => {
    expect(await visible({ role: 'service_role' }, 'nabidky')).toBe(2)
    await write({ role: 'service_role' }, upload('nabidky', 'offers/cccccccc-cccc-4ccc-8ccc-cccccccccccc.pdf'))
  })

  test('celé úložiště: i volná politika jiného bucketu platí jen pro tým s 2FA', async () => {
    for (const who of [...sales, { sub: U_PROJEKT, aal: 'aal2' as const }]) {
      expect(await visible(who, 'jiny'), who.sub).toBe(1)
      await write(who, upload('jiny', 'y.txt'))
    }
    for (const [label, who] of denied.slice(1)) {
      expect(await visible(who, 'jiny'), label).toBe(0)
      await expect(write(who, upload('jiny', 'y.txt')), label).rejects.toThrow(/row-level security/)
    }
  })

  test('guard: bez schématu storage přeskočí s NOTICE a zapíše jen ledger', async () => {
    const bare = new PGlite()
    const seen: string[] = []
    try {
      await bare.exec(BASE)
      await bare.exec(MIG, { onNotice: (n: { message?: string }) => seen.push(n.message ?? '') })
      expect(seen.some((m) => /0089: schéma storage .* přeskočeny/.test(m))).toBe(true)
      expect((await bare.query<{ n: number }>(`SELECT count(*)::int AS n FROM schema_migration WHERE version = '0089'`)).rows[0].n).toBe(1)
    } finally {
      await bare.close()
    }
  }, 60_000)

  test('guard: bez can_see_sales() srozumitelná chyba; bez oprávnění na storage.objects taky', async () => {
    const bare = new PGlite()
    try {
      await bare.exec(BASE.replace(/CREATE FUNCTION can_see_sales[\s\S]*?\$\$;/, '').replace(/, can_see_sales\(\)/, ''))
      await expect(bare.exec(MIG)).rejects.toThrow(/0089 vyžaduje funkci can_see_sales\(\)/)
      await bare.exec(`CREATE FUNCTION can_see_sales() RETURNS boolean LANGUAGE sql AS $$ SELECT false $$;`)
      await bare.exec(STORAGE)
      // Role, která není vlastníkem storage.objects ani superuživatel.
      await bare.exec(`CREATE ROLE migrator NOLOGIN; GRANT USAGE ON SCHEMA storage TO migrator;
        GRANT UPDATE, SELECT ON storage.buckets TO migrator; GRANT ALL ON schema_migration TO migrator;`)
      await expect(bare.exec(`SET ROLE migrator; ${MIG}`)).rejects.toThrow(/0089: chybí oprávnění zakládat politiky na storage\.objects/)
    } finally {
      await bare.close()
    }
  }, 60_000)
})
