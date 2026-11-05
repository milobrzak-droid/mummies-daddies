import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import {
  allowedTransitions,
  canTransition,
  countByStatus,
  countsByList,
  planStatusChange,
  targetListItemSchema,
  targetListSchema,
  TARGET_STATUSES,
} from '@/domain/crm/targetLists'

const item = { account_id: 7, contact_id: 3, reason: 'Roste, nabírá IT', status: 'navrzeno' as const }

describe('přechody stavů', () => {
  test('navrženo → osloveno / vyřazeno', () => {
    expect(allowedTransitions('navrzeno')).toEqual(['osloveno', 'vyrazeno'])
    expect(canTransition('navrzeno', 'odpovedel')).toBe(false)
    expect(canTransition('osloveno', 'odpovedel')).toBe(true)
    expect(canTransition('vyrazeno', 'navrzeno')).toBe(true)
  })
  test('žádný stav nepřechází sám na sebe', () => {
    for (const s of TARGET_STATUSES) expect(canTransition(s, s)).toBe(false)
  })
})

describe('počty', () => {
  test('countByStatus', () => {
    expect(countByStatus([{ status: 'navrzeno' }, { status: 'osloveno' }, { status: 'osloveno' }])).toEqual({
      navrzeno: 1, osloveno: 2, odpovedel: 0, vyrazeno: 0, total: 3,
    })
  })
  test('countsByList seskupí podle seznamu', () => {
    const m = countsByList([{ list_id: 1, status: 'navrzeno' }, { list_id: 2, status: 'vyrazeno' }, { list_id: 1, status: 'odpovedel' }])
    expect(m.get(1)?.total).toBe(2)
    expect(m.get(2)?.vyrazeno).toBe(1)
    expect(m.get(3)).toBeUndefined()
  })
})

describe('validace', () => {
  test('důvod je povinný', () => {
    const r = targetListItemSchema.safeParse({ list_id: '1', account_id: '2', reason: '   ' })
    expect(r.success).toBe(false)
  })
  test('prázdný kontakt a termín → null, id se převedou', () => {
    const r = targetListItemSchema.parse({ list_id: '1', account_id: '2', reason: 'x', contact_id: '', next_step_due: '' })
    expect(r).toMatchObject({ list_id: 1, account_id: 2, contact_id: null, next_step_due: null, next_step: null })
  })
  test('neplatné id a datum odmítnuto', () => {
    expect(targetListItemSchema.safeParse({ list_id: '-1', account_id: '2', reason: 'x' }).success).toBe(false)
    expect(targetListItemSchema.safeParse({ list_id: '1', account_id: 'abc', reason: 'x' }).success).toBe(false)
    expect(targetListItemSchema.safeParse({ list_id: '1', account_id: '2', reason: 'x', next_step_due: '1.1.2027' }).success).toBe(false)
  })
  test('seznam potřebuje název, segment a proč', () => {
    expect(targetListSchema.safeParse({ name: 'A', segment: 'B', rationale: '' }).success).toBe(false)
    expect(targetListSchema.parse({ name: 'A', segment: 'B', rationale: 'C', value_hypothesis: '' }).value_hypothesis).toBeNull()
  })
})

describe('oslovení = aktivita, nikdy obchod', () => {
  test('osloveno vytvoří aktivitu bez deal_id', () => {
    const p = planStatusChange(item, 'Výroba Q4', 'osloveno')
    expect(p.ok).toBe(true)
    if (!p.ok) return
    expect(p.itemUpdate).toEqual({ status: 'osloveno' })
    expect(p.activity).toMatchObject({ account_id: 7, contact_id: 3, kind: 'other', deal_id: null })
    expect(p.activity?.subject).toContain('Výroba Q4')
    expect(JSON.stringify(p)).not.toMatch(/"deal"|stage|amount/)
  })
  test('jiné přechody aktivitu nezapisují', () => {
    const p = planStatusChange(item, 'X', 'vyrazeno')
    expect(p.ok && p.activity).toBeNull()
  })
  test('nepovolený přechod vrátí chybu', () => {
    expect(planStatusChange(item, 'X', 'odpovedel').ok).toBe(false)
  })
  test('aktivita používá kind z enumu sales_activity_kind', () => {
    const sql = readFileSync(join(__dirname, '..', 'supabase', 'migrations', '0020_core_sales_crm.sql'), 'utf8')
    const kinds = /sales_activity_kind AS ENUM \(([^)]*)\)/.exec(sql)![1]
    const p = planStatusChange(item, 'X', 'osloveno')
    expect(p.ok && kinds.includes(`'${p.activity!.kind}'`)).toBe(true)
  })
  test('akce ani doména cílových seznamů nesahají na tabulku deal', () => {
    for (const f of ['domain/crm/actions/targetLists.ts', 'domain/crm/targetLists.ts', 'domain/crm/queries/targetLists.ts']) {
      const src = readFileSync(join(__dirname, '..', f), 'utf8')
      expect(src, f).not.toMatch(/from\(\s*['"]deal/)
      expect(src, f).not.toMatch(/rpc\(/)
    }
  })
})
