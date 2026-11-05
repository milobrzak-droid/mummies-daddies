import { describe, expect, it } from 'vitest'
import {
  isWithinPragueWindow,
  nextMondayPrague0700,
  pragueLocalToUtc,
  pragueParts,
} from '@/worker/pragueTime'

const iso = (d: Date) => d.toISOString()

describe('pražský čas kolem přechodu na zimní čas (2026-10-25)', () => {
  it('03:00 letního času (01:00Z) se vrací na 02:00 zimního', () => {
    expect(pragueParts(new Date('2026-10-25T00:30:00Z')).hour).toBe(2) // CEST
    expect(pragueParts(new Date('2026-10-25T01:30:00Z')).hour).toBe(2) // CET
    expect(pragueParts(new Date('2026-10-25T06:00:00Z')).hour).toBe(7)
  })

  it('07:00 Praha před a po přechodu', () => {
    expect(iso(pragueLocalToUtc(2026, 10, 24, 7))).toBe('2026-10-24T05:00:00.000Z')
    expect(iso(pragueLocalToUtc(2026, 10, 25, 7))).toBe('2026-10-25T06:00:00.000Z')
    expect(iso(pragueLocalToUtc(2026, 3, 29, 7))).toBe('2026-03-29T05:00:00.000Z')
  })

  it('nextMondayPrague0700 přes víkend s přechodem', () => {
    // Pátek 23. 10. → pondělí 26. 10. už v CET = 06:00Z.
    expect(iso(nextMondayPrague0700(new Date('2026-10-23T12:00:00Z')))).toBe('2026-10-26T06:00:00.000Z')
    // Pondělí 19. 10. před sedmou (CEST) → týž den 05:00Z.
    expect(iso(nextMondayPrague0700(new Date('2026-10-19T04:59:00Z')))).toBe('2026-10-19T05:00:00.000Z')
    // Přesně v 07:00 → až další pondělí.
    expect(iso(nextMondayPrague0700(new Date('2026-10-19T05:00:00Z')))).toBe('2026-10-26T06:00:00.000Z')
    // Neděle 25. 10. 23:30 Praha (22:30Z) → pondělí 26. 10.
    expect(iso(nextMondayPrague0700(new Date('2026-10-25T22:30:00Z')))).toBe('2026-10-26T06:00:00.000Z')
    // Jarní přechod: pondělí 30. 3. 2026 v CEST.
    expect(iso(nextMondayPrague0700(new Date('2026-03-28T12:00:00Z')))).toBe('2026-03-30T05:00:00.000Z')
  })

  it('isWithinPragueWindow sleduje místní čas, ne UTC', () => {
    const win = { weekdays: [1], start: '07:00', end: '07:15' }
    expect(isWithinPragueWindow(new Date('2026-10-19T05:05:00Z'), win)).toBe(true) // CEST
    expect(isWithinPragueWindow(new Date('2026-10-26T05:05:00Z'), win)).toBe(false) // 06:05 CET
    expect(isWithinPragueWindow(new Date('2026-10-26T06:05:00Z'), win)).toBe(true)
    expect(isWithinPragueWindow(new Date('2026-10-27T06:05:00Z'), win)).toBe(false) // úterý
  })

  it('okno přes půlnoc', () => {
    const win = { start: '22:00', end: '06:00' }
    expect(isWithinPragueWindow(new Date('2026-10-25T22:30:00Z'), win)).toBe(true) // 23:30
    expect(isWithinPragueWindow(new Date('2026-10-26T04:59:00Z'), win)).toBe(true) // 05:59
    expect(isWithinPragueWindow(new Date('2026-10-26T05:00:00Z'), win)).toBe(false)
    expect(() => isWithinPragueWindow(new Date(), { start: '7:00', end: '08:00' })).toThrow()
  })
})
