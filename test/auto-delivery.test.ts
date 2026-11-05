import { describe, expect, test } from 'vitest'
import {
  AUTO_DELIVERY_MISSING_MESSAGE,
  AUTO_DELIVERY_NOT_WON_MESSAGE,
  autoDeliveryDbMessage,
  isAutoDelivery,
  isAutoDeliveryMissing,
  parseEnsureResult,
  startTaskInfo,
  summarizeDealDeliveries,
  workingDaysLabel,
} from '@/domain/delivery/autoDelivery'

// Čistá logika automatického založení dodávky (0080): rozpoznání původu,
// shrnutí stavu dodávky u vyhraného obchodu pro kartu a překlad chyb RPC.

const d = (id: number, origin?: string | null) => ({ id, origin, kind: 'it', phase: 'analyza' })

describe('isAutoDelivery', () => {
  test('jen origin auto_deal_won; chybějící sloupec (před 0080) i manual jsou ruční', () => {
    expect(isAutoDelivery({ origin: 'auto_deal_won' })).toBe(true)
    expect(isAutoDelivery({ origin: 'manual' })).toBe(false)
    expect(isAutoDelivery({})).toBe(false)
    expect(isAutoDelivery(null)).toBe(false)
  })
})

describe('summarizeDealDeliveries', () => {
  test('žádná dodávka = missing (záložní tlačítko)', () => {
    expect(summarizeDealDeliveries([])).toEqual({ state: 'missing' })
  })
  test('aspoň jedna automatická = auto, automatická první', () => {
    const s = summarizeDealDeliveries([d(5, 'manual'), d(9, 'auto_deal_won'), d(2, 'manual')])
    expect(s.state).toBe('auto')
    expect(s.state === 'auto' && s.deliveries.map((x) => x.id)).toEqual([9, 2, 5])
  })
  test('jen ruční (nebo bez sloupce origin) = manual', () => {
    expect(summarizeDealDeliveries([d(3, 'manual')]).state).toBe('manual')
    expect(summarizeDealDeliveries([d(3)]).state).toBe('manual')
  })
  test('vstup se nemění', () => {
    const input = [d(2), d(1, 'auto_deal_won')]
    summarizeDealDeliveries(input)
    expect(input.map((x) => x.id)).toEqual([2, 1])
  })
})

describe('chyby RPC ensure_deal_delivery', () => {
  test('chybějící funkce (před 0080): 42883, PGRST202 i text', () => {
    expect(isAutoDeliveryMissing({ code: '42883' })).toBe(true)
    expect(isAutoDeliveryMissing({ code: 'PGRST202' })).toBe(true)
    expect(isAutoDeliveryMissing({ message: 'Could not find the function public.ensure_deal_delivery(p_deal_id) in the schema cache' })).toBe(true)
    expect(isAutoDeliveryMissing({ code: '42501', message: 'x' })).toBe(false)
    expect(isAutoDeliveryMissing(null)).toBe(false)
  })
  test('české věty pro známé chyby, jinak null', () => {
    expect(autoDeliveryDbMessage({ code: '42883' })).toBe(AUTO_DELIVERY_MISSING_MESSAGE)
    expect(AUTO_DELIVERY_MISSING_MESSAGE).toContain('0080')
    expect(autoDeliveryDbMessage({ code: 'AD001' })).toBe(AUTO_DELIVERY_NOT_WON_MESSAGE)
    expect(autoDeliveryDbMessage({ code: '23505' })).toBeNull()
    expect(autoDeliveryDbMessage(null)).toBeNull()
  })
})

describe('parseEnsureResult', () => {
  test('platný výsledek; neplatný tvar = null', () => {
    expect(parseEnsureResult({ engagement_id: 12, created: true })).toEqual({ engagementId: 12, created: true })
    expect(parseEnsureResult({ engagement_id: '12', created: false })).toEqual({ engagementId: 12, created: false })
    for (const bad of [null, undefined, 'x', {}, { engagement_id: 0 }, { engagement_id: -1 }, { engagement_id: 'a' }]) {
      expect(parseEnsureResult(bad)).toBeNull()
    }
  })
})

describe('text úkolu z configu', () => {
  test('startTaskInfo čte config firmy', () => {
    expect(startTaskInfo()).toEqual({ title: 'Naplánovat realizaci akce', workingDays: 2 })
  })
  test('pracovní dny se skloňují', () => {
    expect(workingDaysLabel(1)).toBe('1 pracovního dne')
    expect(workingDaysLabel(3)).toBe('3 pracovních dnů')
    expect(workingDaysLabel(5)).toBe('5 pracovních dnů')
  })
})
