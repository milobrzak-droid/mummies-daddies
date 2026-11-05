import { describe, expect, it } from 'vitest'
import { addDaysToPragueDay, daysBetweenPragueDays, pragueDayOf, pragueToday } from '@/lib/pragueDate'
import { dueFollowUps } from '@/domain/crm/followUp'
import { dueForOutreach } from '@/domain/crm/outreach'

describe('pragueDate', () => {
  it('00:30 Prague (léto) je už nový den, ač UTC je předchozí', () => {
    expect(pragueToday(new Date('2026-09-27T22:30:00Z'))).toBe('2026-09-28')
  })
  it('00:30 Prague (zima)', () => {
    expect(pragueDayOf('2026-01-14T23:30:00Z')).toBe('2026-01-15')
  })
  it('přes den stejné jako UTC', () => {
    expect(pragueDayOf(new Date('2026-09-28T10:00:00Z'))).toBe('2026-09-28')
  })
  it('DST konec 2026-10-25', () => {
    expect(pragueDayOf('2026-10-24T22:30:00Z')).toBe('2026-10-25') // 00:30 CEST
    expect(pragueDayOf('2026-10-25T22:30:00Z')).toBe('2026-10-25') // 23:30 CET
    expect(pragueDayOf('2026-10-25T23:00:00Z')).toBe('2026-10-26')
    expect(daysBetweenPragueDays('2026-10-24', '2026-10-26')).toBe(2)
  })
  it('DST začátek 2026-03-29', () => {
    expect(pragueDayOf('2026-03-28T23:30:00Z')).toBe('2026-03-29') // 00:30 CET
    expect(pragueDayOf('2026-03-29T21:59:00Z')).toBe('2026-03-29') // 23:59 CEST
    expect(pragueDayOf('2026-03-29T22:00:00Z')).toBe('2026-03-30')
    expect(daysBetweenPragueDays('2026-03-28', '2026-03-30')).toBe(2)
  })
  it('daysBetween a addDays', () => {
    expect(daysBetweenPragueDays('2026-09-30', '2026-09-28')).toBe(-2)
    expect(addDaysToPragueDay('2026-10-24', 7)).toBe('2026-10-31')
    expect(addDaysToPragueDay('2026-12-30', 3)).toBe('2027-01-02')
  })
})

describe('Pražský den v doménových funkcích (00:30 Prague)', () => {
  const at0030 = new Date('2026-09-27T22:30:00Z') // 2026-09-28 00:30 Praha
  it('follow-up se termínem dnes je splatný hned po pražské půlnoci', () => {
    const r = dueFollowUps([{ id: 1, title: 'X', account_name: null, owner_id: null, next_step: null,
      next_step_due: '2026-09-28', last_activity_at: null, follow_up_nudged_on: null, follow_up_escalated_on: null }], at0030)
    expect(r).toHaveLength(1)
    expect(r[0].days_overdue).toBe(0)
  })
  it('follow-up: nudged_on se porovnává s pražským dnem', () => {
    const r = dueFollowUps([{ id: 1, title: 'X', account_name: null, owner_id: null, next_step: null,
      next_step_due: '2026-09-20', last_activity_at: null, follow_up_nudged_on: null, follow_up_escalated_on: '2026-09-28' }], at0030)
    expect(r).toHaveLength(0)
  })
  it('follow-up: aktivita v 00:30 pražského dne termínu se počítá', () => {
    const r = dueFollowUps([{ id: 1, title: 'X', account_name: null, owner_id: null, next_step: null,
      next_step_due: '2026-09-28', last_activity_at: '2026-09-27T22:15:00Z', follow_up_nudged_on: null, follow_up_escalated_on: null }], at0030)
    expect(r).toHaveLength(0)
  })
  it('outreach: snooze do dneška (pražského) už nevyřazuje', () => {
    const base = { id: 1, name: 'A', has_open_deal: false, nudged_on: null,
      last_outbound_at: '2026-08-01T10:00:00Z', last_inbound_at: null }
    expect(dueForOutreach([{ ...base, snooze_until: '2026-09-28' }], at0030)).toHaveLength(1)
    expect(dueForOutreach([{ ...base, snooze_until: '2026-09-29' }], at0030)).toHaveLength(0)
    expect(dueForOutreach([{ ...base, snooze_until: null, nudged_on: '2026-09-28' }], at0030)).toHaveLength(0)
  })
})
