import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { tryRequireUser } from '@/lib/auth/requireUser'
import { getCurrentMember } from '@/lib/queries/currentMember'
import { recordAudit } from '@/core/audit'
import { czkPerEur } from '@/connectors/cnb'
import {
  acceptScopeVersion,
  createScopeVersion,
  rejectScopeVersion,
  sendScopeVersion,
} from '@/domain/crm/actions/scopeVersions'
import { createSupabaseFake, hasOp, opArgs, type QueryCall, type QueryResult } from './helpers/supabaseFake'

// domain/crm/actions/scopeVersions.ts — verze nabídky (0072). Hlídáme:
// AAL2 + obchodní roli, číslování, přechody s optimistickým zámkem, přijetí
// přes RPC (kurz u EUR) + audit human_confirmed, klidnou hlášku před migrací.

vi.mock('@/lib/auth/requireUser', () => ({ tryRequireUser: vi.fn(), AUTH_ERROR_MESSAGE: 'auth' }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/queries/currentMember', () => ({
  getCurrentMember: vi.fn(),
  memberSeesSales: (m: { role?: string } | null) => m?.role === 'vedeni' || m?.role === 'obchodnik',
}))
vi.mock('@/core/audit', () => ({ recordAudit: vi.fn() }))
vi.mock('@/connectors/cnb', () => ({ czkPerEur: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

const USER = { id: '00000000-0000-4000-8000-000000000001' }
const VERSION = {
  id: 9, deal_id: 5, version: 2, scope: 'Rozsah', amount_one_time: '1000', expected_mrr: '0',
  currency: 'CZK', status: 'sent', sent_at: '2026-09-01', decided_at: null, evidence_id: 44,
  created_by: USER.id, created_at: '2026-09-01',
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(tryRequireUser).mockResolvedValue(USER as never)
  vi.mocked(getCurrentMember).mockResolvedValue({ member: { role: 'obchodnik' } } as never)
})

function fd(entries: Record<string, string> = {}): FormData {
  const f = new FormData()
  for (const [k, v] of Object.entries(entries)) f.append(k, v)
  return f
}

function setup(route: (call: QueryCall) => QueryResult | undefined, rpc?: (n: string, a: unknown) => QueryResult) {
  const fake = createSupabaseFake({ resolve: (c) => route(c) ?? { data: null, error: null }, rpc })
  vi.mocked(createClient).mockResolvedValue(fake.client as never)
  return fake
}

describe('brány', () => {
  test('bez AAL2 nic nečte', async () => {
    vi.mocked(tryRequireUser).mockResolvedValue(null as never)
    const fake = setup(() => undefined)
    expect(await sendScopeVersion(1, 5, 9)).toEqual({ success: false, error: 'auth' })
    expect(fake.from).not.toHaveBeenCalled()
  })

  test('ne-obchodní role dostane srozumitelnou větu', async () => {
    vi.mocked(getCurrentMember).mockResolvedValue({ member: { role: 'projektak' } } as never)
    const fake = setup(() => undefined)
    const r = await acceptScopeVersion(1, 5, 9)
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/přístupem k obchodu/)
    expect(fake.rpc).not.toHaveBeenCalled()
  })
})

describe('createScopeVersion', () => {
  const form = { scope: 'Nový rozsah', amount_one_time: '5000', expected_mrr: '100', currency: 'CZK' }

  test('založí koncept s dalším číslem', async () => {
    const fake = setup((c) => {
      if (c.table === 'deal') return { data: { id: 5 }, error: null }
      if (c.table === 'deal_scope_version' && hasOp(c, 'select')) return { data: [{ version: 1 }, { version: 3 }], error: null }
    })
    expect(await createScopeVersion(1, 5, null, fd(form))).toEqual({ success: true })
    const insert = fake.calls.find((c) => hasOp(c, 'insert'))!
    expect(opArgs(insert, 'insert')?.[0]).toEqual({
      deal_id: 5, version: 4, status: 'draft', scope: 'Nový rozsah', amount_one_time: 5000, expected_mrr: 100, currency: 'CZK',
    })
  })

  test('chyby formuláře', async () => {
    setup(() => undefined)
    const r = await createScopeVersion(1, 5, null, fd({ ...form, scope: '' }))
    expect(r.fieldErrors?.scope).toBeTruthy()
  })

  test('obchod jiné firmy', async () => {
    setup((c) => (c.table === 'deal' ? { data: null, error: null } : undefined))
    expect((await createScopeVersion(1, 5, null, fd(form))).error).toMatch(/Obchod nebyl nalezen/)
  })

  test('před migrací klidná hláška', async () => {
    setup((c) => {
      if (c.table === 'deal') return { data: { id: 5 }, error: null }
      return { data: null, error: { code: 'PGRST205', message: 'x' } }
    })
    expect((await createScopeVersion(1, 5, null, fd(form))).error).toMatch(/migraci 0072/)
  })
})

describe('odeslání / odmítnutí', () => {
  test('odeslání konceptu se zámkem na stav a auditem', async () => {
    const fake = setup((c) => {
      if (c.table !== 'deal_scope_version') return undefined
      if (hasOp(c, 'update')) return { data: [{ id: 9 }], error: null }
      return { data: { ...VERSION, status: 'draft' }, error: null }
    })
    expect(await sendScopeVersion(1, 5, 9)).toEqual({ success: true })
    const upd = fake.calls.find((c) => hasOp(c, 'update'))!
    expect(opArgs(upd, 'update')?.[0]).toEqual({ status: 'sent' })
    expect(upd.ops.filter((o) => o.method === 'eq').map((o) => o.args)).toContainEqual(['status', 'draft'])
    expect(vi.mocked(recordAudit).mock.calls[0][2]).toBe('deal.scope_version_sent')
    expect(vi.mocked(recordAudit).mock.calls[0][6]).toEqual({ infoState: 'human_confirmed' })
  })

  test('nepovolený přechod se ani nepokusí zapsat', async () => {
    const fake = setup((c) => (c.table === 'deal_scope_version' ? { data: { ...VERSION, status: 'accepted' }, error: null } : undefined))
    expect((await rejectScopeVersion(1, 5, 9)).error).toMatch(/změnila stav/)
    expect(fake.calls.some((c) => hasOp(c, 'update'))).toBe(false)
  })

  test('souběžná změna (0 řádků) = stale', async () => {
    setup((c) => {
      if (c.table !== 'deal_scope_version') return undefined
      if (hasOp(c, 'update')) return { data: [], error: null }
      return { data: VERSION, error: null }
    })
    expect((await rejectScopeVersion(1, 5, 9)).error).toMatch(/změnila stav/)
    expect(recordAudit).not.toHaveBeenCalled()
  })
})

describe('acceptScopeVersion', () => {
  const deal = { stage: 'rozhodování', currency: 'CZK', amount_one_time: 800, amount_one_time_original: null, fx_rate: null }

  test('CZK: RPC bez kurzu, audit s evidencí a human_confirmed', async () => {
    const fake = setup(
      (c) => (c.table === 'deal' ? { data: deal, error: null } : { data: VERSION, error: null }),
      () => ({ data: { before: { amount_one_time: 800 }, after: { amount_one_time: 1000 }, superseded_versions: [1] }, error: null }),
    )
    expect(await acceptScopeVersion(1, 5, 9)).toEqual({ success: true })
    expect(fake.rpc).toHaveBeenCalledWith('accept_deal_scope_version', { p_deal_id: 5, p_version_id: 9, p_fx_rate: null })
    const [table, id, action, , after, actor, prov] = vi.mocked(recordAudit).mock.calls[0]
    expect([table, id, action]).toEqual(['deal', 5, 'deal.scope_version_accepted'])
    expect(after).toMatchObject({ status: 'accepted', superseded_versions: [1] })
    expect(actor).toEqual({ type: 'user', id: USER.id })
    expect(prov).toEqual({ evidenceId: 44, infoState: 'human_confirmed' })
  })

  test('EUR: živý kurz ČNB', async () => {
    vi.mocked(czkPerEur).mockResolvedValue(25.1)
    const fake = setup(
      (c) => (c.table === 'deal' ? { data: deal, error: null } : { data: { ...VERSION, currency: 'EUR' }, error: null }),
      () => ({ data: {}, error: null }),
    )
    await acceptScopeVersion(1, 5, 9)
    expect(fake.rpc).toHaveBeenCalledWith('accept_deal_scope_version', { p_deal_id: 5, p_version_id: 9, p_fx_rate: 25.1 })
  })

  test('EUR u vyhraného obchodu se stejnou částkou: zmrazený kurz', async () => {
    const won = { stage: 'vyhráno', currency: 'EUR', amount_one_time: 24000, amount_one_time_original: '1000', fx_rate: '24' }
    const fake = setup(
      (c) => (c.table === 'deal' ? { data: won, error: null } : { data: { ...VERSION, currency: 'EUR' }, error: null }),
      () => ({ data: {}, error: null }),
    )
    await acceptScopeVersion(1, 5, 9)
    expect(czkPerEur).not.toHaveBeenCalled()
    expect(fake.rpc).toHaveBeenCalledWith('accept_deal_scope_version', { p_deal_id: 5, p_version_id: 9, p_fx_rate: 24 })
  })

  test('koncept přijmout nejde', async () => {
    const fake = setup((c) => (c.table === 'deal' ? { data: deal, error: null } : { data: { ...VERSION, status: 'draft' }, error: null }))
    expect((await acceptScopeVersion(1, 5, 9)).success).toBe(false)
    expect(fake.rpc).not.toHaveBeenCalled()
  })

  test('chyba strážce se přeloží, audit se nezapíše', async () => {
    setup(
      (c) => (c.table === 'deal' ? { data: deal, error: null } : { data: VERSION, error: null }),
      () => ({ data: null, error: { code: 'SV001', message: 'x' } }),
    )
    expect((await acceptScopeVersion(1, 5, 9)).error).toMatch(/nejde do tohoto stavu/)
    expect(recordAudit).not.toHaveBeenCalled()
  })

  test('RPC ještě neexistuje → hláška o migraci', async () => {
    setup(
      (c) => (c.table === 'deal' ? { data: deal, error: null } : { data: VERSION, error: null }),
      () => ({ data: null, error: { code: 'PGRST202', message: 'x' } }),
    )
    expect((await acceptScopeVersion(1, 5, 9)).error).toMatch(/migraci 0072/)
  })
})
