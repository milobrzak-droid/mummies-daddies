import { vi } from 'vitest'

// Malý zástupce Supabase klienta pro testy server akcí. Neumí dotazy
// vyhodnocovat, jen si zapisuje řetězec volání (`from(t).delete().eq(...)`)
// a na jeho konci vrátí výsledek, který test určí funkcí `resolve`.
// Builder je thenable, takže `await` funguje na jakémkoli místě řetězce
// (i po maybeSingle/single).

export type QueryResult = { data: unknown; error: unknown; count?: number | null }
export type Op = { method: string; args: unknown[] }
export type QueryCall = { table: string; ops: Op[] }

export const hasOp = (call: QueryCall, method: string): boolean => call.ops.some(o => o.method === method)
export const opArgs = (call: QueryCall, method: string): unknown[] | undefined =>
  call.ops.find(o => o.method === method)?.args

const CHAIN_METHODS = [
  'select', 'insert', 'update', 'upsert', 'delete',
  'eq', 'neq', 'in', 'is', 'contains', 'not', 'or', 'like', 'ilike', 'lt', 'lte', 'gt', 'gte', 'order', 'limit', 'range', 'maybeSingle', 'single',
] as const

export type FakeOptions = {
  resolve?: (call: QueryCall) => QueryResult
  rpc?: (name: string, args: unknown) => QueryResult
  user?: { id: string } | null
}

export function createSupabaseFake(opts: FakeOptions = {}) {
  const calls: QueryCall[] = []
  const resolve = opts.resolve ?? (() => ({ data: null, error: null }))

  const from = vi.fn((table: string) => {
    const call: QueryCall = { table, ops: [] }
    calls.push(call)
    const builder: Record<string, unknown> = {
      then: (onFulfilled: (v: QueryResult) => unknown, onRejected?: (e: unknown) => unknown) =>
        Promise.resolve(resolve(call)).then(onFulfilled, onRejected),
    }
    for (const method of CHAIN_METHODS) {
      builder[method] = (...args: unknown[]) => {
        call.ops.push({ method, args })
        return builder
      }
    }
    return builder
  })

  const rpc = vi.fn(async (name: string, args: unknown): Promise<QueryResult> =>
    opts.rpc ? opts.rpc(name, args) : { data: null, error: null })

  const getUser = vi.fn(async () => ({ data: { user: opts.user === undefined ? { id: 'user-1' } : opts.user } }))

  // Typ výsledku je záměrně `never`-kompatibilní cast na místě použití:
  // test ho předává vi.mocked(createClient).mockResolvedValue(fake.client as never).
  const client = { from, rpc, auth: { getUser } }

  return { client, from, rpc, getUser, calls }
}
