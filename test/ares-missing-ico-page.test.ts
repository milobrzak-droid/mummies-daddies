import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { mapWithConcurrency, runPool } from '@/lib/concurrency'
import { listMissingIcoPage, pageWindow, parsePageParam } from '@/domain/crm/queries/missingIco'
import { createSupabaseFake, hasOp, opArgs, type QueryCall } from './helpers/supabaseFake'

// /clients/doplnit-ico — stránkování, skrytí „nenalezeno" a omezená
// souběžnost dotazů na ARES. Bez DB a bez sítě.

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

describe('stránkování', () => {
  test('?strana=N', () => {
    expect(parsePageParam(undefined)).toBe(1)
    expect(parsePageParam('3')).toBe(3)
    expect(parsePageParam(['2', '5'])).toBe(2)
    expect(parsePageParam('0')).toBe(1)
    expect(parsePageParam('-4')).toBe(1)
    expect(parsePageParam('abc')).toBe(1)
    expect(parsePageParam('1.5')).toBe(1)
  })

  test('okno stránky po 20, příliš vysoká stránka = poslední', () => {
    expect(pageWindow(640, 1, 20)).toEqual({ page: 1, totalPages: 32, from: 0, to: 19 })
    expect(pageWindow(640, 2, 20)).toEqual({ page: 2, totalPages: 32, from: 20, to: 39 })
    expect(pageWindow(45, 99, 20)).toEqual({ page: 3, totalPages: 3, from: 40, to: 59 })
    expect(pageWindow(0, 5, 20)).toEqual({ page: 1, totalPages: 1, from: 0, to: 19 })
  })
})

describe('listMissingIcoPage', () => {
  beforeEach(() => vi.clearAllMocks())

  // Dotazy: [0] počet bez IČO, [1] počet „nenalezeno", [2] stránka řádků.
  function fakeWith(counts: { all: number; notFound: number | 'missing' }) {
    const fake = createSupabaseFake({
      resolve: (c: QueryCall) => {
        const head = (opArgs(c, 'select')?.[1] as { head?: boolean } | undefined)?.head
        if (hasOp(c, 'eq')) {
          if (counts.notFound !== 'missing') return { data: [], error: null, count: counts.notFound } as never
          // Skutečný klient: HEAD nemá tělo → chyba bez kódu. Kód 42703
          // přijde jen u GET.
          return head
            ? { data: null, error: { message: '' } }
            : { data: null, error: { code: '42703', message: 'column account.ares_status does not exist' } }
        }
        if (head) return { data: null, error: null, count: counts.all } as never
        return { data: [{ id: 1, name: 'Acme', ares_status: null, ares_checked_at: null }], error: null }
      },
    })
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    return fake
  }

  test('výchozí stav skryje „nenalezeno", řadí podle jména a id, 20 na stránku', async () => {
    const fake = fakeWith({ all: 640, notFound: 100 })
    const r = await listMissingIcoPage({ page: 2, includeNotFound: false })
    expect(r).toMatchObject({ totalMissing: 640, notFound: 100, shown: 540, page: 2, totalPages: 27, migrationPending: false })
    const rows = fake.calls[2]
    expect(opArgs(rows, 'or')).toEqual(['ares_status.is.null,ares_status.neq.nenalezeno'])
    expect(rows.ops.filter((o) => o.method === 'order').map((o) => o.args[0])).toEqual(['name', 'id'])
    expect(opArgs(rows, 'range')).toEqual([20, 39])
  })

  test('?vse=1 ukáže všechny bez IČO', async () => {
    const fake = fakeWith({ all: 640, notFound: 100 })
    const r = await listMissingIcoPage({ page: 1, includeNotFound: true })
    expect(r.shown).toBe(640)
    expect(hasOp(fake.calls[2], 'or')).toBe(false)
  })

  test('bez migrace 0065 seznam funguje dál, jen bez stavu ověření', async () => {
    const fake = fakeWith({ all: 12, notFound: 'missing' })
    const r = await listMissingIcoPage({ page: 1, includeNotFound: false })
    expect(r).toMatchObject({ migrationPending: true, shown: 12, notFound: 0 })
    expect(opArgs(fake.calls[2], 'select')).toEqual(['id, name'])
    expect(r.rows[0]).toMatchObject({ ares_status: null })
  })
})

describe('omezená souběžnost', () => {
  test('mapWithConcurrency drží pořadí a nejvýš N současně', async () => {
    let inFlight = 0
    let max = 0
    const out = await mapWithConcurrency([5, 1, 4, 2, 3, 6, 7], 3, async (n) => {
      inFlight++
      max = Math.max(max, inFlight)
      await new Promise((r) => setTimeout(r, n))
      inFlight--
      return n * 10
    })
    expect(out).toEqual([50, 10, 40, 20, 30, 60, 70])
    expect(max).toBe(3)
  })

  test('runPool přestane začínat, když canStart vrátí false', async () => {
    const seen: number[] = []
    const { started } = await runPool([1, 2, 3, 4, 5], 1, async (n) => {
      seen.push(n)
    }, () => seen.length < 2)
    expect(started).toBe(2)
    expect(seen).toEqual([1, 2])
  })

  test('prázdný vstup', async () => {
    expect(await mapWithConcurrency([], 4, async () => 1)).toEqual([])
  })
})
