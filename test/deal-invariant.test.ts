import { describe, expect, test, vi } from 'vitest'
import { checkDealInvariant, isMissingColumnError, writeWithoutMissingReason } from '@/domain/crm/dealInvariant'
import { OPEN_DEAL_STAGES } from '@/domain/crm/sales'
import { dealSchema } from '@/lib/validation/schemas'

const open = OPEN_DEAL_STAGES[0]
const ok = { stage: open, owner_id: 'u1', next_step: 'Zavolat', next_step_due: '2026-10-01' }

describe('checkDealInvariant', () => {
  test('kompletní otevřený obchod je v pořádku', () => {
    expect(checkDealInvariant(ok)).toEqual([])
  })
  test('chybějící vlastník', () => {
    expect(checkDealInvariant({ ...ok, owner_id: null })).toEqual(['missing_owner'])
  })
  test('chybí krok nebo termín', () => {
    expect(checkDealInvariant({ ...ok, next_step: '  ' })).toEqual(['missing_next_step'])
    expect(checkDealInvariant({ ...ok, next_step_due: null })).toEqual(['missing_next_step'])
  })
  test('výslovný důvod nahrazuje další krok, ne vlastníka', () => {
    expect(checkDealInvariant({ ...ok, next_step: null, no_next_step_reason: 'Čeká na rozpočet' })).toEqual([])
    expect(checkDealInvariant({ stage: open, no_next_step_reason: 'x' })).toEqual(['missing_owner'])
  })
  test('chybějící sloupec (undefined před 0047) = null', () => {
    expect(checkDealInvariant({ stage: open, owner_id: 'u1' })).toEqual(['missing_next_step'])
  })
  test('uzavřené fáze se nekontrolují', () => {
    expect(checkDealInvariant({ stage: 'vyhráno' })).toEqual([])
    expect(checkDealInvariant({ stage: 'prohráno' })).toEqual([])
  })
})

describe('tolerantní zápis před migrací 0047', () => {
  test('rozpozná chybějící sloupec', () => {
    expect(isMissingColumnError({ code: '42703' })).toBe(true)
    expect(isMissingColumnError({ code: 'PGRST204' })).toBe(true)
    expect(isMissingColumnError({ code: '23505' })).toBe(false)
    expect(isMissingColumnError(null)).toBe(false)
  })
  test('na PGRST204 zopakuje zápis bez no_next_step_reason', async () => {
    const write = vi.fn()
      .mockResolvedValueOnce({ error: { code: 'PGRST204' } })
      .mockResolvedValueOnce({ error: null })
    const res = await writeWithoutMissingReason({ title: 'A', no_next_step_reason: 'x' }, write)
    expect(res.error).toBeNull()
    expect(write).toHaveBeenCalledTimes(2)
    expect(write.mock.calls[1][0]).toEqual({ title: 'A' })
  })
  test('jiné chyby se neopakují', async () => {
    const write = vi.fn().mockResolvedValue({ error: { code: '23505' } })
    const res = await writeWithoutMissingReason({ title: 'A', no_next_step_reason: null }, write)
    expect(res.error?.code).toBe('23505')
    expect(write).toHaveBeenCalledTimes(1)
  })
})

describe('dealSchema.no_next_step_reason', () => {
  const base = { account_id: 1, title: 'T', revenue_line: 'svatebni_hostina' }
  test('prázdné = null, trim, max 500', () => {
    expect(dealSchema.parse({ ...base, no_next_step_reason: '' }).no_next_step_reason).toBeNull()
    expect(dealSchema.parse({ ...base, no_next_step_reason: ' důvod ' }).no_next_step_reason).toBe('důvod')
    expect(dealSchema.safeParse({ ...base, no_next_step_reason: 'a'.repeat(501) }).success).toBe(false)
  })
})
