import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { tryRequireUser } from '@/lib/auth/requireUser'
import { getCurrentMember } from '@/lib/queries/currentMember'
import { createFinancialRecord, updateFinancialRecord } from '@/domain/finance/actions/records'
import { listFinancialRecords } from '@/domain/finance/queries/records'
import { listOverdueInvoices } from '@/domain/finance/queries/overdue'
import {
  checkUpdate,
  daysPastDue,
  DUE_ONLY_INVOICED,
  financialRecordCreateSchema,
  financialRecordUpdateSchema,
  overdueInvoices,
  paidKeys,
  paymentKey,
  totalOverdue,
  type FinancialRecordRow,
} from '@/domain/finance/records'
import { createSupabaseFake, hasOp, opArgs, type QueryCall, type QueryResult } from './helpers/supabaseFake'

// Splatnost faktur (0090): validace, výpočet „po splatnosti a nezaplaceno",
// zápis (i před nasazenou migrací) a čtení.

vi.mock('@/lib/auth/requireUser', () => ({ requireUser: vi.fn(), tryRequireUser: vi.fn(), AUTH_ERROR_MESSAGE: 'auth' }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/queries/currentMember', () => ({
  getCurrentMember: vi.fn(),
  memberSeesSales: (m: { role?: string } | null) => m?.role === 'vedeni' || m?.role === 'obchodnik',
}))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

const TODAY = '2026-09-30'
let nextId = 1
const rec = (p: Partial<FinancialRecordRow>): FinancialRecordRow => ({
  id: nextId++, account_id: 1, deal_id: null, engagement_id: null, milestone_id: null, kind: 'invoiced', amount: 1000,
  currency: 'CZK', period_month: '2026-09-01', status: 'confirmed', source: 'rucne', evidence_id: null,
  external_ref: 'FA-1', note: null, created_at: '2026-09-01T00:00:00Z', due_on: '2026-09-20', ...p,
})

describe('validace splatnosti', () => {
  const base = { account_id: '1', kind: 'invoiced', amount: '1000', currency: 'CZK', period_month: '2026-09', status: 'draft', source: 'rucne' }

  test('prázdné = bez splatnosti, platný den projde', () => {
    expect(financialRecordCreateSchema.parse({ ...base, due_on: '' }).due_on).toBeNull()
    expect(financialRecordCreateSchema.parse(base).due_on).toBeNull()
    expect(financialRecordCreateSchema.parse({ ...base, due_on: '2026-10-15' }).due_on).toBe('2026-10-15')
  })

  test.each(['2026-02-30', '2026-13-01', '15. 10. 2026', '1999-12-31', '2101-01-01'])('neplatné datum „%s“', (v) => {
    const r = financialRecordCreateSchema.safeParse({ ...base, due_on: v })
    expect(r.success).toBe(false)
    expect(r.error?.issues[0].path).toEqual(['due_on'])
  })

  test.each(['potential', 'contracted', 'received'])('u druhu %s splatnost odmítne', (kind) => {
    const r = financialRecordCreateSchema.safeParse({ ...base, kind, due_on: '2026-10-15' })
    expect(r.success).toBe(false)
    expect(r.error?.issues.find((i) => i.path[0] === 'due_on')?.message).toBe(DUE_ONLY_INVOICED)
  })

  test('úprava: stejné datum, prázdné = smazat; checkUpdate hlídá druh', () => {
    const upd = { amount: '1000', currency: 'CZK', period_month: '2026-09', status: 'draft' }
    expect(financialRecordUpdateSchema.parse({ ...upd, due_on: '2026-10-15' }).due_on).toBe('2026-10-15')
    expect(financialRecordUpdateSchema.parse({ ...upd, due_on: '' }).due_on).toBeNull()
    expect(financialRecordUpdateSchema.safeParse({ ...upd, due_on: '2026-02-30' }).success).toBe(false)
    expect(checkUpdate({ kind: 'invoiced', status: 'draft' }, { status: 'draft', external_ref: null, due_on: '2026-10-15' })).toBeNull()
    expect(checkUpdate({ kind: 'contracted', status: 'draft' }, { status: 'draft', external_ref: null, due_on: '2026-10-15' })).toBe(DUE_ONLY_INVOICED)
    expect(checkUpdate({ kind: 'contracted', status: 'draft' }, { status: 'draft', external_ref: null, due_on: null })).toBeNull()
  })
})

describe('po splatnosti a nezaplaceno', () => {
  test('daysPastDue: v den splatnosti ještě ne, bez data nebo s nesmyslem nic', () => {
    expect(daysPastDue('2026-09-30', TODAY)).toBe(0)
    expect(daysPastDue('2026-09-29', TODAY)).toBe(1)
    expect(daysPastDue('2026-08-31', TODAY)).toBe(30)
    expect(daysPastDue(null, TODAY)).toBe(0)
    expect(daysPastDue(undefined, TODAY)).toBe(0)
    expect(daysPastDue('nesmysl', TODAY)).toBe(0)
  })

  test('hlídá se jen potvrzená vyfakturovaná položka se splatností před dneškem', () => {
    const rows = [
      rec({ id: 1 }), // ano
      rec({ id: 2, status: 'draft', external_ref: null }), // návrh se nehlídá
      rec({ id: 3, status: 'cancelled' }),
      rec({ id: 4, due_on: '2026-09-30', external_ref: 'FA-4' }), // splatná dnes
      rec({ id: 5, due_on: '2026-10-10', external_ref: 'FA-5' }), // ještě neuplynula
      rec({ id: 6, due_on: null, external_ref: 'FA-6' }), // bez splatnosti
      rec({ id: 7, kind: 'received', external_ref: 'FA-7' }),
      rec({ id: 8, kind: 'contracted', external_ref: null }),
    ]
    expect(overdueInvoices(rows, new Set(), TODAY).map((r) => r.id)).toEqual([1])
  })

  test('zaplacená (potvrzené Přijato se stejným dokladem u stejné firmy) se nehlídá; jiná firma, návrh nebo zrušené úhrady ne', () => {
    const invoices = [
      rec({ id: 1, external_ref: 'FA-1' }),
      rec({ id: 2, external_ref: 'FA-2' }),
      rec({ id: 3, external_ref: 'FA-3' }),
      rec({ id: 4, external_ref: 'FA-4' }),
    ]
    const paid = paidKeys([
      { account_id: 1, kind: 'received', status: 'confirmed', external_ref: ' FA-1 ' }, // okrajové mezery nevadí
      { account_id: 2, kind: 'received', status: 'confirmed', external_ref: 'FA-2' }, // jiná firma
      { account_id: 1, kind: 'received', status: 'draft', external_ref: 'FA-3' }, // návrh úhrady
      { account_id: 1, kind: 'received', status: 'cancelled', external_ref: 'FA-4' }, // zrušená úhrada
      { account_id: 1, kind: 'received', status: 'confirmed', external_ref: null }, // bez dokladu
      { account_id: 1, kind: 'invoiced', status: 'confirmed', external_ref: 'FA-3' }, // není úhrada
    ])
    expect(overdueInvoices(invoices, paid, TODAY).map((r) => r.id)).toEqual([2, 3, 4])
    expect(paymentKey(1, '  ')).toBeNull()
    expect(paymentKey(1, null)).toBeNull()
  })

  test('nejdéle po splatnosti nahoře, dny se počítají vůči dnešku', () => {
    const rows = [
      rec({ id: 1, due_on: '2026-09-28', external_ref: 'A' }),
      rec({ id: 2, due_on: '2026-08-01', external_ref: 'B' }),
      rec({ id: 3, due_on: '2026-09-15', external_ref: 'C' }),
    ]
    expect(overdueInvoices(rows, new Set(), TODAY).map((r) => [r.id, r.daysLate])).toEqual([[2, 60], [3, 15], [1, 2]])
  })

  test('součet po měnách: koruny a eura se nesčítají', () => {
    const t = totalOverdue([
      rec({ amount: 1000.5, currency: 'CZK' }),
      rec({ amount: 250, currency: 'CZK' }),
      rec({ amount: 40, currency: 'EUR' }),
    ])
    expect(t.kind).toBe('invoiced')
    expect(t.byCurrency.CZK).toEqual({ confirmed: 1250.5, draft: 0, count: 2 })
    expect(t.byCurrency.EUR).toEqual({ confirmed: 40, draft: 0, count: 1 })
    expect(totalOverdue([]).byCurrency).toEqual({})
  })
})

// --- zápis -------------------------------------------------------------------

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
const MISSING_COL = { code: '42703', message: 'column "due_on" of relation "financial_record" does not exist' }
const writes = (f: ReturnType<typeof fake>, m: 'insert' | 'update') => f.calls.filter((c) => c.table === 'financial_record' && hasOp(c, m))
const INVOICE = { account_id: '1', kind: 'invoiced', amount: '1000', currency: 'CZK', period_month: '2026-09', status: 'confirmed', source: 'rucne', external_ref: 'FA-9' }
const UPDATE = { amount: '1000', currency: 'CZK', period_month: '2026-09', status: 'confirmed', external_ref: 'FA-9' }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(tryRequireUser).mockResolvedValue({ id: 'u1' } as never)
  vi.mocked(getCurrentMember).mockResolvedValue({ user: { id: 'u1' }, member: { role: 'obchodnik' } } as never)
})

describe('createFinancialRecord se splatností', () => {
  test('faktura se splatností ji uloží; bez splatnosti sloupec vůbec nepošle (funguje i před 0090)', async () => {
    const f = fake(() => undefined)
    expect(await createFinancialRecord(null, fd({ ...INVOICE, due_on: '2026-10-15' }))).toEqual({ success: true })
    expect(opArgs(writes(f, 'insert')[0], 'insert')?.[0]).toMatchObject({ kind: 'invoiced', due_on: '2026-10-15' })
    const g = fake(() => undefined)
    expect(await createFinancialRecord(null, fd(INVOICE))).toEqual({ success: true })
    expect(opArgs(writes(g, 'insert')[0], 'insert')?.[0]).not.toHaveProperty('due_on')
  })

  test('splatnost u jiného druhu se odmítne u pole a nic se nezapíše; neplatné datum taky', async () => {
    const f = fake(() => undefined)
    const r = await createFinancialRecord(null, fd({ ...INVOICE, kind: 'potential', external_ref: '', due_on: '2026-10-15' }))
    expect(r.success).toBe(false)
    expect(r.fieldErrors?.due_on).toBe(DUE_ONLY_INVOICED)
    const r2 = await createFinancialRecord(null, fd({ ...INVOICE, due_on: '2026-02-30' }))
    expect(r2.fieldErrors?.due_on).toBeTruthy()
    expect(writes(f, 'insert')).toHaveLength(0)
  })

  test('před migrací 0090 s vyplněnou splatností srozumitelná chyba u pole', async () => {
    fake((c) => (c.table === 'financial_record' && hasOp(c, 'insert') ? { data: null, error: MISSING_COL } : undefined))
    const r = await createFinancialRecord(null, fd({ ...INVOICE, due_on: '2026-10-15' }))
    expect(r.success).toBe(false)
    expect(r.fieldErrors?.due_on).toContain('migraci 0090')
  })

  test('neobchodní role splatnost nezapíše (brána platí stejně)', async () => {
    vi.mocked(getCurrentMember).mockResolvedValue({ user: { id: 'u1' }, member: { role: 'projektak' } } as never)
    const f = fake(() => undefined)
    const r = await createFinancialRecord(null, fd({ ...INVOICE, due_on: '2026-10-15' }))
    expect(r.success).toBe(false)
    expect(writes(f, 'insert')).toHaveLength(0)
  })
})

describe('updateFinancialRecord se splatností', () => {
  const current = (kind: string, status = 'draft') => (c: QueryCall): QueryResult | undefined =>
    c.table === 'financial_record' && hasOp(c, 'maybeSingle')
      ? { data: { id: 5, account_id: 1, kind, status }, error: null }
      : c.table === 'financial_record' && hasOp(c, 'update')
        ? { data: [{ id: 5 }], error: null }
        : undefined

  test('u faktury se splatnost změní i smaže (prázdné pole = null)', async () => {
    const f = fake(current('invoiced'))
    expect(await updateFinancialRecord(5, null, fd({ ...UPDATE, due_on: '2026-11-01' }))).toEqual({ success: true })
    expect(opArgs(writes(f, 'update')[0], 'update')?.[0]).toMatchObject({ due_on: '2026-11-01' })
    const g = fake(current('invoiced'))
    expect(await updateFinancialRecord(5, null, fd({ ...UPDATE, due_on: '' }))).toEqual({ success: true })
    expect(opArgs(writes(g, 'update')[0], 'update')?.[0]).toMatchObject({ due_on: null })
  })

  test('u jiného druhu se splatnost nedotkne (a poslaná hodnota se odmítne)', async () => {
    const f = fake(current('contracted'))
    expect(await updateFinancialRecord(5, null, fd(UPDATE))).toEqual({ success: true })
    expect(opArgs(writes(f, 'update')[0], 'update')?.[0]).not.toHaveProperty('due_on')
    const g = fake(current('contracted'))
    const r = await updateFinancialRecord(5, null, fd({ ...UPDATE, due_on: '2026-11-01' }))
    expect(r.fieldErrors?.due_on).toBe(DUE_ONLY_INVOICED)
    expect(writes(g, 'update')).toHaveLength(0)
  })

  test('před 0090: prázdná splatnost se vynechá a zápis projde, vyplněná dá chybu u pole', async () => {
    let calls = 0
    const f = fake((c) => {
      if (c.table === 'financial_record' && hasOp(c, 'update')) {
        calls += 1
        const patch = opArgs(c, 'update')?.[0] as Record<string, unknown>
        return 'due_on' in patch ? { data: null, error: MISSING_COL } : { data: [{ id: 5 }], error: null }
      }
      return current('invoiced')(c)
    })
    expect(await updateFinancialRecord(5, null, fd({ ...UPDATE, due_on: '' }))).toEqual({ success: true })
    expect(calls).toBe(2)
    expect(writes(f, 'update').map((c) => 'due_on' in (opArgs(c, 'update')?.[0] as object))).toEqual([true, false])
    const r = await updateFinancialRecord(5, null, fd({ ...UPDATE, due_on: '2026-11-01' }))
    expect(r.success).toBe(false)
    expect(r.fieldErrors?.due_on).toContain('migraci 0090')
  })

  test('zrušený záznam se nemění ani ve splatnosti', async () => {
    const f = fake(current('invoiced', 'cancelled'))
    const r = await updateFinancialRecord(5, null, fd({ ...UPDATE, due_on: '2026-11-01' }))
    expect(r.success).toBe(false)
    expect(writes(f, 'update')).toHaveLength(0)
  })
})

// --- čtení -------------------------------------------------------------------

describe('listFinancialRecords: sloupec splatnosti', () => {
  const FILTERS = { from: '2026-01', to: '2026-12', accountId: null, currency: null, showDrafts: true }
  // Sloupce podle migrací: 0090 = due_on, 0092 = idoklad_*. Výběr s chybějícím sloupcem vrací chybu.
  const dbWith = (cols: { due: boolean; idoklad: boolean }, selects: string[], rows: object[] = [{ id: 1, account: { name: 'ALFATECH' } }]) => {
    fake((c) => {
      if (c.table !== 'financial_record') return undefined
      const sel = String(opArgs(c, 'select')?.[0])
      selects.push(sel)
      const asksDue = /(^|[ ,])due_on(,|$)/.test(sel.replace(/, account:.*$/, ''))
      const asksIdoklad = sel.includes('idoklad_')
      return (asksDue && !cols.due) || (asksIdoklad && !cols.idoklad) ? { data: null, error: MISSING_COL } : { data: rows, error: null }
    })
  }
  test('čte due_on i sloupce z iDokladu; když chybí (před 0090 a 0092), zopakuje čtení bez nich', async () => {
    const full: string[] = []
    dbWith({ due: true, idoklad: true }, full)
    expect((await listFinancialRecords(FILTERS)).state).toBe('ok')
    expect(full).toHaveLength(1)
    expect(full[0]).toContain('due_on')
    expect(full[0]).toContain('idoklad_due_on')

    const none: string[] = []
    dbWith({ due: false, idoklad: false }, none)
    expect((await listFinancialRecords(FILTERS)).state).toBe('ok')
    expect(none).toHaveLength(4)
    expect(none[3]).not.toContain('due_on')
    expect(none[3]).not.toContain('idoklad_')

    // jen 0090 (bez iDokladu): druhý pokus stačí
    const only0090: string[] = []
    dbWith({ due: true, idoklad: false }, only0090)
    expect((await listFinancialRecords(FILTERS)).state).toBe('ok')
    expect(only0090).toHaveLength(2)
  })

  test('jedna splatnost: due_on má přednost, jinak záložně idoklad_due_on (jen u faktur)', async () => {
    const base = { account: { name: 'ALFATECH' }, kind: 'invoiced' }
    dbWith({ due: true, idoklad: true }, [], [
      { id: 1, ...base, due_on: '2026-10-15', idoklad_due_on: '2026-09-30' },
      { id: 2, ...base, due_on: null, idoklad_due_on: '2026-09-30' },
      { id: 3, ...base, due_on: null, idoklad_due_on: null },
      { id: 4, ...base, kind: 'received', due_on: null, idoklad_due_on: '2026-09-30' },
    ])
    const r = await listFinancialRecords(FILTERS)
    expect(r.state === 'ok' && r.records.map((x) => x.due_on ?? null)).toEqual(['2026-10-15', '2026-09-30', null, null])
  })

  test('jiná chyba zůstane chybou', async () => {
    fake((c) => (c.table === 'financial_record' ? { data: null, error: { code: 'XX000', message: 'boom' } } : undefined))
    expect((await listFinancialRecords(FILTERS)).state).toBe('error')
  })
})

describe('listOverdueInvoices', () => {
  const inv = (id: number, ref: string, due: string, o: Record<string, unknown> = {}) => ({
    id, account_id: 1, deal_id: null, engagement_id: null, milestone_id: null, kind: 'invoiced', amount: 1000, currency: 'CZK',
    period_month: '2026-09-01', status: 'confirmed', source: 'rucne', evidence_id: null, external_ref: ref, note: null,
    created_at: '2026-09-01T00:00:00Z', due_on: due, account: { name: 'ALFATECH' }, ...o,
  })
  const isReceived = (c: QueryCall) => JSON.stringify(opArgs(c, 'eq')) === JSON.stringify(['kind', 'received'])

  test('dotaz: potvrzené vyfakturované se splatností před dneškem, filtr firmy a měny se přenese', async () => {
    const f = fake((c) => (c.table === 'financial_record' && !isReceived(c) ? { data: [], error: null } : undefined))
    expect(await listOverdueInvoices({ today: TODAY, accountId: 7, currency: 'EUR' })).toEqual({ state: 'ok', rows: [] })
    const q = f.calls[0]
    // splatnost z iDokladu (0092) je záložní, když chybí ruční due_on (0090)
    expect(opArgs(q, 'or')).toEqual([`due_on.lt.${TODAY},and(due_on.is.null,idoklad_due_on.lt.${TODAY})`])
    const eqs = q.ops.filter((o) => o.method === 'eq').map((o) => o.args)
    expect(eqs).toEqual(expect.arrayContaining([['kind', 'invoiced'], ['status', 'confirmed'], ['account_id', 7], ['currency', 'EUR']]))
    // bez faktur se úhrady ani nečtou
    expect(f.calls).toHaveLength(1)
  })

  test('splatnost z iDokladu: faktura bez ruční splatnosti se počítá podle idoklad_due_on; před 0092 se dotaz zopakuje bez ní', async () => {
    const f = fake((c) => {
      if (c.table !== 'financial_record') return undefined
      if (isReceived(c)) return { data: [], error: null }
      const sel = String(opArgs(c, 'select')?.[0])
      if (sel.includes('idoklad_due_on') && c.ops.some((o) => o.method === 'or') && f0.missing) return { data: null, error: { code: '42703', message: 'column financial_record.idoklad_due_on does not exist' } }
      return { data: [inv(1, 'FA-1', null as never, { due_on: null, idoklad_due_on: '2026-09-20' })], error: null }
    })
    const f0 = { missing: false }
    const r = await listOverdueInvoices({ today: TODAY })
    expect(r.state === 'ok' && r.rows.map((x) => [x.id, x.due_on, x.daysLate])).toEqual([[1, '2026-09-20', 10]])
    f0.missing = true
    await listOverdueInvoices({ today: TODAY })
    const financial = f.calls.filter((c) => c.table === 'financial_record' && !isReceived(c))
    // druhé volání: nejdřív pokus s or(), pak bez iDokladu (lt na due_on)
    expect(financial.slice(-2).map((c) => Boolean(opArgs(c, 'or')))).toEqual([true, false])
    expect(opArgs(financial[financial.length - 1], 'lt')).toEqual(['due_on', TODAY])
  })

  test('spáruje úhrady podle firmy a čísla dokladu a vrátí jen nezaplacené s dny po splatnosti', async () => {
    fake((c) => {
      if (c.table !== 'financial_record') return undefined
      if (isReceived(c)) return { data: [{ account_id: 1, kind: 'received', status: 'confirmed', external_ref: 'FA-2' }], error: null }
      return { data: [inv(1, 'FA-1', '2026-09-20'), inv(2, 'FA-2', '2026-09-01')], error: null }
    })
    const r = await listOverdueInvoices({ today: TODAY })
    expect(r.state).toBe('ok')
    if (r.state !== 'ok') return
    expect(r.rows.map((x) => [x.id, x.daysLate, x.account_name])).toEqual([[1, 10, 'ALFATECH']])
  })

  test('víc než sto čísel dokladů se čte po částech', async () => {
    const many = Array.from({ length: 230 }, (_, i) => inv(i + 1, `FA-${i + 1}`, '2026-09-01'))
    const f = fake((c) => {
      if (c.table !== 'financial_record') return undefined
      return isReceived(c) ? { data: [], error: null } : { data: many, error: null }
    })
    const r = await listOverdueInvoices({ today: TODAY })
    expect(r.state === 'ok' && r.rows.length).toBe(230)
    expect(f.calls.filter((c) => isReceived(c))).toHaveLength(3)
  })

  test('chybějící sloupec (před 0090) = missing_migration, chyba úhrad = error (nekřičet u zaplacených)', async () => {
    fake((c) => (c.table === 'financial_record' ? { data: null, error: MISSING_COL } : undefined))
    expect(await listOverdueInvoices({ today: TODAY })).toEqual({ state: 'missing_migration' })
    fake((c) => (c.table === 'financial_record' ? { data: null, error: { code: 'PGRST204', message: 'Could not find the due_on column' } } : undefined))
    expect(await listOverdueInvoices({ today: TODAY })).toEqual({ state: 'missing_migration' })
    fake((c) => (c.table === 'financial_record' ? { data: null, error: { code: '42P01', message: 'relation "financial_record" does not exist' } } : undefined))
    expect(await listOverdueInvoices({ today: TODAY })).toEqual({ state: 'missing_migration' })
    fake((c) => (c.table === 'financial_record' ? { data: null, error: { code: 'XX000', message: 'boom' } } : undefined))
    expect(await listOverdueInvoices({ today: TODAY })).toEqual({ state: 'error' })
    fake((c) => {
      if (c.table !== 'financial_record') return undefined
      return isReceived(c) ? { data: null, error: { code: 'XX000', message: 'boom' } } : { data: [inv(1, 'FA-1', '2026-09-01')], error: null }
    })
    expect(await listOverdueInvoices({ today: TODAY })).toEqual({ state: 'error' })
  })

  test('předaný klient (cron) se použije místo session', async () => {
    const f = createSupabaseFake({ resolve: () => ({ data: [], error: null }) })
    vi.mocked(createClient).mockRejectedValue(new Error('session klient se tu nesmí použít'))
    expect(await listOverdueInvoices({ today: TODAY, db: f.client as never })).toEqual({ state: 'ok', rows: [] })
  })
})
