// Supabase klient nad PGlite (PostgreSQL ve WASM, bez sítě) pro integrační
// testy celého toku. Na rozdíl od supabaseFake.ts / memoryDb.ts dotazy
// opravdu běží v databázi se všemi migracemi: RLS, triggery, CHECKy, audit
// a RPC jsou ty z produkce.
//
// Napodobuje tu část API supabase-js / PostgREST, kterou aplikace používá:
//   from(t).select('*, alias:tabulka!fk(sloupce)', { count, head })
//          .insert / .update / .upsert({ onConflict, ignoreDuplicates }) / .delete
//          filtry eq neq gt gte lt lte like ilike is in contains not or match
//          order limit range single maybeSingle throwOnError
//   rpc(fn, args)  (pojmenované argumenty, typy z pg_proc)
//   auth.getUser() (uživatel z kontextu)
// Výstup je JSON z Postgresu (row_to_json), stejně jako u PostgREST: bigint
// a numeric jako čísla, timestamptz jako ISO řetězec, date jako YYYY-MM-DD.
//
// Každé volání = jedna transakce s rolí kontextu (service_role / authenticated
// se sub a AAL2) a s hlavičkami v GUC request.headers (aktér auditu 0064).
// Volání se řadí za sebe (PGlite má jedno spojení).
import { readdirSync, readFileSync } from 'node:fs'

type Row = Record<string, unknown>
export type PgDb = {
  exec: (sql: string) => Promise<unknown>
  query: <T = Row>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>
}

export const SUPABASE_STUB = `
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

/** Migrace potřebující Supabase Vault (šifrování tokenů kalendáře) — k toku se nevztahují. */
export const NEEDS_VAULT = new Set(['0031_encrypt_calendar_tokens.sql', '0032_drop_calendar_token_plaintext.sql'])

/** Nová PGlite se stubem Supabase a všemi migracemi supabase/migrations (kromě Vaultu). */
export async function bootDatabase(Ctor: new () => PgDb, dir = 'supabase/migrations'): Promise<PgDb> {
  const db = new Ctor()
  await db.exec(SUPABASE_STUB)
  for (const f of readdirSync(dir).filter((x) => x.endsWith('.sql')).sort()) {
    if (NEEDS_VAULT.has(f)) continue
    try {
      await db.exec(readFileSync(`${dir}/${f}`, 'utf8'))
    } catch (e) {
      await db.exec('ROLLBACK').catch(() => undefined)
      throw new Error(`${f}: ${(e as Error).message}`)
    }
  }
  return db
}

export type PgCtx = {
  role: 'service_role' | 'authenticated' | 'anon'
  sub?: string
  aal?: 'aal1' | 'aal2'
  headers?: Record<string, string>
}

export type PgError = { code: string; message: string; details: string | null; hint: string | null }
type Result = { data: unknown; error: PgError | null; count: number | null; status: number; statusText: string }

const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`

function toPgError(e: unknown): PgError {
  const x = e as { code?: string; message?: string; detail?: string; hint?: string }
  return { code: x?.code ?? 'XX000', message: x?.message ?? String(e), details: x?.detail ?? null, hint: x?.hint ?? null }
}

/** PG pole jako textový literál ({"a","b"}), aby typ určil cast, ne serializér PGlite. */
function pgArrayLiteral(values: readonly unknown[]): string {
  return `{${values.map((v) => (v === null || v === undefined ? 'NULL' : `"${String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`)).join(',')}}`
}

type FkInfo = { table: string; column: string; refTable: string; refColumn: string; name: string }

// ---------------------------------------------------------------------------
// Databáze + metadata

export class PgSupabase {
  private chain: Promise<unknown> = Promise.resolve()
  private columnTypes = new Map<string, Map<string, string>>()
  private fks: FkInfo[] | null = null
  private procs = new Map<string, { args: { name: string; type: string }[]; retset: boolean; kind: 'scalar' | 'composite' | 'void' }>()
  /** Všechny SQL příkazy (pro kontrolu, že se nic nevolá mimo DB). */
  readonly log: string[] = []

  constructor(readonly db: PgDb) {}

  /** Serializovaná transakce s rolí a hlavičkami kontextu. */
  run<T>(ctx: PgCtx, body: (query: PgDb['query']) => Promise<T>): Promise<T> {
    const exec = async () => {
      await this.db.query('BEGIN')
      try {
        const claims = { role: ctx.role, aal: ctx.aal ?? 'aal2', ...(ctx.sub ? { sub: ctx.sub } : {}) }
        await this.db.query(`SELECT set_config('request.jwt.claims', $1, true)`, [JSON.stringify(claims)])
        const headers = Object.fromEntries(Object.entries(ctx.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]))
        await this.db.query(`SELECT set_config('request.headers', $1, true)`, [JSON.stringify(headers)])
        await this.db.query(`SET LOCAL ROLE ${ctx.role}`)
        const out = await body((sql, params) => {
          this.log.push(sql)
          return this.db.query(sql, params)
        })
        await this.db.query('COMMIT')
        return out
      } catch (e) {
        await this.db.query('ROLLBACK').catch(() => undefined)
        throw e
      }
    }
    const p = this.chain.then(exec, exec)
    this.chain = p.catch(() => undefined)
    return p
  }

  async types(table: string): Promise<Map<string, string>> {
    const hit = this.columnTypes.get(table)
    if (hit) return hit
    const { rows } = await this.db.query<{ name: string; type: string }>(
      `SELECT a.attname AS name, format_type(a.atttypid, a.atttypmod) AS type
         FROM pg_attribute a WHERE a.attrelid = to_regclass($1) AND a.attnum > 0 AND NOT a.attisdropped`,
      [`public.${q(table)}`],
    )
    if (rows.length === 0) throw Object.assign(new Error(`relation "${table}" does not exist`), { code: '42P01' })
    const m = new Map(rows.map((r) => [r.name, r.type]))
    this.columnTypes.set(table, m)
    return m
  }

  async foreignKeys(): Promise<FkInfo[]> {
    if (this.fks) return this.fks
    const { rows } = await this.db.query<FkInfo>(`
      SELECT c.conname AS name, t.relname AS "table", a.attname AS "column", rt.relname AS "refTable", ra.attname AS "refColumn"
        FROM pg_constraint c
        JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace AND n.nspname = 'public'
        JOIN pg_class rt ON rt.oid = c.confrelid
        JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = c.conkey[1]
        JOIN pg_attribute ra ON ra.attrelid = c.confrelid AND ra.attnum = c.confkey[1]
       WHERE c.contype = 'f' AND cardinality(c.conkey) = 1`)
    this.fks = rows
    return rows
  }

  async proc(name: string, argNames: readonly string[]) {
    const key = `${name}(${[...argNames].sort().join(',')})`
    const hit = this.procs.get(key)
    if (hit) return hit
    const { rows } = await this.db.query<{ names: string[] | null; modes: string[] | null; types: string[]; retset: boolean; typtype: string; rettype: string; nargs: number; ndefaults: number }>(`
      SELECT p.proargnames AS names, p.proargmodes::text[] AS modes,
             ARRAY(SELECT format_type(t, NULL) FROM unnest(p.proargtypes) t) AS types,
             p.proretset AS retset, rt.typtype::text AS typtype, format_type(p.prorettype, NULL) AS rettype,
             p.pronargs AS nargs, p.pronargdefaults AS ndefaults
        FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace AND n.nspname = 'public'
        JOIN pg_type rt ON rt.oid = p.prorettype
       WHERE p.proname = $1`, [name])
    const candidates = rows.map((r) => {
      const inNames = (r.names ?? []).filter((_, i) => !r.modes || r.modes[i] === 'i' || r.modes[i] === 'b' || r.modes[i] === 'v')
      const args = r.types.map((type, i) => ({ name: inNames[i] ?? `$${i + 1}`, type }))
      const kind: 'scalar' | 'composite' | 'void' = r.rettype === 'void' ? 'void' : r.typtype === 'c' || r.rettype === 'record' ? 'composite' : 'scalar'
      return { args, retset: r.retset, kind, required: r.nargs - r.ndefaults }
    }).filter((c) => argNames.every((n) => c.args.some((a) => a.name === n)) && c.args.slice(0, c.required).every((a) => argNames.includes(a.name)))
    if (candidates.length !== 1) {
      throw Object.assign(new Error(`Could not find the function public.${name}(${argNames.join(', ')}) in the schema cache`), { code: 'PGRST202' })
    }
    this.procs.set(key, candidates[0])
    return candidates[0]
  }

  /** Klient s rozhraním supabase-js pro daný kontext. */
  client(ctx: PgCtx, user?: { id: string; email?: string } | null) {
    return {
      from: (table: string) => new Builder(this, ctx, table),
      rpc: (fn: string, args: Record<string, unknown> = {}) => new RpcCall(this, ctx, fn, args),
      auth: {
        getUser: async () => ({ data: { user: user ?? (ctx.sub ? { id: ctx.sub } : null) }, error: null }),
        mfa: { getAuthenticatorAssuranceLevel: async () => ({ data: { currentLevel: ctx.aal ?? 'aal2', nextLevel: 'aal2' }, error: null }) },
      },
      storage: {
        from: () => ({
          upload: async () => ({ data: null, error: { message: 'storage není v testu' } }),
          download: async () => ({ data: null, error: { message: 'storage není v testu' } }),
          createSignedUrl: async () => ({ data: null, error: { message: 'storage není v testu' } }),
          remove: async () => ({ data: null, error: null }),
        }),
      },
    }
  }
}

// ---------------------------------------------------------------------------
// RPC

class RpcCall implements PromiseLike<Result> {
  private singleMode: 'single' | 'maybe' | null = null
  constructor(private pg: PgSupabase, private ctx: PgCtx, private fn: string, private args: Record<string, unknown>) {}

  single() { this.singleMode = 'single'; return this }
  maybeSingle() { this.singleMode = 'maybe'; return this }
  throwOnError() { return this }

  async execute(): Promise<Result> {
    try {
      const names = Object.keys(this.args).filter((k) => this.args[k] !== undefined)
      const proc = await this.pg.proc(this.fn, names)
      const params: unknown[] = []
      const argSql = names.map((n) => {
        const type = proc.args.find((a) => a.name === n)!.type
        const v = this.args[n]
        if (v === null) return `${q(n)} => NULL::${type}`
        params.push(JSON.stringify(v))
        const p = `$${params.length}::json`
        if (type === 'json' || type === 'jsonb') return `${q(n)} => ${p}::${type}`
        if (type.endsWith('[]')) return `${q(n)} => ARRAY(SELECT json_array_elements_text(${p}))::${type}`
        return `${q(n)} => (${p} #>> '{}')::${type}`
      }).join(', ')
      const call = `public.${q(this.fn)}(${argSql})`
      const data = await this.pg.run(this.ctx, async (query) => {
        if (proc.kind === 'void') {
          await query(`SELECT ${call}`, params)
          return null
        }
        if (proc.retset) {
          const { rows } = await query<{ r: unknown }>(`SELECT to_json(_f) AS r FROM ${call} _f`, params)
          return rows.map((r) => r.r)
        }
        if (proc.kind === 'composite') {
          const { rows } = await query<{ r: unknown }>(`SELECT to_json(_f) AS r FROM ${call} _f`, params)
          return rows[0]?.r ?? null
        }
        const { rows } = await query<{ r: unknown }>(`SELECT to_json(${call}) AS r`, params)
        return rows[0]?.r ?? null
      })
      if (this.singleMode && Array.isArray(data)) {
        if (data.length === 1) return ok(data[0])
        if (data.length === 0 && this.singleMode === 'maybe') return ok(null)
        return fail({ code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: null, hint: null })
      }
      return ok(data)
    } catch (e) {
      return fail(toPgError(e))
    }
  }

  then<A = Result, B = never>(onOk?: ((v: Result) => A | PromiseLike<A>) | null, onErr?: ((e: unknown) => B | PromiseLike<B>) | null) {
    return this.execute().then(onOk, onErr)
  }
}

const ok = (data: unknown, count: number | null = null): Result => ({ data, error: null, count, status: 200, statusText: 'OK' })
const fail = (error: PgError): Result => ({ data: null, error, count: null, status: 400, statusText: 'Bad Request' })

// ---------------------------------------------------------------------------
// Dotazy nad tabulkou

type Filter =
  | { kind: 'op'; column: string; op: string; value: unknown; negate?: boolean }
  | { kind: 'or'; expr: string }

type SelectNode =
  | { kind: 'star' }
  | { kind: 'col'; name: string; alias: string; cast: string | null }
  | { kind: 'embed'; target: string; alias: string; hint: string | null; inner: boolean; children: SelectNode[] }

function splitTop(s: string): string[] {
  const out: string[] = []
  let depth = 0
  let cur = ''
  let quote = false
  for (const ch of s) {
    if (ch === '"') quote = !quote
    if (!quote && ch === '(') depth++
    if (!quote && ch === ')') depth--
    if (!quote && ch === ',' && depth === 0) {
      out.push(cur)
      cur = ''
      continue
    }
    cur += ch
  }
  if (cur.trim()) out.push(cur)
  return out.map((x) => x.trim()).filter(Boolean)
}

export function parseSelect(s: string): SelectNode[] {
  return splitTop(s.replace(/\s+/g, ' ')).map((item): SelectNode => {
    if (item === '*') return { kind: 'star' }
    const paren = item.indexOf('(')
    if (paren >= 0 && item.endsWith(')')) {
      const head = item.slice(0, paren).trim()
      const children = parseSelect(item.slice(paren + 1, -1))
      const [aliasPart, rest] = head.includes(':') ? head.split(':', 2) : [null, head]
      const [target, ...mods] = rest.split('!')
      const inner = mods.includes('inner')
      const hint = mods.find((m) => m !== 'inner' && m !== 'left') ?? null
      return { kind: 'embed', target: target.trim(), alias: (aliasPart ?? target).trim(), hint, inner, children }
    }
    const colon = /(^|[^:]):(?!:)/.exec(item)
    const at = colon ? colon.index + colon[1].length : -1
    const aliasPart = at >= 0 ? item.slice(0, at) : null
    const rest = at >= 0 ? item.slice(at + 1) : item
    const [name, cast] = rest.split('::')
    return { kind: 'col', name: name.trim(), alias: (aliasPart ?? name).trim(), cast: cast?.trim() ?? null }
  })
}

let aliasSeq = 0

class Builder implements PromiseLike<Result> {
  private action: 'select' | 'insert' | 'update' | 'upsert' | 'delete' = 'select'
  private columns: string | null = null
  private returning = false
  private countMode: string | null = null
  private head = false
  private values: Row[] = []
  private patch: Row = {}
  private onConflict: string | null = null
  private ignoreDuplicates = false
  private filters: Filter[] = []
  private orders: { column: string; ascending: boolean; nullsFirst: boolean | undefined }[] = []
  private limitN: number | null = null
  private offsetN: number | null = null
  private singleMode: 'single' | 'maybe' | null = null
  private throwing = false

  constructor(private pg: PgSupabase, private ctx: PgCtx, private table: string) {}

  select(columns = '*', opts: { count?: string; head?: boolean } = {}) {
    this.columns = columns
    if (this.action !== 'select') this.returning = true
    if (opts.count) this.countMode = opts.count
    if (opts.head) this.head = true
    return this
  }
  insert(values: Row | Row[], opts: { count?: string } = {}) {
    this.action = 'insert'
    this.values = Array.isArray(values) ? values : [values]
    if (opts.count) this.countMode = opts.count
    return this
  }
  upsert(values: Row | Row[], opts: { onConflict?: string; ignoreDuplicates?: boolean; count?: string } = {}) {
    this.action = 'upsert'
    this.values = Array.isArray(values) ? values : [values]
    this.onConflict = opts.onConflict ?? null
    this.ignoreDuplicates = opts.ignoreDuplicates === true
    return this
  }
  update(values: Row, opts: { count?: string } = {}) {
    this.action = 'update'
    this.patch = values
    if (opts.count) this.countMode = opts.count
    return this
  }
  delete(opts: { count?: string } = {}) {
    this.action = 'delete'
    if (opts.count) this.countMode = opts.count
    return this
  }

  private op(column: string, op: string, value: unknown) {
    this.filters.push({ kind: 'op', column, op, value })
    return this
  }
  eq(c: string, v: unknown) { return this.op(c, 'eq', v) }
  neq(c: string, v: unknown) { return this.op(c, 'neq', v) }
  gt(c: string, v: unknown) { return this.op(c, 'gt', v) }
  gte(c: string, v: unknown) { return this.op(c, 'gte', v) }
  lt(c: string, v: unknown) { return this.op(c, 'lt', v) }
  lte(c: string, v: unknown) { return this.op(c, 'lte', v) }
  like(c: string, v: unknown) { return this.op(c, 'like', v) }
  ilike(c: string, v: unknown) { return this.op(c, 'ilike', v) }
  is(c: string, v: unknown) { return this.op(c, 'is', v) }
  in(c: string, v: readonly unknown[]) { return this.op(c, 'in', v) }
  contains(c: string, v: unknown) { return this.op(c, 'cs', v) }
  containedBy(c: string, v: unknown) { return this.op(c, 'cd', v) }
  overlaps(c: string, v: unknown) { return this.op(c, 'ov', v) }
  match(obj: Row) {
    for (const [k, v] of Object.entries(obj)) this.eq(k, v)
    return this
  }
  filter(c: string, op: string, v: unknown) { return this.op(c, op, parseFilterValue(op, String(v))) }
  not(c: string, op: string, v: unknown) {
    const value = typeof v === 'string' ? parseFilterValue(op, v) : v
    this.filters.push({ kind: 'op', column: c, op, value, negate: true })
    return this
  }
  or(expr: string, opts: { referencedTable?: string; foreignTable?: string } = {}) {
    if (opts.referencedTable || opts.foreignTable) throw new Error('pgliteSupabase: or() nad vnořenou tabulkou neumí')
    this.filters.push({ kind: 'or', expr })
    return this
  }
  order(column: string, opts: { ascending?: boolean; nullsFirst?: boolean; referencedTable?: string; foreignTable?: string } = {}) {
    if (opts.referencedTable || opts.foreignTable) return this // řazení vnořených řádků test nepotřebuje
    this.orders.push({ column, ascending: opts.ascending !== false, nullsFirst: opts.nullsFirst })
    return this
  }
  limit(n: number, opts: { referencedTable?: string; foreignTable?: string } = {}) {
    if (opts.referencedTable || opts.foreignTable) return this
    this.limitN = n
    return this
  }
  range(from: number, to: number) {
    this.offsetN = from
    this.limitN = to - from + 1
    return this
  }
  single() { this.singleMode = 'single'; return this }
  maybeSingle() { this.singleMode = 'maybe'; return this }
  abortSignal() { return this }
  returns() { return this }
  throwOnError() { this.throwing = true; return this }

  then<A = Result, B = never>(onOk?: ((v: Result) => A | PromiseLike<A>) | null, onErr?: ((e: unknown) => B | PromiseLike<B>) | null) {
    return this.execute().then((r) => {
      if (this.throwing && r.error) throw Object.assign(new Error(r.error.message), r.error)
      return r
    }).then(onOk, onErr)
  }

  // --- SQL

  private async where(alias: string, params: unknown[]): Promise<string> {
    const types = await this.pg.types(this.table)
    const parts: string[] = []
    for (const f of this.filters) {
      if (f.kind === 'or') parts.push(`(${parseLogic(f.expr).map((x) => condSql(x, alias, types, params)).join(' OR ')})`)
      else parts.push(condSql(f, alias, types, params))
    }
    return parts.length ? `WHERE ${parts.join(' AND ')}` : ''
  }

  private async selectList(table: string, alias: string, nodes: SelectNode[]): Promise<{ sql: string; innerConds: string[] }> {
    const types = await this.pg.types(table)
    const out: string[] = []
    const innerConds: string[] = []
    for (const n of nodes) {
      if (n.kind === 'star') out.push(`${alias}.*`)
      else if (n.kind === 'col') {
        if (!types.has(n.name)) throw Object.assign(new Error(`column ${table}.${n.name} does not exist`), { code: '42703' })
        out.push(`${alias}.${q(n.name)}${n.cast ? `::${n.cast}` : ''} AS ${q(n.alias)}`)
      } else {
        const sub = await this.embedSql(table, alias, n)
        out.push(`${sub.sql} AS ${q(n.alias)}`)
        if (n.inner) innerConds.push(sub.many ? `json_array_length(${sub.sql}) > 0` : `${sub.sql} IS NOT NULL`)
      }
    }
    return { sql: out.join(', '), innerConds }
  }

  private async embedSql(parent: string, parentAlias: string, n: Extract<SelectNode, { kind: 'embed' }>): Promise<{ sql: string; many: boolean }> {
    const fks = await this.pg.foreignKeys()
    const types = await this.pg.types(parent)
    let rel: { fk: FkInfo; many: boolean } | null = null
    let target = n.target
    const byColumn = types.has(n.target) ? fks.find((f) => f.table === parent && f.column === n.target) : undefined
    if (byColumn) {
      rel = { fk: byColumn, many: false }
      target = byColumn.refTable
    } else {
      const matches = (f: FkInfo) => !n.hint || f.name === n.hint || f.column === n.hint
      const toOne = fks.filter((f) => f.table === parent && f.refTable === target && matches(f)).map((fk) => ({ fk, many: false }))
      const toMany = fks.filter((f) => f.table === target && f.refTable === parent && matches(f)).map((fk) => ({ fk, many: true }))
      const all = [...toOne, ...toMany]
      if (all.length !== 1) {
        throw Object.assign(new Error(`Could not embed '${n.target}' from '${parent}' (${all.length} vztahů)`), { code: all.length ? 'PGRST201' : 'PGRST200' })
      }
      rel = all[0]
    }
    const a = `_e${++aliasSeq}`
    const inner = await this.selectList(target, a, n.children)
    const join = rel.many
      ? `${a}.${q(rel.fk.column)} = ${parentAlias}.${q(rel.fk.refColumn)}`
      : `${a}.${q(rel.fk.refColumn)} = ${parentAlias}.${q(rel.fk.column)}`
    const extra = inner.innerConds.length ? ` AND ${inner.innerConds.join(' AND ')}` : ''
    const body = `SELECT ${inner.sql} FROM public.${q(target)} ${a} WHERE ${join}${extra}`
    return rel.many
      ? { sql: `(SELECT coalesce(json_agg(_j), '[]'::json) FROM (${body}) _j)`, many: true }
      : { sql: `(SELECT row_to_json(_j) FROM (${body} LIMIT 1) _j)`, many: false }
  }

  private orderSql(alias: string): string {
    if (!this.orders.length) return ''
    return `ORDER BY ${this.orders.map((o) => `${alias}.${q(o.column)} ${o.ascending ? 'ASC' : 'DESC'}${o.nullsFirst === undefined ? '' : o.nullsFirst ? ' NULLS FIRST' : ' NULLS LAST'}`).join(', ')}`
  }

  async execute(): Promise<Result> {
    try {
      const params: unknown[] = []
      const t = `public.${q(this.table)}`
      const alias = `_t${++aliasSeq}`
      const nodes = parseSelect(this.columns ?? '*')

      const rowsResult = await this.pg.run(this.ctx, async (query) => {
        if (this.action === 'select') {
          const where = await this.where(alias, params)
          let count: number | null = null
          if (this.countMode) {
            const c = await query<{ n: number }>(`SELECT count(*)::int AS n FROM ${t} ${alias} ${where}`, params)
            count = c.rows[0].n
          }
          if (this.head) return { rows: null, count }
          const list = await this.selectList(this.table, alias, nodes)
          const inner = list.innerConds.length ? `${where ? `${where} AND` : 'WHERE'} ${list.innerConds.join(' AND ')}` : where
          const lim = this.limitN !== null ? ` LIMIT ${this.limitN}` : ''
          const off = this.offsetN !== null ? ` OFFSET ${this.offsetN}` : ''
          const sql = `SELECT row_to_json(_r) AS r FROM (SELECT ${list.sql} FROM ${t} ${alias} ${inner} ${this.orderSql(alias)}${lim}${off}) _r`
          const { rows } = await query<{ r: Row }>(sql, params)
          return { rows: rows.map((r) => r.r), count }
        }

        let mutation: string
        if (this.action === 'insert' || this.action === 'upsert') {
          const cols = [...new Set(this.values.flatMap((v) => Object.keys(v).filter((k) => v[k] !== undefined)))]
          const types = await this.pg.types(this.table)
          for (const c of cols) if (!types.has(c)) throw Object.assign(new Error(`column ${this.table}.${c} does not exist`), { code: 'PGRST204' })
          params.push(JSON.stringify(this.values))
          const colList = cols.map(q).join(', ')
          mutation = `INSERT INTO ${t} AS ${alias} (${colList}) SELECT ${colList} FROM json_populate_recordset(NULL::${t}, $${params.length}::json)`
          if (this.action === 'upsert') {
            const target = this.onConflict ? this.onConflict.split(',').map((c) => q(c.trim())).join(', ') : q('id')
            const conflictCols = new Set((this.onConflict ?? 'id').split(',').map((c) => c.trim()))
            const set = cols.filter((c) => !conflictCols.has(c)).map((c) => `${q(c)} = EXCLUDED.${q(c)}`)
            mutation += this.ignoreDuplicates || set.length === 0
              ? ` ON CONFLICT (${target}) DO NOTHING`
              : ` ON CONFLICT (${target}) DO UPDATE SET ${set.join(', ')}`
          }
        } else if (this.action === 'update') {
          const cols = Object.keys(this.patch).filter((k) => this.patch[k] !== undefined)
          params.push(JSON.stringify(this.patch))
          const pIdx = params.length
          const where = await this.where(alias, params)
          mutation = `UPDATE ${t} AS ${alias} SET ${cols.map((c) => `${q(c)} = _p.${q(c)}`).join(', ')}
            FROM (SELECT * FROM json_populate_record(NULL::${t}, $${pIdx}::json)) _p ${where}`
        } else {
          const where = await this.where(alias, params)
          mutation = `DELETE FROM ${t} AS ${alias} ${where}`
        }

        if (!this.returning) {
          const { rows } = await query<{ n: number }>(`WITH _m AS (${mutation} RETURNING 1) SELECT count(*)::int AS n FROM _m`, params)
          return { rows: null, count: this.countMode ? rows[0].n : null }
        }
        // Vrácené řádky (i s vnořenými tabulkami) z výsledku mutace.
        const list = await this.selectList(this.table, alias, nodes)
        const { rows } = await query<{ r: Row }>(
          `WITH _m AS (${mutation} RETURNING ${alias}.*) SELECT row_to_json(_r) AS r FROM (SELECT ${list.sql} FROM _m ${alias}) _r`,
          params,
        )
        return { rows: rows.map((r) => r.r), count: this.countMode ? rows.length : null }
      })

      const { rows, count } = rowsResult
      if (rows === null) return ok(null, count)
      if (this.singleMode) {
        if (rows.length === 1) return ok(rows[0], count)
        if (rows.length === 0 && this.singleMode === 'maybe') return ok(null, count)
        return fail({ code: 'PGRST116', message: `JSON object requested, ${rows.length} rows returned`, details: null, hint: null })
      }
      return ok(rows, count)
    } catch (e) {
      return fail(toPgError(e))
    }
  }
}

// --- filtry (stejná gramatika jako PostgREST) ----------------------------------

function parseFilterValue(op: string, raw: string): unknown {
  if (op === 'in') {
    const inner = raw.replace(/^\(/, '').replace(/\)$/, '')
    return splitTop(inner).map((x) => x.replace(/^"(.*)"$/, '$1'))
  }
  if (op === 'is') return raw === 'null' ? null : raw === 'true' ? true : raw === 'false' ? false : raw
  return raw
}

/** „a.eq.1,b.is.null,and(c.gt.2,d.lt.3)" → podmínky. */
function parseLogic(expr: string): (Filter | { kind: 'group'; join: 'or' | 'and'; items: ReturnType<typeof parseLogic> })[] {
  return splitTop(expr).map((part) => {
    const g = /^(not\.)?(and|or)\((.*)\)$/.exec(part)
    if (g) return { kind: 'group' as const, join: g[2] as 'and' | 'or', items: parseLogic(g[3]) }
    const m = /^([^.]+)\.(not\.)?([a-z]+)\.(.*)$/.exec(part)
    if (!m) throw new Error(`pgliteSupabase: nečitelný filtr ${part}`)
    return { kind: 'op' as const, column: m[1], op: m[3], value: parseFilterValue(m[3], m[4]), negate: Boolean(m[2]) }
  })
}

type Cond = ReturnType<typeof parseLogic>[number]

function condSql(f: Cond, alias: string, types: Map<string, string>, params: unknown[]): string {
  if (f.kind === 'group') return `(${f.items.map((x) => condSql(x, alias, types, params)).join(f.join === 'or' ? ' OR ' : ' AND ')})`
  if (f.kind === 'or') return `(${parseLogic(f.expr).map((x) => condSql(x, alias, types, params)).join(' OR ')})`
  const type = types.get(f.column)
  if (!type) throw Object.assign(new Error(`column ${f.column} does not exist (filtr)`), { code: '42703' })
  const col = `${alias}.${q(f.column)}`
  const bind = (v: unknown, castTo = type) => {
    params.push(v === null || v === undefined ? null : typeof v === 'object' ? JSON.stringify(v) : String(v))
    return `CAST($${params.length}::text AS ${castTo})`
  }
  let sql: string
  switch (f.op) {
    case 'eq': sql = `${col} = ${bind(f.value)}`; break
    case 'neq': sql = `${col} <> ${bind(f.value)}`; break
    case 'gt': sql = `${col} > ${bind(f.value)}`; break
    case 'gte': sql = `${col} >= ${bind(f.value)}`; break
    case 'lt': sql = `${col} < ${bind(f.value)}`; break
    case 'lte': sql = `${col} <= ${bind(f.value)}`; break
    case 'like': sql = `${col}::text LIKE ${bind(String(f.value).replace(/\*/g, '%'), 'text')}`; break
    case 'ilike': sql = `${col}::text ILIKE ${bind(String(f.value).replace(/\*/g, '%'), 'text')}`; break
    case 'is': sql = f.value === null ? `${col} IS NULL` : f.value === true ? `${col} IS TRUE` : f.value === false ? `${col} IS FALSE` : `${col} IS UNKNOWN`; break
    case 'in': {
      const list = f.value as unknown[]
      params.push(pgArrayLiteral(list))
      sql = `${col} = ANY(CAST($${params.length}::text AS ${type}[]))`
      break
    }
    case 'cs': sql = `${col} @> ${bind(Array.isArray(f.value) && !type.startsWith('json') ? pgArrayLiteral(f.value) : f.value)}`; break
    case 'cd': sql = `${col} <@ ${bind(Array.isArray(f.value) && !type.startsWith('json') ? pgArrayLiteral(f.value) : f.value)}`; break
    case 'ov': sql = `${col} && ${bind(Array.isArray(f.value) ? pgArrayLiteral(f.value) : f.value)}`; break
    default: throw new Error(`pgliteSupabase: operátor ${f.op} neumí`)
  }
  return f.negate ? `NOT (${sql})` : sql
}
