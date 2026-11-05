import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { createAuditedAdminClient } from '@/core/auditDb'
import { tryRequireUser } from '@/lib/auth/requireUser'
import { getCurrentMember } from '@/lib/queries/currentMember'
import { fetchInvoicesByIds, IdokladError, type IdokladInvoice } from '@/connectors/idoklad'
import { applyDiscrepancy, cancelRecordOfDiscrepancy, dismissDiscrepancy } from '@/domain/finance/actions/idoklad'
import { createSupabaseFake, hasOp, opArgs, type QueryCall, type QueryResult } from './helpers/supabaseFake'

// Rozhodnutí o rozdílech z iDokladu: AAL2 brána, jen obchodní role, převzetí
// z iDokladu jen po znovupřečtení faktury (GET), zápisy do záznamů servisním
// klíčem s aktérem user:<id>; rozhodnutí o rozdílu pod session člověka.

vi.mock('@/lib/auth/requireUser', () => ({ requireUser: vi.fn(), tryRequireUser: vi.fn(), AUTH_ERROR_MESSAGE: 'auth' }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/core/auditDb', () => ({ createAuditedAdminClient: vi.fn() }))
vi.mock('@/lib/queries/currentMember', () => ({
  getCurrentMember: vi.fn(),
  memberSeesSales: (m: { role?: string } | null) => m?.role === 'vedeni' || m?.role === 'obchodnik',
}))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/connectors/idoklad', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/connectors/idoklad')>()),
  fetchInvoicesByIds: vi.fn(),
}))

const INV: IdokladInvoice = {
  id: 7, documentNumber: '20260007', variableSymbol: null, issuedOn: '2026-09-16', dueOn: '2026-09-30', paidOn: null, currencyId: 1,
  currency: 'CZK', totalNet: 10000, totalGross: 12100, totalPaid: 0, paymentStatus: 'unpaid', partnerId: 1, partnerIco: '12345678', partnerName: 'Alfa',
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('IDOKLAD_CLIENT_ID', 'cid')
  vi.stubEnv('IDOKLAD_CLIENT_SECRET', 'sekret')
  vi.mocked(tryRequireUser).mockResolvedValue({ id: 'u1' } as never)
  vi.mocked(getCurrentMember).mockResolvedValue({ user: { id: 'u1' }, member: { role: 'obchodnik' } } as never)
  vi.mocked(fetchInvoicesByIds).mockResolvedValue([INV])
})

const fd = (e: Record<string, string> = {}) => {
  const f = new FormData()
  for (const [k, v] of Object.entries(e)) f.append(k, v)
  return f
}
type Resolver = (c: QueryCall) => QueryResult | undefined
function fake(resolve: Resolver) {
  // Uzavření rozdílu vrací změněný řádek (`.select('id')`), jinak by akce hlásila souběžnou změnu.
  const f = createSupabaseFake({
    resolve: (c) => resolve(c) ?? (c.table === 'idoklad_discrepancy' && hasOp(c, 'update') ? { data: [{ id: 3 }], error: null } : { data: null, error: null }),
  })
  vi.mocked(createClient).mockResolvedValue(f.client as never)
  return f
}
function admin(resolve: Resolver = () => undefined) {
  const f = createSupabaseFake({ resolve: (c) => resolve(c) ?? { data: null, error: null } })
  vi.mocked(createAuditedAdminClient).mockReturnValue(f.client as never)
  return f
}
const OPEN = (over: Record<string, unknown> = {}) => ({ id: 3, kind: 'amount_mismatch', idoklad_kind: 'invoice', idoklad_id: 7, account_id: 1, record_id: 20, ...over })
const loadOpen = (row: Record<string, unknown> | null): Resolver => (c) =>
  c.table === 'idoklad_discrepancy' && hasOp(c, 'maybeSingle') && !hasOp(c, 'update') ? { data: row, error: null } : undefined
const closed = (f: ReturnType<typeof fake>) => f.calls.filter((c) => c.table === 'idoklad_discrepancy' && hasOp(c, 'update'))

describe('brány', () => {
  test('bez AAL2 nic; neobchodní role nic', async () => {
    vi.mocked(tryRequireUser).mockResolvedValue(null)
    const f = fake(() => undefined)
    expect(await dismissDiscrepancy(3, null, fd())).toEqual({ success: false, error: 'auth' })
    expect(await applyDiscrepancy(3, null, fd())).toEqual({ success: false, error: 'auth' })
    expect(await cancelRecordOfDiscrepancy(3)).toEqual({ success: false, error: 'auth' })
    expect(f.calls).toHaveLength(0)

    vi.mocked(tryRequireUser).mockResolvedValue({ id: 'u1' } as never)
    vi.mocked(getCurrentMember).mockResolvedValue({ user: { id: 'u1' }, member: { role: 'projektak' } } as never)
    const r = await dismissDiscrepancy(3, null, fd())
    expect(r.error).toMatch(/přístupem k obchodu/)
    expect(f.calls).toHaveLength(0)
  })

  test('neplatné id a už vyřešený rozdíl', async () => {
    fake(() => undefined)
    expect((await dismissDiscrepancy(-1, null, fd())).error).toBe('Neplatné ID.')
    fake(loadOpen(null))
    expect((await dismissDiscrepancy(3, null, fd())).error).toMatch(/nebyl nalezen/)
  })

  test('bez migrace 0092 klidná hláška', async () => {
    fake((c) => (c.table === 'idoklad_discrepancy' ? { data: null, error: { code: '42P01' } } : undefined))
    expect((await dismissDiscrepancy(3, null, fd())).error).toMatch(/0092/)
  })
})

describe('dismissDiscrepancy', () => {
  test('uzavře otevřený rozdíl s poznámkou (pod session člověka), nesahá na záznamy ani na iDoklad', async () => {
    const f = fake(loadOpen(OPEN()))
    const a = admin()
    const r = await dismissDiscrepancy(3, null, fd({ note: '  domluveno s klientem  ' }))
    expect(r).toEqual({ success: true })
    const upd = closed(f)[0]
    expect(opArgs(upd, 'update')?.[0]).toEqual({ status: 'dismissed', resolution: 'dismissed', resolution_note: 'domluveno s klientem' })
    expect(opArgs(upd, 'eq')).toEqual(['id', 3])
    expect(a.calls).toHaveLength(0)
    expect(fetchInvoicesByIds).not.toHaveBeenCalled()
  })
})

describe('applyDiscrepancy', () => {
  test('jiná částka: znovu přečte fakturu, záznam opíše z iDokladu servisním klíčem s aktérem člověka, rozdíl uzavře', async () => {
    const f = fake(loadOpen(OPEN()))
    const a = admin((c) => (c.table === 'financial_record' && hasOp(c, 'maybeSingle')
      ? { data: { id: 20, status: 'draft', external_ref: null, idoklad_id: null, account_id: 1 }, error: null } : undefined))
    const r = await applyDiscrepancy(3, null, fd())
    expect(r).toEqual({ success: true })
    expect(fetchInvoicesByIds).toHaveBeenCalledWith(expect.anything(), [7])
    expect(createAuditedAdminClient).toHaveBeenCalledWith({ actor: { type: 'user', id: 'u1' }, infoState: 'human_confirmed' })
    const upd = a.calls.find((c) => c.table === 'financial_record' && hasOp(c, 'update'))!
    expect(opArgs(upd, 'update')?.[0]).toEqual({
      amount: 10000, currency: 'CZK', status: 'confirmed', external_ref: '20260007',
      idoklad_kind: 'invoice', idoklad_id: 7, idoklad_due_on: '2026-09-30',
    })
    expect(opArgs(closed(f)[0], 'update')?.[0]).toMatchObject({ status: 'resolved', resolution: 'applied' })
  })

  test('záznam spárovaný s jinou fakturou nebo zrušený se nepřepíše', async () => {
    fake(loadOpen(OPEN()))
    let a = admin((c) => (hasOp(c, 'maybeSingle') ? { data: { id: 20, status: 'confirmed', external_ref: 'X', idoklad_id: 99, account_id: 1 }, error: null } : undefined))
    expect((await applyDiscrepancy(3, null, fd())).error).toMatch(/jinou fakturou/)
    expect(a.calls.some((c) => hasOp(c, 'update'))).toBe(false)
    fake(loadOpen(OPEN()))
    a = admin((c) => (hasOp(c, 'maybeSingle') ? { data: { id: 20, status: 'cancelled', external_ref: 'X', idoklad_id: null, account_id: 1 }, error: null } : undefined))
    expect((await applyDiscrepancy(3, null, fd())).error).toMatch(/zrušený/)
  })

  test('faktura bez záznamu: založí potvrzený záznam ze zdroje iDoklad pro zvolenou firmu', async () => {
    const f = fake((c) => loadOpen(OPEN({ kind: 'invoice_without_record', record_id: null, account_id: null }))(c)
      ?? (c.table === 'account' ? { data: { id: 5 }, error: null } : undefined))
    const a = admin()
    expect(await applyDiscrepancy(3, null, fd({ account_id: '5' }))).toEqual({ success: true })
    const ins = a.calls.find((c) => c.table === 'financial_record' && hasOp(c, 'insert'))!
    expect(opArgs(ins, 'insert')?.[0]).toMatchObject({
      account_id: 5, kind: 'invoiced', amount: 10000, currency: 'CZK', status: 'confirmed', source: 'idoklad',
      external_ref: '20260007', idoklad_kind: 'invoice', idoklad_id: 7, period_month: '2026-09-01',
    })
    expect(opArgs(closed(f)[0], 'update')?.[0]).toMatchObject({ resolution: 'applied' })
  })

  test('bez zvolené firmy nebo s cizím záznamem se nic nezapíše', async () => {
    fake(loadOpen(OPEN({ kind: 'invoice_without_record', record_id: null, account_id: null })))
    let a = admin()
    expect((await applyDiscrepancy(3, null, fd())).error).toMatch(/Zvol firmu/)
    fake(loadOpen(OPEN({ kind: 'invoice_without_record', record_id: 20 })))
    a = admin()
    expect((await applyDiscrepancy(3, null, fd({ account_id: '1' }))).error).toMatch(/u jiné firmy/)
    expect(a.calls).toHaveLength(0)
  })

  test('duplicita (23505) = srozumitelná věta; rozdíl zůstává otevřený', async () => {
    const f = fake((c) => loadOpen(OPEN({ kind: 'invoice_without_record', record_id: null }))(c) ?? (c.table === 'account' ? { data: { id: 1 }, error: null } : undefined))
    admin((c) => (hasOp(c, 'insert') ? { data: null, error: { code: '23505' } } : undefined))
    expect((await applyDiscrepancy(3, null, fd({ account_id: '1' }))).error).toMatch(/už záznam .* existuje/)
    expect(closed(f)).toHaveLength(0)
  })

  test('druhy rozdílů, které nejdou převzít (úhrada, záznam bez faktury), se odmítnou', async () => {
    fake(loadOpen(OPEN({ kind: 'payment_mismatch' })))
    admin()
    expect((await applyDiscrepancy(3, null, fd())).error).toMatch(/nedá převzít/)
    expect(fetchInvoicesByIds).not.toHaveBeenCalled()
  })

  test('měna mimo CZK a EUR, nulová faktura, zmizelá faktura, výpadek iDokladu, chybějící tajemství', async () => {
    fake(loadOpen(OPEN())); admin()
    vi.mocked(fetchInvoicesByIds).mockResolvedValueOnce([{ ...INV, currency: 'USD' }])
    expect((await applyDiscrepancy(3, null, fd())).error).toMatch(/USD/)
    vi.mocked(fetchInvoicesByIds).mockResolvedValueOnce([{ ...INV, totalNet: 0 }])
    expect((await applyDiscrepancy(3, null, fd())).error).toMatch(/nulovou/)
    vi.mocked(fetchInvoicesByIds).mockResolvedValueOnce([])
    expect((await applyDiscrepancy(3, null, fd())).error).toMatch(/už v iDokladu není/)
    vi.mocked(fetchInvoicesByIds).mockRejectedValueOnce(new IdokladError(429, 'http_429', 'iDoklad vrátil limit požadavků (429), zkusí se to při dalším běhu.'))
    expect((await applyDiscrepancy(3, null, fd())).error).toMatch(/limit/)
    vi.stubEnv('IDOKLAD_CLIENT_SECRET', '')
    expect((await applyDiscrepancy(3, null, fd())).error).toMatch(/Chybí přihlašovací údaje/)
  })
})

describe('cancelRecordOfDiscrepancy', () => {
  test('zruší záznam bez faktury (soft) a uzavře rozdíl', async () => {
    const f = fake((c) => loadOpen(OPEN({ kind: 'record_without_invoice', idoklad_kind: null, idoklad_id: null, record_id: 20 }))(c)
      ?? (c.table === 'financial_record' && hasOp(c, 'update') ? { data: [{ account_id: 1 }], error: null } : undefined))
    expect(await cancelRecordOfDiscrepancy(3)).toEqual({ success: true })
    const upd = f.calls.find((c) => c.table === 'financial_record' && hasOp(c, 'update'))!
    expect(opArgs(upd, 'update')?.[0]).toEqual({ status: 'cancelled' })
    expect(f.calls.some((c) => c.table === 'financial_record' && hasOp(c, 'delete'))).toBe(false)
    expect(opArgs(closed(f)[0], 'update')?.[0]).toMatchObject({ resolution: 'applied' })
  })

  test('u jiného druhu rozdílu záznam nezruší', async () => {
    const f = fake(loadOpen(OPEN()))
    expect((await cancelRecordOfDiscrepancy(3)).error).toMatch(/jiné situace/)
    expect(f.calls.some((c) => c.table === 'financial_record')).toBe(false)
  })
})
