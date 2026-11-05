// Malá databáze v paměti pro testy služeb, které dělají víc dotazů nad víc
// tabulkami (na rozdíl od supabaseFake.ts, který jen zapisuje řetězec volání).
// Umí přesně to, co potřebuje příjem zápisů schůzek: insert / upsert / update
// / select s filtry eq, neq, is, not, in, gt, gte, lt, order, limit, range, count head,
// unikátní klíče (včetně částečného) a chyby vynucené testem.

export type Row = Record<string, unknown>
type Err = { code: string; message: string }
type Result = { data: unknown; error: Err | null; count?: number | null }

export type UniqueSpec = { columns: string[]; where?: (row: Row) => boolean }

export type MemoryDbOptions = {
  unique?: Record<string, UniqueSpec[]>
  /** Vrátí chybu pro danou operaci, nebo null. `cols` = sloupce ze select() (null = všechny). */
  fail?: (table: string, op: string, payload: unknown, cols: string[] | null) => Err | null
  /** Výchozí hodnoty sloupců doplněné při insertu (jako DEFAULT v DB). */
  defaults?: Record<string, () => Row>
}

export class MemoryDb {
  tables: Record<string, Row[]> = {}
  seq: Record<string, number> = {}
  calls: { table: string; op: string; payload: unknown }[] = []
  constructor(private opts: MemoryDbOptions = {}) {}

  seed(table: string, rows: Row[]): void {
    for (const r of rows) this.add(table, { ...r })
  }

  rows(table: string): Row[] {
    return this.tables[table] ?? []
  }

  private add(table: string, row: Row): Row {
    const list = (this.tables[table] ??= [])
    const def = this.opts.defaults?.[table]
    if (def) for (const [k, v] of Object.entries(def())) if (row[k] === undefined) row[k] = v
    if (row.id === undefined) {
      this.seq[table] = (this.seq[table] ?? 0) + 1
      row.id = this.seq[table]
    } else {
      this.seq[table] = Math.max(this.seq[table] ?? 0, Number(row.id))
    }
    list.push(row)
    return row
  }

  private conflicts(table: string, row: Row, ignoreId?: unknown): UniqueSpec | null {
    for (const spec of this.opts.unique?.[table] ?? []) {
      if (spec.where && !spec.where(row)) continue
      const clash = this.rows(table).some(
        (o) => o.id !== ignoreId && (!spec.where || spec.where(o)) && spec.columns.every((c) => o[c] === row[c] && row[c] != null),
      )
      if (clash) return spec
    }
    return null
  }

  from(table: string) {
    return new Query(this, table)
  }

  get client() {
    return { from: (t: string) => this.from(t) }
  }

  // --- vnitřní operace pro Query
  exec(q: Query): Result {
    const table = q.table
    const fail = this.opts.fail?.(table, q.op, q.payload, q.cols)
    this.calls.push({ table, op: q.op, payload: q.payload })
    if (fail) return { data: null, error: fail }

    if (q.op === 'insert') {
      const rows = (Array.isArray(q.payload) ? q.payload : [q.payload]) as Row[]
      const out: Row[] = []
      for (const r of rows) {
        if (this.conflicts(table, r)) return { data: null, error: { code: '23505', message: 'duplicate key' } }
        out.push(this.add(table, { ...r }))
      }
      return { data: out.map((r) => q.project(r)), error: null }
    }
    if (q.op === 'upsert') {
      const r = q.payload as Row
      const onConflict = (q.upsertOptions?.onConflict ?? '').split(',').filter(Boolean)
      if (onConflict.length > 0) {
        const existing = this.rows(table).find((o) => onConflict.every((c) => o[c] === r[c]))
        if (existing) return { data: q.upsertOptions?.ignoreDuplicates ? [] : [q.project(existing)], error: null }
      }
      if (this.conflicts(table, r)) return { data: null, error: { code: '23505', message: 'duplicate key' } }
      return { data: [q.project(this.add(table, { ...r }))], error: null }
    }
    const matched = this.rows(table).filter((r) => q.matches(r))
    if (q.op === 'update') {
      for (const r of matched) {
        const next = { ...r, ...(q.payload as Row) }
        if (this.conflicts(table, next, r.id)) return { data: null, error: { code: '23505', message: 'duplicate key' } }
        Object.assign(r, q.payload)
      }
      return { data: matched.map((r) => q.project(r)), error: null }
    }
    if (q.op === 'delete') {
      this.tables[table] = this.rows(table).filter((r) => !matched.includes(r))
      return { data: matched.map((r) => q.project(r)), error: null }
    }
    // select
    let list = matched
    for (const o of q.orders) {
      list = [...list].sort((a, b) => {
        const av = a[o.column] as string | number, bv = b[o.column] as string | number
        const c = av < bv ? -1 : av > bv ? 1 : 0
        return o.ascending ? c : -c
      })
    }
    if (q.rangeFrom != null && q.rangeTo != null) list = list.slice(q.rangeFrom, q.rangeTo + 1)
    if (q.limitN != null) list = list.slice(0, q.limitN)
    if (q.head) return { data: null, error: null, count: matched.length }
    return { data: list.map((r) => q.project(r)), error: null, count: matched.length }
  }
}

class Query {
  op = 'select'
  payload: unknown = null
  upsertOptions: { onConflict?: string; ignoreDuplicates?: boolean } | null = null
  filters: ((r: Row) => boolean)[] = []
  orders: { column: string; ascending: boolean }[] = []
  limitN: number | null = null
  rangeFrom: number | null = null
  rangeTo: number | null = null
  head = false
  cols: string[] | null = null
  private singleMode: 'one' | 'maybe' | null = null

  constructor(private db: MemoryDb, public table: string) {}

  select(cols?: string, opts?: { head?: boolean; count?: string }) {
    if (this.op === 'select') this.head = !!opts?.head
    this.cols = cols && cols !== '*' ? cols.split(',').map((c) => c.trim()) : null
    return this
  }
  insert(p: unknown) { this.op = 'insert'; this.payload = p; return this }
  upsert(p: unknown, o?: { onConflict?: string; ignoreDuplicates?: boolean }) { this.op = 'upsert'; this.payload = p; this.upsertOptions = o ?? null; return this }
  update(p: unknown) { this.op = 'update'; this.payload = p; return this }
  delete() { this.op = 'delete'; return this }
  eq(c: string, v: unknown) { this.filters.push((r) => r[c] === v); return this }
  is(c: string, v: unknown) { this.filters.push((r) => (v === null ? r[c] == null : r[c] === v)); return this }
  not(c: string, op: string, v: unknown) {
    if (op === 'is') this.filters.push((r) => (v === null ? r[c] != null : r[c] !== v))
    return this
  }
  neq(c: string, v: unknown) { this.filters.push((r) => r[c] !== v); return this }
  lt(c: string, v: unknown) { this.filters.push((r) => r[c] != null && (r[c] as string) < (v as string)); return this }
  // PostgREST `cs` (pole obsahuje všechny hodnoty): text[] sloupec @> vs.
  // Objekt = jsonb @> (mělce: pole v hodnotě musí obsahovat všechny prvky, jinak shoda).
  contains(c: string, vs: unknown[] | Row) {
    if (!Array.isArray(vs)) {
      this.filters.push((r) => {
        const doc = r[c] as Row | null | undefined
        if (!doc || typeof doc !== 'object') return false
        return Object.entries(vs).every(([k, v]) => Array.isArray(v)
          ? Array.isArray(doc[k]) && v.every((x) => (doc[k] as unknown[]).includes(x))
          : doc[k] === v)
      })
      return this
    }
    this.filters.push((r) => Array.isArray(r[c]) && vs.every((v) => (r[c] as unknown[]).includes(v)))
    return this
  }
  in(c: string, vs: unknown[]) { this.filters.push((r) => vs.includes(r[c])); return this }
  gt(c: string, v: unknown) { this.filters.push((r) => r[c] != null && (r[c] as string) > (v as string)); return this }
  gte(c: string, v: unknown) { this.filters.push((r) => (r[c] as string) >= (v as string)); return this }
  order(column: string, o?: { ascending?: boolean }) { this.orders.push({ column, ascending: o?.ascending !== false }); return this }
  limit(n: number) { this.limitN = n; return this }
  range(a: number, b: number) { this.rangeFrom = a; this.rangeTo = b; return this }
  maybeSingle() { this.singleMode = 'maybe'; return this }
  // single(): jeden řádek, jinak chyba PGRST116 jako PostgREST.
  single() { this.singleMode = 'one'; return this }

  matches(r: Row): boolean { return this.filters.every((f) => f(r)) }
  project(r: Row): Row {
    if (!this.cols) return { ...r }
    const o: Row = {}
    for (const c of this.cols) o[c] = r[c]
    return o
  }

  then<T>(onOk: (v: Result) => T, onErr?: (e: unknown) => T): Promise<T> {
    let res: Result
    try {
      res = this.db.exec(this)
    } catch (e) {
      return Promise.reject(e).then(onOk, onErr)
    }
    if (this.singleMode && !res.error) {
      const rows = (res.data as Row[] | null) ?? []
      if (this.singleMode === 'maybe') res = { data: rows[0] ?? null, error: null }
      else res = rows.length === 1 ? { data: rows[0], error: null } : { data: null, error: { code: 'PGRST116', message: 'no rows' } }
    }
    return Promise.resolve(res).then(onOk, onErr)
  }
}
