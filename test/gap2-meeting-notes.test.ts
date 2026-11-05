import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { getLastSkillMeetingNoteAt, getRecentMeetings } from '@/domain/crm/queries/meetingNotes'
import { createSupabaseFake, hasOp, opArgs } from './helpers/supabaseFake'

// Wispr Flow "čerstvost": jediný zdroj zápisů schůzek je sales_activity
// s kind='meeting' & source='api' (viz komentář v modulu). Testujeme:
// - poslední zápis z API zdroje (created_at)
// - žádný takový zápis -> null
// - filtrování zdroje (source='api'), ne libovolná schůzka

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

beforeEach(() => vi.clearAllMocks())

describe('getLastSkillMeetingNoteAt', () => {
  test('vrátí created_at posledního api zápisu a filtruje kind=meeting, source=api', async () => {
    const fake = createSupabaseFake({
      resolve: () => ({ data: [{ created_at: '2026-09-28T09:00:00Z' }], error: null }),
    })
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    const result = await getLastSkillMeetingNoteAt()
    expect(result).toBe('2026-09-28T09:00:00Z')
    // Druhý dotaz: zápis, který doplnil naplánovanou schůzku (note_received_at, 0085).
    expect(fake.calls).toHaveLength(2)
    expect(fake.calls[1].ops).toContainEqual({ method: 'not', args: ['note_received_at', 'is', null] })
    const call = fake.calls[0]
    expect(call.table).toBe('sales_activity')
    expect(opArgs(call, 'eq')).toEqual(['kind', 'meeting'])
    // druhé volání eq() je pro source='api' — ops obsahuje obě volání eq v pořadí
    const eqCalls = call.ops.filter((o) => o.method === 'eq')
    expect(eqCalls).toEqual([
      { method: 'eq', args: ['kind', 'meeting'] },
      { method: 'eq', args: ['source', 'api'] },
    ])
    expect(hasOp(call, 'limit')).toBe(true)
    expect(opArgs(call, 'limit')).toEqual([1])
  })

  test('žádný zápis přes skill → null', async () => {
    const fake = createSupabaseFake({ resolve: () => ({ data: [], error: null }) })
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    expect(await getLastSkillMeetingNoteAt()).toBeNull()
  })

  test('data undefined → null (ne pád)', async () => {
    const fake = createSupabaseFake({ resolve: () => ({ data: null, error: null }) })
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    expect(await getLastSkillMeetingNoteAt()).toBeNull()
  })

  test('zápis, který doplnil naplánovanou schůzku, se počítá podle času přijetí', async () => {
    const fake = createSupabaseFake({
      resolve: (call) => (call.ops.some((o) => o.method === 'not')
        ? { data: [{ note_received_at: '2026-09-29T15:00:00Z' }], error: null }
        : { data: [{ created_at: '2026-09-20T09:00:00Z' }], error: null }),
    })
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    expect(await getLastSkillMeetingNoteAt()).toBe('2026-09-29T15:00:00Z')
  })

  test('bez migrace 0085 (sloupec chybí) jen created_at', async () => {
    const fake = createSupabaseFake({
      resolve: (call) => (call.ops.some((o) => o.method === 'not')
        ? { data: null, error: { code: '42703', message: 'column does not exist' } }
        : { data: [{ created_at: '2026-09-20T09:00:00Z' }], error: null }),
    })
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    expect(await getLastSkillMeetingNoteAt()).toBe('2026-09-20T09:00:00Z')
  })

  test('chyba databáze se zabalí do českého hlášení a vyhodí', async () => {
    const fake = createSupabaseFake({ resolve: () => ({ data: null, error: { message: 'boom' } }) })
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    await expect(getLastSkillMeetingNoteAt()).rejects.toThrow(/Načtení posledního zápisu schůzky selhalo: boom/)
  })
})

describe('getRecentMeetings', () => {
  test('řadí podle occurred_at sestupně a respektuje limit', async () => {
    const rows = [{ id: 1, subject: 'A', occurred_at: '2026-09-01', created_at: '2026-09-01', source: 'api', outcome: null, account: null }]
    const fake = createSupabaseFake({ resolve: () => ({ data: rows, error: null }) })
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    const result = await getRecentMeetings(5)
    expect(result).toEqual(rows)
    const call = fake.calls[0]
    expect(call.table).toBe('sales_activity')
    expect(opArgs(call, 'eq')).toEqual(['kind', 'meeting'])
    expect(opArgs(call, 'order')).toEqual(['occurred_at', { ascending: false }])
    expect(opArgs(call, 'limit')).toEqual([5])
  })

  test('výchozí limit je 20', async () => {
    const fake = createSupabaseFake({ resolve: () => ({ data: [], error: null }) })
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    await getRecentMeetings()
    expect(opArgs(fake.calls[0], 'limit')).toEqual([20])
  })

  test('prázdný výsledek → []', async () => {
    const fake = createSupabaseFake({ resolve: () => ({ data: null, error: null }) })
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    expect(await getRecentMeetings()).toEqual([])
  })

  test('chyba databáze vyhodí české hlášení', async () => {
    const fake = createSupabaseFake({ resolve: () => ({ data: null, error: { message: 'x' } }) })
    vi.mocked(createClient).mockResolvedValue(fake.client as never)
    await expect(getRecentMeetings()).rejects.toThrow(/Načtení schůzek selhalo: x/)
  })
})
