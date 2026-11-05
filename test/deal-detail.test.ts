import { describe, expect, test, vi } from 'vitest'
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
import { summarizeAuditChange } from '@/domain/crm/queries/dealDetail'

describe('summarizeAuditChange', () => {
  test('jen změněná pole, abecedně, bez updated_at', () => {
    expect(summarizeAuditChange(
      { stage: 'kvalifikace', amount_one_time: 100, title: 'X', updated_at: 'a' },
      { stage: 'rozsah_nabidka', amount_one_time: 200, title: 'X', updated_at: 'b' },
    )).toEqual(['amount_one_time: 100 → 200', 'stage: kvalifikace → rozsah_nabidka'])
  })
  test('insert a delete', () => {
    expect(summarizeAuditChange(null, { stage: 'kvalifikace' })).toEqual(['stage: kvalifikace'])
    expect(summarizeAuditChange({ stage: 'kvalifikace' }, null)).toEqual(['stage: kvalifikace → —'])
  })
  test('null hodnoty a omezení počtu', () => {
    expect(summarizeAuditChange({ a: null }, { a: 1 })).toEqual(['a: — → 1'])
    const before = Object.fromEntries('abcdefgh'.split('').map((k) => [k, 1]))
    const after = Object.fromEntries('abcdefgh'.split('').map((k) => [k, 2]))
    const out = summarizeAuditChange(before, after, 3)
    expect(out).toHaveLength(4)
    expect(out[3]).toBe('+ 5 dalších')
  })
  test('_columns z DB triggeru 0064: hodnoty jen u bezpečných sloupců, ostatní jen „změněno"', () => {
    expect(summarizeAuditChange(
      { next_step_due: null },
      { next_step_due: '2026-10-01', _columns: ['next_step', 'next_step_due'] },
    )).toEqual(['next_step_due: — → 2026-10-01', 'next_step: změněno (hodnota se neukládá)'])
  })
  test('prázdné', () => {
    expect(summarizeAuditChange(null, null)).toEqual([])
  })
})
