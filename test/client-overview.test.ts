import { describe, expect, it } from 'vitest'
import {
  buildActiveDays, clientStatus, czPlural, describeDue, pickNextStep,
  summarizeDeals, summarizeEngagements, summarizeTasks,
} from '@/domain/crm/clientOverview'

const TODAY = '2026-09-29' // úterý

describe('describeDue', () => {
  it('dnes, zítra, za N dní, po termínu, bez termínu', () => {
    expect(describeDue('2026-09-29', TODAY)).toBe('dnes')
    expect(describeDue('2026-09-30', TODAY)).toBe('zítra')
    expect(describeDue('2026-10-01', TODAY)).toBe('za 2 dny')
    expect(describeDue('2026-10-04', TODAY)).toBe('za 5 dní')
    expect(describeDue('2026-09-28', TODAY)).toBe('po termínu o 1 den')
    expect(describeDue('2026-09-20', TODAY)).toBe('po termínu o 9 dní')
    expect(describeDue(null, TODAY)).toBe('bez termínu')
  })
  it('czPlural', () => {
    expect([1, 2, 4, 5, 0].map((n) => czPlural(n, ['den', 'dny', 'dní']))).toEqual(['den', 'dny', 'dny', 'dní', 'dní'])
  })
})

describe('pickNextStep', () => {
  const deal = (over: object) => ({ stage: 'diagnostika', title: 'Agent', next_step: 'Zavolat', next_step_due: '2026-10-05', ...over }) as never
  const task = (over: object) => ({ status: 'todo', title: 'Úkol', due_on: '2026-10-02', ...over }) as never

  it('vybere nejbližší termín z kroků otevřených obchodů a úkolů', () => {
    const s = pickNextStep([deal({})], [task({})])
    expect(s).toMatchObject({ title: 'Úkol', source: 'task', due: '2026-10-02' })
    const d = pickNextStep([deal({ next_step_due: '2026-10-01' })], [task({})])
    expect(d).toMatchObject({ title: 'Zavolat', source: 'deal', context: 'Agent' })
  })
  it('přeskočí uzavřené obchody, hotové úkoly a prázdný text kroku', () => {
    expect(pickNextStep(
      [deal({ stage: 'vyhráno' }), deal({ next_step: '  ' })],
      [task({ status: 'done' })],
    )).toBeNull()
  })
  it('krok s termínem má přednost před krokem bez termínu', () => {
    const s = pickNextStep([deal({ next_step_due: null })], [task({ due_on: '2026-12-01' })])
    expect(s?.source).toBe('task')
  })
})

describe('shrnutí', () => {
  it('obchody: otevřené, vyhrané, součet otevřených', () => {
    const r = summarizeDeals([
      { stage: 'diagnostika', title: 'A', amount_one_time: 100 },
      { stage: 'rozhodovani', title: 'B', amount_one_time: '300' },
      { stage: 'vyhráno', title: 'C', amount_one_time: 999 },
    ] as never)
    expect(r).toMatchObject({ total: 3, open: 2, won: 1, openAmount: 400 })
    expect(r.lead).toEqual({ title: 'B', stageLabel: 'Zákazník rozhoduje' })
  })
  it('bez obchodů: nuly a žádný vedoucí obchod', () => {
    expect(summarizeDeals([])).toMatchObject({ total: 0, open: 0, won: 0, openAmount: 0, lead: null })
  })
  it('dodávky: běžící vs. uzavřené', () => {
    const r = summarizeEngagements([
      { kind: 'edu', phase: 'pilot', reference_worthy: false },
      { kind: 'it', phase: 'uzavreno', reference_worthy: true },
    ] as never)
    expect(r).toMatchObject({ total: 2, running: 1, closed: 1, referenceWorthy: 1 })
    expect(r.current).toEqual({ kind: 'edu', phaseLabel: 'Zkouška menu' })
  })
  it('úkoly: po termínu, do týdne, důležité, nejbližší termín', () => {
    const r = summarizeTasks([
      { status: 'todo', due_on: '2026-09-25', priority: 'high' },
      { status: 'in_progress', due_on: '2026-10-02', priority: 'normal' },
      { status: 'todo', due_on: '2026-11-01', priority: 'low' },
      { status: 'done', due_on: '2026-09-01', priority: 'high' },
    ] as never, TODAY)
    expect(r).toEqual({ open: 3, overdue: 1, thisWeek: 1, highPriority: 1, nearestDue: '2026-10-02' })
  })
})

describe('clientStatus', () => {
  it('otevřený obchod = aktivní, vyhraný/„klient od" = klient, jinak prospekt', () => {
    expect(clientStatus({ client_since: null }, [{ stage: 'diagnostika' }] as never)).toBe('aktivni')
    expect(clientStatus({ client_since: null }, [{ stage: 'vyhráno' }] as never)).toBe('klient')
    expect(clientStatus({ client_since: '2025-01-01' }, [])).toBe('klient')
    expect(clientStatus({ client_since: null }, [])).toBe('prospekt')
  })
})

describe('buildActiveDays', () => {
  it('14 týdnů × 7 dní, aktivní dny podle pražského kalendáře, budoucnost se nepočítá', () => {
    const r = buildActiveDays([
      { occurred_at: '2026-09-29T08:00:00Z' }, // dnes
      { occurred_at: '2026-09-29T15:00:00Z' }, // tentýž den → počítá se jednou
      { occurred_at: '2026-09-14T10:00:00Z' },
      { occurred_at: '2020-01-01T10:00:00Z' }, // mimo okno
    ], TODAY)
    expect(r.cells).toHaveLength(98)
    expect(r.activeCount).toBe(2)
    expect(r.cells[0].day).toBe('2026-06-29') // pondělí 13 týdnů před aktuálním týdnem
    expect(r.cells[r.cells.length - 1].future).toBe(true) // neděle 4. 10.
    expect(r.cells.filter((c) => c.future)).toHaveLength(5) // st–ne
  })
})
