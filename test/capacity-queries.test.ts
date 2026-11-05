import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import {
  getCapacityOverview,
  getEngagementAllocations,
  isMissingColumnOrSchema,
  loadAllocationTargets,
  loadTeamCapacity,
} from '@/domain/delivery/queries/capacity'
import { createSupabaseFake, hasOp, opArgs, type QueryCall, type QueryResult } from './helpers/supabaseFake'

// domain/delivery/queries/capacity.ts — čtení před i po migraci 0062
// a popisky cílů bez peněz.

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))

function fake(resolve: (c: QueryCall) => QueryResult) {
  const f = createSupabaseFake({ resolve })
  vi.mocked(createClient).mockResolvedValue(f.client as never)
  return f
}

const selectOf = (c: QueryCall) => String(opArgs(c, 'select')?.[0] ?? '')

beforeEach(() => vi.clearAllMocks())

describe('isMissingColumnOrSchema', () => {
  test('SELECT i zápis přes PostgREST', () => {
    expect(isMissingColumnOrSchema({ code: '42703' })).toBe(true)
    expect(isMissingColumnOrSchema({ code: 'PGRST204' })).toBe(true)
    expect(isMissingColumnOrSchema({ code: '42P01' })).toBe(false)
    expect(isMissingColumnOrSchema(null)).toBe(false)
  })
})

describe('loadTeamCapacity', () => {
  test('se sloupcem: kapacita z DB (numeric jako text i číslo)', async () => {
    const f = fake(() => ({
      data: [
        { id: 'a', full_name: 'Alena', weekly_capacity_hours: '32.5' },
        { id: 'b', full_name: 'Bořek', weekly_capacity_hours: 0 },
      ],
      error: null,
    }))
    const r = await loadTeamCapacity(f.client as never)
    expect(r).toEqual({
      ok: true,
      capacityColumn: true,
      members: [
        { id: 'a', full_name: 'Alena', weekly_capacity_hours: 32.5 },
        { id: 'b', full_name: 'Bořek', weekly_capacity_hours: 0 },
      ],
    })
  })

  test('před 0062 (sloupec chybí) → druhý dotaz bez něj a 40 h pro všechny', async () => {
    const f = fake((c) =>
      selectOf(c).includes('weekly_capacity_hours')
        ? { data: null, error: { code: '42703', message: 'column team_member.weekly_capacity_hours does not exist' } }
        : { data: [{ id: 'a', full_name: 'Alena' }], error: null },
    )
    const r = await loadTeamCapacity(f.client as never)
    expect(r).toEqual({ ok: true, capacityColumn: false, members: [{ id: 'a', full_name: 'Alena', weekly_capacity_hours: 40 }] })
    expect(f.calls).toHaveLength(2)
  })

  test('jiná chyba se nepřebije fallbackem', async () => {
    const f = fake(() => ({ data: null, error: { code: '500', message: 'boom' } }))
    expect(await loadTeamCapacity(f.client as never)).toEqual({ ok: false, message: 'boom' })
    expect(f.calls).toHaveLength(1)
  })
})

describe('loadAllocationTargets', () => {
  test('dodávky (firma · druh) před případy, odkazy a „aktivní"; z dodávky žádné částky', async () => {
    const f = fake((c) =>
      c.table === 'engagement'
        ? {
            data: [
              { id: 3, account_id: 11, kind: 'edu', phase: 'workshopy', account: { name: 'Gamaplast' } },
              { id: 4, account_id: 12, kind: 'it', phase: 'uzavreno', account: { name: 'Alfa' } },
            ],
            error: null,
          }
        : { data: [{ id: 9, title: 'Procesní mapa', status: 'done' }, { id: 8, title: 'Audit', status: 'open' }], error: null },
    )
    const targets = await loadAllocationTargets(f.client as never)
    expect(targets).toEqual([
      { key: 'engagement:4', kind: 'engagement', label: 'Alfa · Akce', href: '/cockpit/clients/12/engagements/4/edit', active: false },
      { key: 'engagement:3', kind: 'engagement', label: 'Gamaplast · Firemní akce', href: '/cockpit/clients/11/engagements/3/edit', active: true },
      { key: 'case:8', kind: 'work_case', label: 'Audit', href: '/cockpit/pripady/8', active: true },
      { key: 'case:9', kind: 'work_case', label: 'Procesní mapa', href: '/cockpit/pripady/9', active: false },
    ])
    const engagementSelect = selectOf(f.calls.find((c) => c.table === 'engagement')!)
    expect(engagementSelect).not.toMatch(/roi|czk|amount|\*/i)
  })

  test('chybějící work_case (neúplná DB) → jen dodávky', async () => {
    const f = fake((c) =>
      c.table === 'engagement'
        ? { data: [{ id: 3, account_id: 11, kind: 'edu', phase: 'pilot', account: null }], error: null }
        : { data: null, error: { code: '42P01', message: 'x' } },
    )
    expect((await loadAllocationTargets(f.client as never)).map((t) => t.label)).toEqual(['Dodávka · Firemní akce'])
  })
})

describe('getCapacityOverview / getEngagementAllocations', () => {
  const OPTS = { from: '2026-09-28', today: '2026-09-30' }

  test('před 0062 (allocation chybí) → missing_migration', async () => {
    fake(() => ({ data: null, error: { code: 'PGRST205', message: 'x' } }))
    expect(await getCapacityOverview(OPTS)).toEqual({ state: 'missing_migration' })
    expect(await getEngagementAllocations(3)).toEqual({ state: 'missing_migration' })
  })

  test('po 0062: alokace převedené na čísla, tým a cíle', async () => {
    fake((c) => {
      if (c.table === 'allocation') {
        return {
          data: [{ id: '1', member_id: 'a', engagement_id: '3', work_case_id: null, hours_per_week: '12.5', starts_on: '2026-10-01', ends_on: null, substitute_id: null, note: null, created_at: '2026-09-28T10:00:00Z' }],
          error: null,
        }
      }
      if (c.table === 'team_member') return { data: [{ id: 'a', full_name: 'Alena', weekly_capacity_hours: 40 }], error: null }
      return { data: [], error: null }
    })
    const r = await getCapacityOverview(OPTS)
    expect(r.state).toBe('ok')
    if (r.state === 'ok') {
      expect(r.allocations[0]).toMatchObject({ id: 1, engagement_id: 3, work_case_id: null, hours_per_week: 12.5 })
      expect(r.members).toHaveLength(1)
      expect(r.capacityColumn).toBe(true)
    }
  })

  test('čte jen alokace platné od začátku plánu; skončené jen na požádání a s limitem', async () => {
    const f = fake(() => ({ data: [], error: null }))
    await getCapacityOverview(OPTS)
    const allocCalls = f.calls.filter((c) => c.table === 'allocation')
    expect(opArgs(allocCalls[0], 'or')).toEqual(['ends_on.is.null,ends_on.gte.2026-09-28'])
    // Bez includeEnded: jen hlavní dotaz + počet skončených (head).
    expect(allocCalls).toHaveLength(2)
    expect(opArgs(allocCalls[1], 'lt')).toEqual(['ends_on', '2026-09-30'])

    const g = fake(() => ({ data: [], error: null }))
    await getCapacityOverview({ ...OPTS, includeEnded: true })
    const ended = g.calls.filter((c) => c.table === 'allocation' && hasOp(c, 'limit'))
    expect(ended).toHaveLength(1)
    expect(opArgs(ended[0], 'lt')).toEqual(['ends_on', '2026-09-28'])
  })

  test('popisek pro starší případ mimo nabídku se dočte podle id', async () => {
    const f = fake((c) => {
      if (c.table === 'allocation' && hasOp(c, 'or')) {
        return {
          data: [{ id: 1, member_id: 'a', engagement_id: null, work_case_id: 77, hours_per_week: 5, starts_on: '2026-09-01', ends_on: null, substitute_id: null, note: null, created_at: 'x' }],
          error: null,
        }
      }
      if (c.table === 'work_case' && hasOp(c, 'in')) return { data: [{ id: 77, title: 'Starý audit', status: 'open' }], error: null }
      if (c.table === 'team_member') return { data: [], error: null }
      return { data: [], error: null }
    })
    const r = await getCapacityOverview(OPTS)
    expect(r.state).toBe('ok')
    if (r.state === 'ok') expect(r.targets.find((t) => t.key === 'case:77')?.label).toBe('Starý audit')
    expect(opArgs(f.calls.find((c) => c.table === 'work_case' && hasOp(c, 'in'))!, 'in')).toEqual(['id', [77]])
  })

  test('alokace dodávky filtruje podle engagement_id', async () => {
    const f = fake(() => ({ data: [], error: null }))
    expect(await getEngagementAllocations(3)).toEqual({ state: 'ok', allocations: [] })
    expect(opArgs(f.calls[0], 'eq')).toEqual(['engagement_id', 3])
  })
})
