import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { getDeliveryPortfolio } from '@/domain/delivery/queries/portfolio'
import { getWaitingItems } from '@/domain/delivery/queries/waiting'
import { createSupabaseFake, hasOp, opArgs, type QueryCall, type QueryResult } from './helpers/supabaseFake'

// Čtení portfolia dodávek nad zamockovaným Supabase: skládá dodávky s milníky,
// úkoly, kapacitou, nabídkou a dopadem; nabídku čte jen obchodní role;
// vedlejší zdroje smí selhat bez pádu a stránka se o nich dozví.

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('@/domain/delivery/queries/waiting', () => ({
  getWaitingItems: vi.fn(async () => ({
    state: 'ok',
    items: [{ milestoneId: 2, daysWaiting: 9 }],
  })),
}))

const ME = '00000000-0000-4000-8000-000000000001'
const TODAY = '2026-09-29'

const ENGAGEMENT = {
  id: 3, account_id: 1, deal_id: 9, kind: 'it', phase: 'pilot', started_on: '2026-09-01', due_on: '2026-11-06',
  owner_id: ME, deputy_id: null, updated_at: '2026-09-28T09:00:00Z', reference_worthy: false,
  goal: 'Zrychlit zpracování', scope: 'Rozsah z předání', handoff_completed_at: '2026-09-05T08:00:00Z',
  account: { name: 'ALFATECH' },
}

type Route = (c: QueryCall) => QueryResult | undefined
function setup(...routes: Route[]) {
  const fake = createSupabaseFake({
    resolve: (call) => {
      for (const r of routes) {
        const out = r(call)
        if (out) return out
      }
      return { data: [], error: null }
    },
    rpc: (name) => (name === 'deal_public'
      ? { data: [{ id: 9, account_id: 1, title: 'Pilot: zpracování objednávek', is_won: true }], error: null }
      : { data: null, error: null }),
  })
  vi.mocked(createClient).mockResolvedValue(fake.client as never)
  return fake
}
const table = (name: string, result: QueryResult): Route => (c) => (c.table === name ? result : undefined)
const missing = { code: '42P01', message: 'relation does not exist' }

const base = (): Route[] => [
  table('engagement', { data: [ENGAGEMENT], error: null }),
  table('engagement_milestone', {
    data: [
      { id: 1, engagement_id: 3, title: 'Workshop', owner_id: ME, deputy_id: null, status: 'prijato', due_on: '2026-09-11', accepted_at: '2026-09-10T10:00:00Z', updated_at: '2026-09-10T10:00:00Z' },
      { id: 2, engagement_id: 3, title: 'Procesní mapa', owner_id: ME, deputy_id: null, status: 'ceka_na_schvaleni', due_on: '2026-10-03', accepted_at: null, updated_at: '2026-09-20T10:00:00Z' },
    ],
    error: null,
  }),
  table('task', { data: [{ engagement_id: 3, status: 'blocked', updated_at: '2026-09-28T09:00:00Z' }], error: null }),
  table('allocation', {
    data: [{ id: 1, member_id: ME, engagement_id: 3, work_case_id: null, hours_per_week: 46, starts_on: '2026-09-01', ends_on: null, substitute_id: null, note: null, created_at: '' }],
    error: null,
  }),
  table('team_member', { data: [{ id: ME, full_name: 'Viktor Kovář', weekly_capacity_hours: 40 }], error: null }),
  table('deal_scope_version', { data: [{ deal_id: 9, version: 2, scope: 'Workshop a procesní mapa', decided_at: '2026-09-12T08:00:00Z' }], error: null }),
  table('metric_observation', { data: [{ id: 1, engagement_id: 3, metric: 'Doba zpracování', unit: 'min', baseline: '18', actual: '4', observed_on: '2026-09-28' }], error: null }),
  table('reference_card', { data: [{ engagement_id: 3, approved_public: true, consent_evidence_id: 5, consent_at: '2026-09-25T08:00:00Z' }], error: null }),
]

beforeEach(() => vi.clearAllMocks())

describe('getDeliveryPortfolio', () => {
  test('složí dodávku ze všech zdrojů a nic nezapíše', async () => {
    const fake = setup(...base())
    const res = await getDeliveryPortfolio({ today: TODAY, canSeeSales: true })
    expect(res.state).toBe('ok')
    if (res.state !== 'ok') return
    expect(res.unavailable).toEqual([])
    expect(res.items).toHaveLength(1)
    const i = res.items[0]
    expect(i).toMatchObject({
      accountName: 'ALFATECH', title: 'Pilot: zpracování objednávek', ownerName: 'Viktor Kovář',
      flags: { late: false, blocked: true, waitingClient: true, stale: false },
    })
    expect(i.promised).toMatchObject({ source: 'offer', text: 'Workshop a procesní mapa' })
    expect(i.capacity).toEqual({ load: 46, capacity: 40, overloaded: true })
    expect(i.progress).toMatchObject({ total: 2, accepted: 1 })
    expect(i.impact).toMatchObject({ baseline: 18, actual: 4 })
    expect(i.reference).toBe('consent')
    // doba čekání jde z auditu (hlídání čekání), ne z updated_at
    expect(i.leadership.some((t) => t.includes('čeká 9 dní'))).toBe(true)
    expect(fake.calls.every((c) => !hasOp(c, 'insert') && !hasOp(c, 'update') && !hasOp(c, 'delete') && !hasOp(c, 'upsert'))).toBe(true)
  })

  test('jen běžící dodávky a milníky jen jejich', async () => {
    const fake = setup(...base())
    await getDeliveryPortfolio({ today: TODAY, canSeeSales: true })
    const e = fake.calls.find((c) => c.table === 'engagement')!
    expect(opArgs(e, 'neq')).toEqual(['phase', 'uzavreno'])
    const m = fake.calls.find((c) => c.table === 'engagement_milestone')!
    expect(opArgs(m, 'in')).toEqual(['engagement_id', [3]])
    const t = fake.calls.find((c) => c.table === 'task')!
    expect(opArgs(t, 'neq')).toEqual(['status', 'done'])
  })

  test('service role (cron): předaný klient, názvy obchodů přímo z tabulky deal, bez rpc deal_public', async () => {
    const own = createSupabaseFake({
      resolve: (c) => {
        if (c.table === 'deal') return { data: [{ id: 9, account_id: 1, title: 'Pilot: zpracování objednávek' }], error: null }
        for (const r of base()) {
          const out = r(c)
          if (out) return out
        }
        return { data: [], error: null }
      },
      rpc: () => ({ data: null, error: { code: '42501', message: 'Nepřihlášený uživatel' } }),
    })
    const res = await getDeliveryPortfolio({ today: TODAY, canSeeSales: true, db: own.client as never, asService: true })
    expect(createClient).not.toHaveBeenCalled()
    expect(own.rpc).not.toHaveBeenCalled()
    const deal = own.calls.find((c) => c.table === 'deal')!
    expect(opArgs(deal, 'select')).toEqual(['id, account_id, title'])
    if (res.state !== 'ok') throw new Error('čekal jsem ok')
    expect(res.unavailable).toEqual([])
    expect(res.items[0].title).toBe('Pilot: zpracování objednávek')
    const { getWaitingItems } = await import('@/domain/delivery/queries/waiting')
    expect(vi.mocked(getWaitingItems)).toHaveBeenCalledWith({ today: TODAY, db: own.client })
  })

  test('role bez obchodu: přijatá nabídka se vůbec nečte, rozsah je z předávacího balíčku', async () => {
    const fake = setup(...base())
    const res = await getDeliveryPortfolio({ today: TODAY, canSeeSales: false })
    expect(fake.calls.some((c) => c.table === 'deal_scope_version')).toBe(false)
    if (res.state !== 'ok') throw new Error('čekal jsem ok')
    expect(res.unavailable).toEqual([])
    expect(res.items[0].promised).toMatchObject({ source: 'handoff', text: 'Rozsah z předání' })
  })

  test('hlavní dotaz selže: chyba, žádné další dotazy', async () => {
    const fake = setup(table('engagement', { data: null, error: { code: 'XX000', message: 'boom' } }))
    expect(await getDeliveryPortfolio({ today: TODAY, canSeeSales: true })).toEqual({ state: 'error', message: 'boom' })
    expect(fake.calls).toHaveLength(1)
  })

  test('žádná běžící dodávka: prázdné portfolio bez dalších dotazů', async () => {
    const fake = setup(table('engagement', { data: [], error: null }))
    expect(await getDeliveryPortfolio({ today: TODAY, canSeeSales: true })).toEqual({ state: 'ok', items: [], unavailable: [] })
    expect(fake.calls).toHaveLength(1)
  })

  test('vedlejší zdroje smí chybět: portfolio se ukáže a řekne, co se nenačetlo', async () => {
    setup(
      table('engagement_milestone', { data: null, error: missing }),
      table('allocation', { data: null, error: missing }),
      table('metric_observation', { data: null, error: missing }),
      table('deal_scope_version', { data: null, error: missing }),
      ...base(),
    )
    const res = await getDeliveryPortfolio({ today: TODAY, canSeeSales: true })
    if (res.state !== 'ok') throw new Error('čekal jsem ok')
    expect([...res.unavailable].sort()).toEqual(['kapacity', 'milníky', 'měření', 'nabídky'])
    expect(res.items).toHaveLength(1)
    expect(res.items[0].capacity).toBeNull()
    expect(res.items[0].promised.source).toBe('handoff')
  })

  test('reference před 0061 (chybí sloupce souhlasu): souhlas se nepočítá jako doložený', async () => {
    setup(
      (c) => (c.table === 'reference_card'
        ? String(opArgs(c, 'select')?.[0]).includes('consent_at')
          ? { data: null, error: { code: '42703', message: 'column reference_card.consent_at does not exist' } }
          : { data: [{ engagement_id: 3, approved_public: true }], error: null }
        : undefined),
      ...base(),
    )
    const res = await getDeliveryPortfolio({ today: TODAY, canSeeSales: true })
    if (res.state !== 'ok') throw new Error('čekal jsem ok')
    expect(res.unavailable).toEqual([])
    expect(res.items[0].reference).toBe('pending')
  })

  test('servisní klient (API/MCP): čte se jím, názvy obchodů z tabulky místo rpc, bez částek', async () => {
    const fake = setup(
      table('deal', { data: [{ id: 9, account_id: 1, title: 'Pilot: zpracování objednávek', stage: 'vyhráno' }], error: null }),
      ...base(),
    )
    vi.mocked(createClient).mockClear()
    const res = await getDeliveryPortfolio({ today: TODAY, canSeeSales: false, db: fake.client as never, asService: true })
    if (res.state !== 'ok') throw new Error('čekal jsem ok')
    expect(createClient).not.toHaveBeenCalled()
    // deal_public bez přihlášeného uživatele odmítne — servisní klient ho nevolá.
    expect(fake.rpc).not.toHaveBeenCalled()
    expect(res.unavailable).toEqual([])
    expect(res.items[0]).toMatchObject({ title: 'Pilot: zpracování objednávek', dealId: 9 })
    const deal = fake.calls.find((c) => c.table === 'deal')!
    expect(opArgs(deal, 'select')).toEqual(['id, account_id, title'])
    expect(fake.calls.some((c) => c.table === 'deal_scope_version')).toBe(false)
    expect(vi.mocked(getWaitingItems)).toHaveBeenCalledWith({ today: TODAY, db: fake.client })
  })

  test('sloupce předání a vlastníka ještě nejsou: dodávka se ukáže bez nich', async () => {
    const { goal: _g, scope: _s, handoff_completed_at: _h, owner_id: _o, deputy_id: _d, ...old } = ENGAGEMENT
    void _g; void _s; void _h; void _o; void _d
    setup(table('engagement', { data: [old], error: null }), ...base())
    const res = await getDeliveryPortfolio({ today: TODAY, canSeeSales: false })
    if (res.state !== 'ok') throw new Error('čekal jsem ok')
    expect(res.items[0].ownerId).toBeNull()
    expect(res.items[0].leadership).toContain('Určit vlastníka dodávky.')
    expect(res.items[0].leadership).not.toContain('Dokončit předání do realizace.')
  })
})
