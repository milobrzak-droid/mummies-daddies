// Dashboard „Projekty" pro role bez obchodu (0058): skládá se z dodávek
// (engagement) + deal_public (jen název a „vyhráno"), bez částek. Obchodní
// role dál čtou getAllProjects z deal. Tolerance nenasazené 0058.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { createSupabaseFake, type QueryCall, type QueryResult } from './helpers/supabaseFake'

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))

import {
  buildDeliveryProjects, deliveryProjectTitle, getDeliveryProjects, isDeliveryOverdue,
  type DeliveryProjectRow, type EngagementListRow,
} from '@/lib/queries/dashboard'
import { logError } from '@/lib/log'

const ROOT = join(__dirname, '..')

const ENG: EngagementListRow[] = [
  { id: 10, account_id: 1, deal_id: 4, kind: 'edu', phase: 'workshopy', started_on: '2026-09-01', due_on: '2026-09-20', account: { name: 'Alfa' } },
  { id: 11, account_id: 2, deal_id: 7, kind: 'it', phase: 'pilot', started_on: null, due_on: null, account: [{ name: 'Beta' }] },
  { id: 12, account_id: 3, deal_id: null, kind: 'platform', phase: 'uzavreno', started_on: null, due_on: '2026-01-01', account: null },
]
const DEALS = [
  { id: 4, account_id: 1, title: 'Copilot workshopy', is_won: true },
  // obchod 7 patří jiné firmě než dodávka 11 → název se nepřevezme
  { id: 7, account_id: 99, title: 'Cizí obchod', is_won: false },
]

function fake(opts: { engagement?: QueryResult; deal?: QueryResult; rpc?: QueryResult }) {
  const f = createSupabaseFake({
    resolve: (c: QueryCall) =>
      c.table === 'engagement' ? opts.engagement ?? { data: ENG, error: null }
        : c.table === 'deal' ? opts.deal ?? { data: [], error: null }
          : { data: null, error: null },
    rpc: () => opts.rpc ?? { data: DEALS, error: null },
  })
  vi.mocked(createClient).mockResolvedValue(f.client as never)
  return f
}

beforeEach(() => vi.clearAllMocks())

describe('buildDeliveryProjects', () => {
  test('název a „vyhráno" z deal_public jen pro obchod stejné firmy; žádné částky', () => {
    const rows = buildDeliveryProjects(ENG, DEALS)
    expect(rows.map((r) => [r.id, r.deal_title, r.deal_is_won])).toEqual([
      [10, 'Copilot workshopy', true],
      [11, null, false],
      [12, null, false],
    ])
    expect(rows[1].account).toEqual({ id: 2, name: 'Beta' })
    expect(rows[2].account).toBeNull()
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual(
        ['account', 'deal_id', 'deal_is_won', 'deal_title', 'due_on', 'id', 'kind', 'phase', 'started_on'],
      )
    }
  })

  test('titulek: obchod, jinak druh dodávky + firma', () => {
    const [a, b, c] = buildDeliveryProjects(ENG, DEALS)
    expect(deliveryProjectTitle(a)).toBe('Copilot workshopy')
    expect(deliveryProjectTitle(b)).toBe('Akce · Beta')
    expect(deliveryProjectTitle(c)).toBe('Pravidelný catering')
  })

  test('po termínu jen neuzavřená dodávka s due_on před dneškem', () => {
    const [a, b, c] = buildDeliveryProjects(ENG, DEALS)
    expect(isDeliveryOverdue(a, '2026-09-28')).toBe(true)
    expect(isDeliveryOverdue(a, '2026-09-20')).toBe(false)
    expect(isDeliveryOverdue(b, '2026-09-28')).toBe(false)
    expect(isDeliveryOverdue(c as DeliveryProjectRow, '2026-09-28')).toBe(false)
  })
})

describe('getDeliveryProjects', () => {
  test('čte engagement + rpc deal_public(null); na tabulku deal nesahá', async () => {
    const f = fake({})
    const rows = await getDeliveryProjects()
    expect(rows).toHaveLength(3)
    expect(rows[0].deal_title).toBe('Copilot workshopy')
    expect(f.rpc).toHaveBeenCalledWith('deal_public', { p_account_id: null })
    expect(f.calls.map((c) => c.table)).toEqual(['engagement'])
    const sel = f.calls[0].ops.find((o) => o.method === 'select')!.args[0] as string
    expect(sel).not.toMatch(/amount|cogs|mrr|deal\(/)
  })

  test('0058 nenasazená (PGRST202) → názvy z přímého čtení deal', async () => {
    const f = fake({
      rpc: { data: null, error: { code: 'PGRST202', message: 'Could not find the function' } },
      deal: { data: [{ id: 4, account_id: 1, title: 'Z tabulky', stage: 'vyhráno' }], error: null },
    })
    const rows = await getDeliveryProjects()
    expect(rows[0]).toMatchObject({ deal_title: 'Z tabulky', deal_is_won: true })
    expect(f.calls.find((c) => c.table === 'deal')!.ops.find((o) => o.method === 'select')!.args[0])
      .toBe('id, account_id, title, stage')
  })

  test('deal_public selže (např. 42501) → dodávky bez názvů obchodů, stránka nepadá', async () => {
    fake({ rpc: { data: null, error: { code: '42501', message: 'AAL2' } } })
    const rows = await getDeliveryProjects()
    expect(rows).toHaveLength(3)
    expect(rows.every((r) => r.deal_title === null)).toBe(true)
    expect(logError).toHaveBeenCalled()
  })

  test('chyba čtení dodávek se vyhodí (error boundary)', async () => {
    fake({ engagement: { data: null, error: { code: 'XX000', message: 'boom' } } })
    await expect(getDeliveryProjects()).rejects.toMatchObject({ code: 'XX000' })
  })
})

describe('dashboard page: role bez obchodu nečtou deal', () => {
  const src = readFileSync(join(ROOT, 'app/cockpit/page.tsx'), 'utf8')

  test('větev !canSeeByznys vrací DeliveryOverview dřív, než se volá getAllProjects/getSalesDeals', () => {
    const branch = src.indexOf('if (!canSeeByznys)')
    expect(branch).toBeGreaterThan(0)
    expect(src.indexOf('getDeliveryProjects()')).toBeGreaterThan(branch)
    expect(src.indexOf('getSalesDeals()')).toBeGreaterThan(branch)
    // Obchodní dotazy (getAllProjects se na obrazovce Dnes už nepoužívá, obchody
    // dodává getSalesDeals) se smí volat jen za větví pro role bez obchodu.
    for (const call of ['getAllProjects()', 'getSalesActivities(', 'getMeetingsOnDay(', 'getContractedOverTime()']) {
      const at = src.indexOf(call)
      if (at !== -1) expect(at, call).toBeGreaterThan(branch)
    }
  })

  test('import nabídky (zakládá obchod s částkami) jen obchodním rolím', () => {
    expect(src).toMatch(/\{canSeeByznys && \(\s*<Link\s+href="\/cockpit\/nabidka\/import"/)
  })

  test('DeliveryOverview nezobrazuje částky', () => {
    const comp = readFileSync(join(ROOT, 'components/DeliveryOverview.tsx'), 'utf8')
    expect(comp).not.toMatch(/formatCzk|amount_|cogs|margin|Marže/)
  })
})
