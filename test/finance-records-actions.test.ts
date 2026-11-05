import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { tryRequireUser } from '@/lib/auth/requireUser'
import { getCurrentMember } from '@/lib/queries/currentMember'
import {
  cancelFinancialRecord,
  createFinancialRecord,
  createMilestoneInvoiceDraft,
  updateFinancialRecord,
} from '@/domain/finance/actions/records'
import { createSupabaseFake, hasOp, opArgs, type QueryCall, type QueryResult } from './helpers/supabaseFake'

// domain/finance/actions/records.ts (0063): AAL2 brána, jen obchodní role,
// podklad k fakturaci jen z přijatého milníku a idempotentně.

vi.mock('@/lib/auth/requireUser', () => ({ requireUser: vi.fn(), tryRequireUser: vi.fn(), AUTH_ERROR_MESSAGE: 'auth' }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/queries/currentMember', () => ({
  getCurrentMember: vi.fn(),
  memberSeesSales: (m: { role?: string } | null) => m?.role === 'vedeni' || m?.role === 'obchodnik',
}))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(tryRequireUser).mockResolvedValue({ id: 'u1' } as never)
  vi.mocked(getCurrentMember).mockResolvedValue({ user: { id: 'u1' }, member: { role: 'obchodnik' } } as never)
})

function fd(e: Record<string, string>): FormData {
  const f = new FormData()
  for (const [k, v] of Object.entries(e)) f.append(k, v)
  return f
}
function fake(resolve: (c: QueryCall) => QueryResult | undefined) {
  const f = createSupabaseFake({ resolve: (c) => resolve(c) ?? { data: null, error: null } })
  vi.mocked(createClient).mockResolvedValue(f.client as never)
  return f
}
const inserts = (f: ReturnType<typeof fake>) => f.calls.filter((c) => c.table === 'financial_record' && hasOp(c, 'insert'))
const VALID = { account_id: '1', kind: 'potential', amount: '1000', currency: 'CZK', period_month: '2026-09', status: 'draft', source: 'rucne' }

describe('brány', () => {
  test('bez AAL2 uživatele nic', async () => {
    vi.mocked(tryRequireUser).mockResolvedValue(null)
    const f = fake(() => undefined)
    expect(await createFinancialRecord(null, fd(VALID))).toEqual({ success: false, error: 'auth' })
    expect(await cancelFinancialRecord(1)).toEqual({ success: false, error: 'auth' })
    expect(await updateFinancialRecord(1, null, fd({}))).toEqual({ success: false, error: 'auth' })
    expect(await createMilestoneInvoiceDraft(1, 2, 3, null, fd({}))).toEqual({ success: false, error: 'auth' })
    expect(f.calls).toHaveLength(0)
  })

  test('neobchodní role nezapisuje', async () => {
    vi.mocked(getCurrentMember).mockResolvedValue({ user: { id: 'u1' }, member: { role: 'projektak' } } as never)
    const f = fake(() => undefined)
    const r = await createFinancialRecord(null, fd(VALID))
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/přístupem k obchodu/)
    expect(inserts(f)).toHaveLength(0)
  })
})

describe('createFinancialRecord', () => {
  test('uloží záznam s prvním dnem měsíce', async () => {
    const f = fake(() => undefined)
    expect(await createFinancialRecord(null, fd(VALID))).toEqual({ success: true })
    const row = opArgs(inserts(f)[0], 'insert')?.[0] as Record<string, unknown>
    expect(row).toMatchObject({ account_id: 1, kind: 'potential', amount: 1000, period_month: '2026-09-01', source: 'rucne' })
  })

  test('obchod cizí firmy odmítne', async () => {
    const f = fake((c) => (c.table === 'deal' ? { data: { account_id: 9 }, error: null } : undefined))
    const r = await createFinancialRecord(null, fd({ ...VALID, deal_id: '4' }))
    expect(r.fieldErrors?.deal_id).toBeTruthy()
    expect(inserts(f)).toHaveLength(0)
  })

  test('chybějící tabulka = klidná hláška', async () => {
    fake((c) => (hasOp(c, 'insert') ? { data: null, error: { code: '42P01' } } : undefined))
    const r = await createFinancialRecord(null, fd(VALID))
    expect(r.error).toMatch(/0063/)
  })
})

describe('update a cancel', () => {
  test('zrušený záznam se nemění', async () => {
    fake((c) => (c.table === 'financial_record' && !hasOp(c, 'update') ? { data: { id: 1, account_id: 1, kind: 'potential', status: 'cancelled' }, error: null } : undefined))
    const r = await updateFinancialRecord(1, null, fd({ amount: '5', currency: 'CZK', period_month: '2026-09', status: 'draft' }))
    expect(r.error).toMatch(/Zrušený/)
  })

  test('potvrzení faktury bez čísla dokladu odmítne', async () => {
    fake((c) => (c.table === 'financial_record' && !hasOp(c, 'update') ? { data: { id: 1, account_id: 1, kind: 'invoiced', status: 'draft' }, error: null } : undefined))
    const r = await updateFinancialRecord(1, null, fd({ amount: '5', currency: 'CZK', period_month: '2026-09', status: 'confirmed' }))
    expect(r.fieldErrors?.external_ref).toBeTruthy()
  })

  test('cancel nastaví status cancelled, nemaže', async () => {
    const f = fake((c) => (c.table === 'financial_record' && !hasOp(c, 'update') ? { data: { id: 1, account_id: 1, kind: 'potential', status: 'draft' }, error: null } : undefined))
    expect(await cancelFinancialRecord(1)).toEqual({ success: true })
    const upd = f.calls.find((c) => hasOp(c, 'update'))!
    expect(opArgs(upd, 'update')?.[0]).toEqual({ status: 'cancelled' })
    expect(f.calls.some((c) => hasOp(c, 'delete'))).toBe(false)
  })
})

describe('createMilestoneInvoiceDraft', () => {
  const eng = (c: QueryCall) => (c.table === 'engagement' ? { data: { id: 2, account_id: 1, deal_id: 8 }, error: null } : undefined)
  const ms = (status: string) => (c: QueryCall) =>
    c.table === 'engagement_milestone'
      ? { data: { id: 3, status, accepted_at: status === 'prijato' ? '2026-09-15T10:00:00Z' : null, acceptance_evidence_id: 77 }, error: null }
      : undefined
  const route = (...rs: ((c: QueryCall) => QueryResult | undefined)[]) => (c: QueryCall) => {
    for (const r of rs) { const o = r(c); if (o) return o }
    return undefined
  }

  test('nepřijatý milník → odmítnuto', async () => {
    const f = fake(route(eng, ms('ceka_na_schvaleni')))
    const r = await createMilestoneInvoiceDraft(1, 2, 3, null, fd({ amount: '5000', currency: 'CZK' }))
    expect(r.error).toMatch(/přijatého milníku/)
    expect(inserts(f)).toHaveLength(0)
  })

  test('přijatý milník → návrh invoiced z milníku', async () => {
    const f = fake(route(eng, ms('prijato'), (c) => (c.table === 'financial_record' && !hasOp(c, 'insert') ? { data: [], error: null } : undefined)))
    expect(await createMilestoneInvoiceDraft(1, 2, 3, null, fd({ amount: '5000', currency: 'EUR' }))).toEqual({ success: true })
    const row = opArgs(inserts(f)[0], 'insert')?.[0]
    expect(row).toMatchObject({
      account_id: 1, deal_id: 8, engagement_id: 2, milestone_id: 3, kind: 'invoiced', status: 'draft',
      source: 'milnik', amount: 5000, currency: 'EUR', period_month: '2026-09-01', evidence_id: 77,
    })
  })

  test('idempotence: existující podklad → žádný další insert', async () => {
    const f = fake(route(eng, ms('prijato'), (c) => (c.table === 'financial_record' && !hasOp(c, 'insert') ? { data: [{ id: 50 }], error: null } : undefined)))
    expect(await createMilestoneInvoiceDraft(1, 2, 3, null, fd({ amount: '5000', currency: 'CZK' }))).toEqual({ success: true })
    expect(inserts(f)).toHaveLength(0)
  })

  test('souběh (23505) je úspěch', async () => {
    fake(route(eng, ms('prijato'), (c) =>
      c.table === 'financial_record' ? (hasOp(c, 'insert') ? { data: null, error: { code: '23505' } } : { data: [], error: null }) : undefined))
    expect(await createMilestoneInvoiceDraft(1, 2, 3, null, fd({ amount: '5000', currency: 'CZK' }))).toEqual({ success: true })
  })

  test('dodávka jiné firmy → nenalezena', async () => {
    fake(route((c) => (c.table === 'engagement' ? { data: { id: 2, account_id: 99, deal_id: null }, error: null } : undefined)))
    const r = await createMilestoneInvoiceDraft(1, 2, 3, null, fd({ amount: '5000', currency: 'CZK' }))
    expect(r.error).toMatch(/Dodávka/)
  })
})
