// Pracovní dny v Česku (lib/businessDays.ts): víkendy, pevné svátky
// a Velikonoce výpočtem.
import { describe, expect, test } from 'vitest'
import { addBusinessDays, czechHolidays, easterSunday, isBusinessDay, isCzechHoliday, isoWeekday } from '@/lib/businessDays'

describe('Velikonoce', () => {
  test.each([
    [2024, '2024-03-31'],
    [2025, '2025-04-20'],
    [2026, '2026-04-05'],
    [2027, '2027-03-28'],
    [2028, '2028-04-16'],
  ])('%i → %s', (year, day) => expect(easterSunday(year)).toBe(day))

  test('2026: Velký pátek 3. 4. a Velikonoční pondělí 6. 4. jsou volno', () => {
    expect(isBusinessDay('2026-04-02')).toBe(true)
    expect(isCzechHoliday('2026-04-03')).toBe(true)
    expect(isCzechHoliday('2026-04-06')).toBe(true)
    expect(isBusinessDay('2026-04-07')).toBe(true)
    // Čtvrtek před Velikonocemi + 1 pracovní den = úterý po nich.
    expect(addBusinessDays('2026-04-02', 1)).toBe('2026-04-07')
  })

  test('2027: Velký pátek 26. 3. a Velikonoční pondělí 29. 3.', () => {
    expect(isCzechHoliday('2027-03-26')).toBe(true)
    expect(isCzechHoliday('2027-03-29')).toBe(true)
    expect(addBusinessDays('2027-03-25', 1)).toBe('2027-03-30')
  })
})

describe('pevné svátky', () => {
  test('rok má 13 dnů volna (11 pevných + 2 velikonoční)', () => {
    expect(czechHolidays(2026).size).toBe(13)
  })

  test('Vánoce: 24.–26. 12. volno, 23. 12. a 27. 12. 2027 pracovní', () => {
    for (const d of ['2026-12-24', '2026-12-25', '2026-12-26']) expect(isCzechHoliday(d)).toBe(true)
    expect(isBusinessDay('2026-12-23')).toBe(true)
    // St 23. 12. 2026 + 1 = po 28. 12. (24.–25. svátek, víkend).
    expect(addBusinessDays('2026-12-23', 1)).toBe('2026-12-28')
    expect(isBusinessDay('2027-12-27')).toBe(true)
  })

  test('28. 10. (st 2026) není pracovní den', () => {
    expect(isBusinessDay('2026-10-28')).toBe(false)
    expect(addBusinessDays('2026-10-27', 1)).toBe('2026-10-29')
  })

  test('Nový rok, 1. a 8. 5., 5. a 6. 7., 28. 9., 17. 11.', () => {
    for (const d of ['2027-01-01', '2027-05-01', '2027-05-08', '2027-07-05', '2027-07-06', '2027-09-28', '2027-11-17']) {
      expect(isCzechHoliday(d), d).toBe(true)
    }
  })
})

describe('víkend a sčítání', () => {
  test('ISO den v týdnu', () => {
    expect(isoWeekday('2026-11-02')).toBe(1) // pondělí
    expect(isoWeekday('2026-11-08')).toBe(7) // neděle
  })

  test('pátek + 1 = pondělí; pátek + 3 = středa', () => {
    expect(addBusinessDays('2026-11-06', 1)).toBe('2026-11-09')
    expect(addBusinessDays('2026-11-06', 3)).toBe('2026-11-11')
  })

  test('sobota + 1 = pondělí; 0 = stejný den', () => {
    expect(addBusinessDays('2026-11-07', 1)).toBe('2026-11-09')
    expect(addBusinessDays('2026-11-07', 0)).toBe('2026-11-07')
  })

  test('přes svátek a víkend: čt 12. 11. 2026 + 5 = pá 20. 11. (17. 11. je út)', () => {
    expect(addBusinessDays('2026-11-12', 5)).toBe('2026-11-20')
  })

  test('přes přelom roku', () => {
    // Út 29. 12. 2026 + 3: st 30., čt 31., (pá 1. 1. svátek) po 4. 1.
    expect(addBusinessDays('2026-12-29', 3)).toBe('2027-01-04')
  })

  test('neplatný den vyhodí', () => {
    expect(() => addBusinessDays('2026-13-01', 1)).toThrow()
    expect(() => isBusinessDay('včera')).toThrow()
  })
})
