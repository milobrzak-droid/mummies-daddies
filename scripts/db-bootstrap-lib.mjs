// Založení databáze od nuly — sdílené kousky pro scripts/db-bootstrap.mjs
// a test/db-bootstrap-pglite.test.ts (postup v docs/NASAZENI.md, krok 3).
//
// Databáze se zakládá TÝMŽ běhačem jako každá další migrace
// (scripts/migrate-runner.mjs: inspect + applyPending, každá migrace ve vlastní
// transakci, kontrola ledgeru schema_migration). Pro ověření „od nuly“ bez
// sítě se běhač pustí proti PGlite (Postgres ve WASM) s minimální náhradou
// toho, co na Supabase existuje samo: role anon/authenticated/service_role,
// schéma auth (users, uid(), jwt()), storage, Vault a pgcrypto ve schématu
// extensions. Díky tomu se na PGlite ověří i 0031/0032 (šifrování tokenů
// klíčem z Vaultu), které starší PGlite testy přeskakují.
//
// Žádná síť, žádná tajemství, nic se nevypisuje kromě čísel verzí.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { inspect, applyPending } from './migrate-runner.mjs'

// Cesty přes fileURLToPath (ne objekt URL): stejně v node i ve vitestu.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const MIGRATIONS_DIR = path.join(ROOT, 'supabase', 'migrations')
export const SEED_FILE = path.join(ROOT, 'supabase', 'seed.sql')

// Náhrada prostředí Supabase pro PGlite. Na skutečném projektu Supabase tohle
// všechno existuje (role, auth, storage, vault, extensions.pgcrypto) a skript
// to NIKDY nespouští — jen v režimu --pglite.
export const SUPABASE_STUB_SQL = `
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
CREATE SCHEMA extensions;
CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
GRANT USAGE ON SCHEMA extensions TO anon, authenticated, service_role;
CREATE SCHEMA vault;
CREATE TABLE vault.secrets (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), name text UNIQUE, description text, secret text NOT NULL);
CREATE VIEW vault.decrypted_secrets AS SELECT id, name, description, secret AS decrypted_secret FROM vault.secrets;
CREATE FUNCTION vault.create_secret(new_secret text, new_name text DEFAULT NULL, new_description text DEFAULT '') RETURNS uuid
  LANGUAGE sql AS $$ INSERT INTO vault.secrets (secret, name, description) VALUES (new_secret, new_name, new_description) RETURNING id $$;
REVOKE ALL ON SCHEMA vault FROM PUBLIC;
GRANT USAGE ON SCHEMA vault TO service_role;
GRANT SELECT ON vault.decrypted_secrets TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO authenticated, service_role, anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated, service_role, anon;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
`

export function migrationFilenames() {
  return fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort()
}

export function readMigration(filename) {
  return fs.readFileSync(path.join(MIGRATIONS_DIR, filename), 'utf8')
}

export function readSeed() {
  return fs.readFileSync(SEED_FILE, 'utf8')
}

// PGlite má dvě API: query() (jeden příkaz, parametry) a exec() (víc příkazů,
// bez parametrů). Běhač volá client.query(sql) i pro celý soubor migrace
// (simple query protokol pg), takže bez parametrů jde dotaz přes exec().
export function pgliteClient(db) {
  return {
    async query(text, params) {
      if (params && params.length) return db.query(text, params)
      const results = await db.exec(text)
      const last = results.at(-1)
      return { rows: last?.rows ?? [], rowCount: last?.affectedRows ?? 0 }
    },
    async end() {
      await db.close?.()
    },
  }
}

// Spustí celý řetěz migrací přes běhač. `client` = pg.Client nebo pgliteClient.
export async function applyAllMigrations(client, { log = () => {} } = {}) {
  const filenames = migrationFilenames()
  const plan = await inspect({ client, filenames, readSql: readMigration })
  if (!plan.pending.length) return []
  return applyPending({ client, files: plan.files, pending: plan.pending, sources: plan.sources, backfill: plan.backfill, log })
}

// Vymyšlení klienti ze supabase/seed.sql — podle nich se pozná seed na produkci.
export const SEED_MARKERS = ['Firma Alfa s.r.o.', 'Beta Konzult a.s.', 'Gama Logistik s.r.o.']

// Kontroly po založení. Vrací seznam problémů (česky, bez dat); prázdný = OK.
// `expected` = { nodes: string[], revenueLines: string[] } z konfigurace firmy;
// skript je čte z config/ přes lehký parser níže, test z @/config.
export async function verifyBootstrap(client, expected, { seeded = false, fresh = false, production = false } = {}) {
  const problems = []
  const q = async (sql, params) => (await client.query(sql, params)).rows

  const versions = (await q('select version from public.schema_migration order by version')).map((r) => r.version)
  const fileVersions = migrationFilenames().map((f) => f.slice(0, 4))
  const missing = fileVersions.filter((v) => !versions.includes(v))
  if (missing.length) problems.push(`V ledgeru schema_migration chybí verze: ${missing.join(', ')}`)
  const unknown = versions.filter((v) => !fileVersions.includes(v))
  if (unknown.length) problems.push(`Ledger zná verze bez souboru v repu: ${unknown.join(', ')}`)

  const noRls = await q(`
    select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
     where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity
     order by 1`)
  if (noRls.length) problems.push(`Tabulky bez RLS: ${noRls.map((r) => r.relname).join(', ')}`)

  const nodes = (await q('select node from public.loop_node order by node')).map((r) => r.node)
  if (expected?.nodes && JSON.stringify(nodes) !== JSON.stringify([...expected.nodes].sort())) {
    problems.push(`Uzly loop_node (${nodes.join(', ')}) nesedí s konfigurací firmy (${[...expected.nodes].sort().join(', ')})`)
  }
  const lines = (await q('select unnest(enum_range(NULL::revenue_line))::text as v')).map((r) => r.v)
  if (expected?.revenueLines && JSON.stringify(lines) !== JSON.stringify(expected.revenueLines)) {
    problems.push(`Enum revenue_line (${lines.join(', ')}) nesedí s konfigurací firmy`)
  }
  // fresh = právě založená databáze (PGlite, nebo nový projekt před prvním
  // uživatelem): nikdo není správce a bez seedu nejsou žádné obchody.
  if (fresh) {
    const [{ n: admins }] = await q('select count(*)::int as n from public.team_member where is_admin')
    if (admins !== 0) problems.push('Nová databáze nesmí mít předem nastaveného správce')
    const [{ n: deals }] = await q('select count(*)::int as n from public.deal')
    if (!seeded && deals !== 0) problems.push('Nová databáze bez seedu má obchody')
  }
  if (seeded) {
    const [{ n: deals }] = await q('select count(*)::int as n from public.deal')
    if (deals === 0) problems.push('Seed neproběhl (žádné ukázkové obchody)')
  }
  // Na produkci nikdy ukázková data: seed zakládá vymyšlené klienty se
  // známými názvy (supabase/seed.sql).
  if (production) {
    const [{ n }] = await q(`select count(*)::int as n from public.account where name in (${SEED_MARKERS.map((m) => `'${m}'`).join(', ')})`)
    if (n > 0) problems.push('Na produkci jsou ukázková data ze supabase/seed.sql — smazat (docs/NASAZENI.md, krok 3)')
  }

  return problems
}

// Klíče uzlů a obchodních linek z config/mummiesDaddies.ts bez TypeScriptu
// (skript běží čistým node). Hledá jen konstantu NODES (nebo blok `nodes:`) a blok `revenueLines:`.
export function readCompanyExpectations(source) {
  const nodesBlock = source.match(/\bNODES\s*=\s*\[([^\]]*)\]/) ?? source.match(/\bnodes:\s*\[([^\]]*)\]/)
  const nodes = nodesBlock ? [...nodesBlock[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]) : null
  const linesBlock = source.match(/\brevenueLines:\s*\[([\s\S]*?)\n\s*\]/)
  const revenueLines = linesBlock ? [...linesBlock[1].matchAll(/key:\s*'([a-z_]+)'/g)].map((m) => m[1]) : null
  return { nodes, revenueLines }
}
