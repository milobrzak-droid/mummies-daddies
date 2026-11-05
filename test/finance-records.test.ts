import { readFileSync } from 'node:fs'
import { describe, expect, expectTypeOf, test } from 'vitest'
import {
  addKindTotals,
  addMonths,
  buildFinanceBoard,
  checkUpdate,
  emptyKindTotals,
  FINANCIAL_KINDS,
  FINANCIAL_SOURCES,
  FINANCIAL_STATUSES,
  FINANCIAL_STATUS_TRANSITIONS,
  financialRecordCreateSchema,
  needsExternalRef,
  parseAmount,
  parseFinanceFilters,
  periodFromMonth,
  periodOfDate,
  summarizeByKind,
  type FinanceBoard,
  type FinancialRecordRow,
  type KindTotals,
} from '@/domain/finance/records'

// Kap. 10: potenciál, nasmlouváno, vyfakturováno a přijato se NIKDY
// nesčítají do jednoho obratu. Hlídáme i synchronizaci s migrací 0063.

const SQL = readFileSync('supabase/migrations/0063_financial_record.sql', 'utf8')
// Zdroje rozšířila 0092 (source 'idoklad'): platí poslední CHECK v pořadí migrací.
// Poslední definice CHECKu zdroje: 0092 přidala idoklad, 0098 přidává import.
const SQL_0092 = readFileSync('supabase/migrations/0098_bulk_import.sql', 'utf8')

let nextId = 1
function rec(p: Partial<FinancialRecordRow>): FinancialRecordRow {
  return {
    id: nextId++, account_id: 1, deal_id: null, engagement_id: null, milestone_id: null,
    kind: 'potential', amount: 100, currency: 'CZK', period_month: '2026-09-01', status: 'confirmed',
    source: 'rucne', evidence_id: null, external_ref: null, note: null, created_at: '2026-09-01T00:00:00Z',
    ...p,
  }
}

describe('nikdy jeden obrat', () => {
  test('board má jen čtyři oddělené druhy a žádné celkem', () => {
    const b = buildFinanceBoard([rec({ kind: 'potential', amount: 1000 }), rec({ kind: 'received', amount: 50 })])
    expect(Object.keys(b).sort()).toEqual([...FINANCIAL_KINDS].sort())
    expect(b.potential.total.byCurrency.CZK?.confirmed).toBe(1000)
    expect(b.received.total.byCurrency.CZK?.confirmed).toBe(50)
    expect(b.invoiced.total.byCurrency).toEqual({})
    expectTypeOf<keyof FinanceBoard>().toEqualTypeOf<'potential' | 'contracted' | 'invoiced' | 'received'>()
  })

  test('addKindTotals sčítá jen stejný druh — typově i za běhu', () => {
    const p = emptyKindTotals('potential')
    const r = emptyKindTotals('received')
    expect(addKindTotals(p, p).kind).toBe('potential')
    // @ts-expect-error — potenciál a přijato se nesčítají
    expect(() => addKindTotals(p, r)).toThrow()
    expectTypeOf(p).not.toEqualTypeOf<KindTotals<'received'>>()
  })

  test('modul neexportuje žádný součet přes druhy', async () => {
    const mod = await import('@/domain/finance/records')
    const names = Object.keys(mod).map((n) => n.toLowerCase())
    expect(names.filter((n) => /grand|overall|turnover|obrat|totalall/.test(n))).toEqual([])
  })
})

describe('agregace po druhu, měně a měsíci', () => {
  test('měny se nesčítají dohromady, návrhy zvlášť, zrušené se nepočítají', () => {
    const rows = [
      rec({ kind: 'invoiced', amount: '100.10', currency: 'CZK' }),
      rec({ kind: 'invoiced', amount: '0.20', currency: 'CZK', status: 'draft' }),
      rec({ kind: 'invoiced', amount: 5, currency: 'EUR' }),
      rec({ kind: 'invoiced', amount: 999, status: 'cancelled' }),
      rec({ kind: 'invoiced', amount: 1, period_month: '2026-08-01' }),
    ]
    const col = buildFinanceBoard(rows).invoiced
    expect(col.total.byCurrency.CZK).toEqual({ confirmed: 101.1, draft: 0.2, count: 3 })
    expect(col.total.byCurrency.EUR).toEqual({ confirmed: 5, draft: 0, count: 1 })
    expect(col.months.map((m) => m.month)).toEqual(['2026-09', '2026-08'])
    expect(col.months[0].byCurrency.CZK?.confirmed).toBe(100.1)
  })

  test('summarizeByKind vrací čtyři oddělené součty', () => {
    const s = summarizeByKind([rec({ kind: 'contracted', amount: 7 })])
    expect(s.contracted.byCurrency.CZK?.confirmed).toBe(7)
    expect(s.potential.byCurrency).toEqual({})
  })
})

describe('pomocné funkce', () => {
  test('období a částky', () => {
    expect(periodFromMonth('2026-09')).toBe('2026-09-01')
    expect(periodFromMonth('2026-13')).toBeNull()
    expect(periodOfDate('2026-10-17T10:00:00Z')).toBe('2026-10-01')
    // 1. 10. 00:30 pražského času = 30. 9. 22:30 UTC → říjen, ne září.
    expect(periodOfDate('2026-09-30T22:30:00+00:00')).toBe('2026-10-01')
    // zima: 1. 1. 00:30 SEČ = 31. 12. 23:30 UTC
    expect(periodOfDate('2026-12-31T23:30:00Z')).toBe('2027-01-01')
    expect(periodOfDate('2026-10-31T23:30:00Z')).toBe('2026-11-01')
    expect(periodOfDate('2026-09-17')).toBe('2026-09-01')
    expect(addMonths('2026-01', -1)).toBe('2025-12')
    expect(addMonths('2026-11', 3)).toBe('2027-02')
    expect(parseAmount('12 500,50')).toBe(12500.5)
    expect(parseAmount('0')).toBeNull()
    expect(parseAmount('-5')).toBeNull()
    expect(parseAmount('1.234')).toBeNull()
  })

  test('filtry', () => {
    const f = parseFinanceFilters({ od: '2026-12', do: '2026-01', firma: '5', mena: 'EUR', navrhy: '0' }, '2026-09')
    expect(f).toEqual({ from: '2026-01', to: '2026-12', accountId: 5, currency: 'EUR', showDrafts: false })
    const d = parseFinanceFilters({ firma: 'x', mena: 'USD' }, '2026-09')
    expect(d).toEqual({ from: '2025-10', to: '2027-09', accountId: null, currency: null, showDrafts: true })
  })

  test('potvrzená faktura/úhrada potřebuje číslo dokladu', () => {
    expect(needsExternalRef('invoiced', 'confirmed')).toBe(true)
    expect(needsExternalRef('potential', 'confirmed')).toBe(false)
    const base = { account_id: '1', kind: 'received', amount: '10', currency: 'CZK', period_month: '2026-09', source: 'rucne' }
    expect(financialRecordCreateSchema.safeParse({ ...base, status: 'confirmed' }).success).toBe(false)
    expect(financialRecordCreateSchema.safeParse({ ...base, status: 'confirmed', external_ref: 'FV-1' }).success).toBe(true)
    expect(financialRecordCreateSchema.safeParse({ ...base, status: 'draft', source: 'milnik' }).success).toBe(false)
  })

  test('přechody stavu', () => {
    expect(checkUpdate({ kind: 'potential', status: 'cancelled' }, { status: 'draft', external_ref: null })).toMatch(/Zrušený/)
    expect(checkUpdate({ kind: 'potential', status: 'confirmed' }, { status: 'draft', external_ref: null })).toMatch(/nelze/)
    expect(checkUpdate({ kind: 'invoiced', status: 'draft' }, { status: 'confirmed', external_ref: null })).toMatch(/dokladu/)
    expect(checkUpdate({ kind: 'invoiced', status: 'draft' }, { status: 'confirmed', external_ref: 'F1' })).toBeNull()
  })
})

describe('shoda s migrací 0063', () => {
  test('doklad je neměnný a musí být akceptací vlastního milníku', () => {
    expect(SQL).toMatch(/OR NEW\.evidence_id IS DISTINCT FROM OLD\.evidence_id THEN/)
    expect(SQL).toMatch(/NEW\.evidence_id IS DISTINCT FROM v_ms_evid/)
  })

  const inList = (re: RegExp) => {
    const m = re.exec(SQL)
    expect(m).not.toBeNull()
    return [...m![1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort()
  }
  test('druhy, stavy a zdroje', () => {
    expect(inList(/kind IN \(([^)]*)\)/)).toEqual([...FINANCIAL_KINDS].sort())
    expect(inList(/status IN \(('draft'[^)]*)\)/)).toEqual([...FINANCIAL_STATUSES].sort())
    const m0092 = /source IN \(([^)]*)\)/.exec(SQL_0092)
    expect([...m0092![1].matchAll(/'([a-z_]+)'/g)].map((x) => x[1]).sort()).toEqual([...FINANCIAL_SOURCES].sort())
  })
  test('přechody stavu v triggeru', () => {
    expect(SQL).toContain(`(OLD.status = 'draft' AND NEW.status IN ('confirmed', 'cancelled'))`)
    expect(SQL).toContain(`(OLD.status = 'confirmed' AND NEW.status = 'cancelled')`)
    expect(FINANCIAL_STATUS_TRANSITIONS).toEqual({ draft: ['confirmed', 'cancelled'], confirmed: ['cancelled'], cancelled: [] })
  })
  test('sales-only a AAL2 jako RESTRICTIVE, funkce zabalené do SELECT', () => {
    expect(SQL).toMatch(/CREATE POLICY sales_only ON financial_record\s+AS RESTRICTIVE FOR ALL\s+USING \(\(SELECT can_see_sales\(\)\)\)/)
    expect(SQL).toMatch(/CREATE POLICY require_aal2 ON financial_record\s+AS RESTRICTIVE/)
    expect(SQL).toContain('ENABLE ROW LEVEL SECURITY')
    expect(SQL).toContain('DEFAULT auth.uid()')
    expect(SQL).toMatch(/INSERT INTO schema_migration[\s\S]*ON CONFLICT \(version\) DO NOTHING/)
  })
})
