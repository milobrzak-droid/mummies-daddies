import { describe, expect, test } from 'vitest'
import {
  ALLOCATION_STATUS_LABEL,
  DEFAULT_WEEKLY_CAPACITY,
  NOTE_MAX,
  PLAN_WEEKS,
  allocationHoursInWeek,
  allocationStatus,
  canSetCapacity,
  capacityOf,
  capacityPlan,
  capacityWarnings,
  describeAllocations,
  formatDay,
  formatHours,
  formatHoursValue,
  formatPeriod,
  formatWeekRange,
  isIsoDay,
  isOverloaded,
  isoWeekOf,
  isoWeekday,
  memberWeekLoads,
  parseAllocationCreate,
  parseAllocationUpdate,
  parseCapacity,
  parseTargetKey,
  planAllocationEnd,
  planWeeks,
  substitutionEdges,
  substitutionSummary,
  targetKey,
  weekLabel,
  weeksFrom,
  workdaysCovered,
  type AllocationLike,
} from '@/domain/delivery/capacity'

// domain/delivery/capacity.ts — kapacity a alokace (kap. 10, migrace 0062).
// Hlídáme ISO týdny v pásmu firmy (včetně přechodu roku a DST), prorata
// částečných týdnů, přetížení, zastupitelnost, varování a vstupy formulářů.

const A = '00000000-0000-4000-8000-00000000000a'
const B = '00000000-0000-4000-8000-00000000000b'
const C = '00000000-0000-4000-8000-00000000000c'

let nextId = 1
function alloc(p: Partial<AllocationLike> & { member_id: string }): AllocationLike {
  return {
    id: nextId++,
    hours_per_week: 10,
    starts_on: '2026-09-01',
    ends_on: null,
    substitute_id: null,
    ...p,
  }
}

const W40 = isoWeekOf('2026-09-28') // Po 28. 9. – Ne 4. 10. 2026

describe('kalendářní dny', () => {
  test('isIsoDay přijme jen existující den ve tvaru YYYY-MM-DD', () => {
    expect(isIsoDay('2026-09-28')).toBe(true)
    expect(isIsoDay('2028-02-29')).toBe(true)
    expect(isIsoDay('2026-02-29')).toBe(false)
    expect(isIsoDay('2026-02-30')).toBe(false)
    expect(isIsoDay('2026-9-28')).toBe(false)
    expect(isIsoDay('28. 9. 2026')).toBe(false)
    expect(isIsoDay(null)).toBe(false)
  })

  test('isoWeekday: pondělí 1 … neděle 7', () => {
    expect(isoWeekday('2026-09-28')).toBe(1)
    expect(isoWeekday('2026-10-02')).toBe(5)
    expect(isoWeekday('2026-10-04')).toBe(7)
  })
})

describe('isoWeekOf — ISO 8601 týdny', () => {
  test('pondělí i neděle patří do stejného týdne', () => {
    expect(W40).toEqual({ key: '2026-W40', year: 2026, week: 40, start: '2026-09-28', end: '2026-10-04' })
    expect(isoWeekOf('2026-10-04')).toEqual(W40)
    expect(isoWeekOf('2026-10-01')).toEqual(W40)
  })

  test('přechod roku: 1. 1. 2027 (pátek) patří do 53. týdne 2026', () => {
    expect(isoWeekOf('2027-01-01')).toMatchObject({ key: '2026-W53', year: 2026, week: 53, start: '2026-12-28' })
    expect(isoWeekOf('2027-01-04')).toMatchObject({ key: '2027-W01', start: '2027-01-04' })
  })

  test('přechod roku: 29. 12. 2025 (pondělí) je už 1. týden 2026', () => {
    expect(isoWeekOf('2025-12-29')).toMatchObject({ key: '2026-W01', year: 2026, week: 1, end: '2026-01-04' })
    expect(isoWeekOf('2024-12-30')).toMatchObject({ key: '2025-W01' })
  })

  test('neplatný den vyhodí chybu', () => {
    expect(() => isoWeekOf('2026-02-30')).toThrow()
  })

  test('weeksFrom: souvislá řada od týdne daného dne, i přes konec roku', () => {
    const w = weeksFrom('2026-09-30', PLAN_WEEKS)
    expect(w).toHaveLength(8)
    expect(w.map((x) => x.week)).toEqual([40, 41, 42, 43, 44, 45, 46, 47])
    expect(w[1].start).toBe('2026-10-05')
    expect(weeksFrom('2026-12-20', 4).map((x) => x.key)).toEqual(['2026-W51', '2026-W52', '2026-W53', '2027-W01'])
    expect(weeksFrom('2026-09-30', 0)).toEqual([])
  })
})

describe('planWeeks — „tento týden" podle pražského času, ne UTC', () => {
  test('neděle 22:30 UTC v létě je v Praze pondělí → nový týden', () => {
    expect(planWeeks(new Date('2026-10-04T22:30:00Z'))[0].start).toBe('2026-10-05')
    expect(planWeeks(new Date('2026-10-04T21:30:00Z'))[0].start).toBe('2026-09-28')
  })

  test('v zimě stačí 23:30 UTC', () => {
    expect(planWeeks(new Date('2026-11-29T23:30:00Z'))[0].start).toBe('2026-11-30')
    expect(planWeeks(new Date('2026-11-29T22:30:00Z'))[0].start).toBe('2026-11-23')
  })

  test('noc přechodu na letní čas (29. 3. 2026)', () => {
    expect(planWeeks(new Date('2026-03-29T21:30:00Z'))[0].start).toBe('2026-03-23') // Ne 23:30 CEST
    expect(planWeeks(new Date('2026-03-29T22:30:00Z'))[0].start).toBe('2026-03-30') // Po 00:30 CEST
  })

  test('noc přechodu na zimní čas (25. 10. 2026)', () => {
    expect(planWeeks(new Date('2026-10-25T22:30:00Z'))[0].start).toBe('2026-10-19') // Ne 23:30 CET
    expect(planWeeks(new Date('2026-10-25T23:00:00Z'))[0].start).toBe('2026-10-26') // Po 00:00 CET
  })

  test('výchozí délka plánu je 8 týdnů', () => {
    expect(planWeeks(new Date('2026-09-28T10:00:00Z'))).toHaveLength(PLAN_WEEKS)
  })
})

describe('workdaysCovered a allocationHoursInWeek — částečné týdny', () => {
  test('celý týden = 5 pracovních dnů', () => {
    expect(workdaysCovered({ starts_on: '2026-09-01', ends_on: null }, W40)).toBe(5)
    expect(workdaysCovered({ starts_on: '2026-09-28', ends_on: '2026-10-04' }, W40)).toBe(5)
  })

  test('začátek ve středu = 3 dny, konec v úterý = 2 dny', () => {
    expect(workdaysCovered({ starts_on: '2026-09-30', ends_on: null }, W40)).toBe(3)
    expect(workdaysCovered({ starts_on: '2026-09-01', ends_on: '2026-09-29' }, W40)).toBe(2)
    expect(workdaysCovered({ starts_on: '2026-09-29', ends_on: '2026-10-01' }, W40)).toBe(3)
  })

  test('jediný den a víkend', () => {
    expect(workdaysCovered({ starts_on: '2026-09-28', ends_on: '2026-09-28' }, W40)).toBe(1)
    expect(workdaysCovered({ starts_on: '2026-10-03', ends_on: null }, W40)).toBe(0) // sobota
    expect(workdaysCovered({ starts_on: '2026-10-04', ends_on: '2026-10-04' }, W40)).toBe(0) // neděle
    expect(workdaysCovered({ starts_on: '2026-09-01', ends_on: '2026-10-03' }, W40)).toBe(5) // konec v sobotu
  })

  test('mimo týden = 0', () => {
    expect(workdaysCovered({ starts_on: '2026-10-05', ends_on: null }, W40)).toBe(0)
    expect(workdaysCovered({ starts_on: '2026-09-01', ends_on: '2026-09-27' }, W40)).toBe(0)
  })

  test('týdny s přechodem času mají pořád 5 pracovních dnů', () => {
    const open = { starts_on: '2026-01-01', ends_on: null }
    expect(workdaysCovered(open, isoWeekOf('2026-03-29'))).toBe(5) // na letní
    expect(workdaysCovered(open, isoWeekOf('2026-10-25'))).toBe(5) // na zimní
    expect(allocationHoursInWeek(alloc({ member_id: A, hours_per_week: 20, starts_on: '2026-03-25' }), isoWeekOf('2026-03-29'))).toBe(12)
  })

  test('hodiny poměrem pracovních dnů', () => {
    expect(allocationHoursInWeek(alloc({ member_id: A, hours_per_week: 20, starts_on: '2026-09-30' }), W40)).toBe(12)
    expect(allocationHoursInWeek(alloc({ member_id: A, hours_per_week: 7, starts_on: '2026-10-02' }), W40)).toBe(1.4)
    expect(allocationHoursInWeek(alloc({ member_id: A, hours_per_week: '7.5' }), W40)).toBe(7.5)
    expect(allocationHoursInWeek(alloc({ member_id: A, hours_per_week: 'x' }), W40)).toBe(0)
  })
})

describe('kapacita a zatížení', () => {
  test('capacityOf: chybějící sloupec (před 0062) = 40 h, text z numeric se převede', () => {
    expect(capacityOf({ id: A })).toBe(DEFAULT_WEEKLY_CAPACITY)
    expect(capacityOf({ id: A, weekly_capacity_hours: null })).toBe(40)
    expect(capacityOf({ id: A, weekly_capacity_hours: '32.5' })).toBe(32.5)
    expect(capacityOf({ id: A, weekly_capacity_hours: 0 })).toBe(0)
    expect(capacityOf({ id: A, weekly_capacity_hours: -5 })).toBe(40)
  })

  test('isOverloaded: rovnost ještě není přetížení', () => {
    expect(isOverloaded(40, 40)).toBe(false)
    expect(isOverloaded(40.004, 40)).toBe(false)
    expect(isOverloaded(40.5, 40)).toBe(true)
    expect(isOverloaded(0.5, 0)).toBe(true)
  })

  test('součet alokací nad kapacitou = přetížení se zápornou rezervou', () => {
    const allocations = [alloc({ member_id: A, hours_per_week: 30 }), alloc({ member_id: A, hours_per_week: 15 })]
    const [w] = memberWeekLoads({ id: A, weekly_capacity_hours: 40 }, allocations, [W40])
    expect(w).toMatchObject({ load: 45, capacity: 40, free: -5, utilization: 1.125, overloaded: true })
  })

  test('přesně na kapacitě a cizí alokace se nepočítají', () => {
    const allocations = [alloc({ member_id: A, hours_per_week: 40 }), alloc({ member_id: B, hours_per_week: 30 })]
    const [w] = memberWeekLoads({ id: A }, allocations, [W40])
    expect(w).toMatchObject({ load: 40, free: 0, overloaded: false, utilization: 1 })
  })

  test('kapacita 0: jakákoli alokace je přetížení, vytížení nelze spočítat', () => {
    const [w] = memberWeekLoads({ id: A, weekly_capacity_hours: 0 }, [alloc({ member_id: A, hours_per_week: 5 })], [W40])
    expect(w).toMatchObject({ load: 5, capacity: 0, overloaded: true, utilization: null })
  })

  test('alokace od středy do úterý o dva týdny později: 12 / 20 / 8 / 0', () => {
    const weeks = weeksFrom('2026-09-28', 4)
    const allocations = [alloc({ member_id: A, hours_per_week: 20, starts_on: '2026-09-30', ends_on: '2026-10-13' })]
    expect(memberWeekLoads({ id: A }, allocations, weeks).map((w) => w.load)).toEqual([12, 20, 8, 0])
  })

  test('capacityPlan drží pořadí lidí a počítá přetížené týdny', () => {
    const weeks = weeksFrom('2026-09-28', 3)
    const allocations = [
      alloc({ member_id: B, hours_per_week: 25, ends_on: '2026-10-11' }),
      alloc({ member_id: B, hours_per_week: 20 }),
    ]
    const plan = capacityPlan([{ id: A }, { id: B, weekly_capacity_hours: 40 }], allocations, weeks)
    expect(plan.map((p) => p.member.id)).toEqual([A, B])
    expect(plan[0].overloadedWeeks).toBe(0)
    expect(plan[1].weeks.map((w) => w.load)).toEqual([45, 45, 20])
    expect(plan[1].overloadedWeeks).toBe(2)
  })
})

describe('stav a ukončení alokace', () => {
  const today = '2026-09-28'

  test('allocationStatus', () => {
    expect(allocationStatus({ starts_on: '2026-10-01', ends_on: null }, today)).toBe('planned')
    expect(allocationStatus({ starts_on: '2026-09-01', ends_on: null }, today)).toBe('active')
    expect(allocationStatus({ starts_on: '2026-09-01', ends_on: today }, today)).toBe('active')
    expect(allocationStatus({ starts_on: '2026-09-01', ends_on: '2026-09-27' }, today)).toBe('ended')
    expect(ALLOCATION_STATUS_LABEL.ended).toBe('Skončilo')
  })

  test('běžící alokace končí dneškem', () => {
    expect(planAllocationEnd({ starts_on: '2026-09-01', ends_on: null }, today)).toEqual({ kind: 'set_end', ends_on: today })
    expect(planAllocationEnd({ starts_on: today, ends_on: '2026-12-31' }, today)).toEqual({ kind: 'set_end', ends_on: today })
  })

  test('ještě nezačala → smazat (ends_on = dnes by porušil CHECK)', () => {
    expect(planAllocationEnd({ starts_on: '2026-10-05', ends_on: null }, today)).toEqual({ kind: 'delete' })
  })

  test('už skončila nebo dnes končí → nic', () => {
    expect(planAllocationEnd({ starts_on: '2026-09-01', ends_on: '2026-09-20' }, today)).toEqual({ kind: 'already_ended' })
    expect(planAllocationEnd({ starts_on: '2026-09-01', ends_on: today }, today)).toEqual({ kind: 'already_ended' })
  })
})

describe('zastupitelnost', () => {
  const today = '2026-09-28'

  test('substitutionEdges slučuje dvojice a ignoruje skončené i sebe sama', () => {
    const a1 = alloc({ member_id: A, substitute_id: B })
    const a2 = alloc({ member_id: A, substitute_id: B, starts_on: '2026-10-10' })
    const ended = alloc({ member_id: A, substitute_id: C, ends_on: '2026-09-27' })
    const self = alloc({ member_id: C, substitute_id: C })
    const none = alloc({ member_id: B })
    expect(substitutionEdges([a1, a2, ended, self, none], today)).toEqual([
      { memberId: A, substituteId: B, allocationIds: [a1.id, a2.id] },
    ])
  })

  test('substitutionSummary: kdo koho zastupuje a kolik alokací je bez zástupu', () => {
    const allocations = [
      alloc({ member_id: A, substitute_id: B }),
      alloc({ member_id: B, substitute_id: A }),
      alloc({ member_id: B, substitute_id: C }),
      alloc({ member_id: C }),
      alloc({ member_id: C, ends_on: '2026-09-01' }),
    ]
    const s = substitutionSummary([{ id: A }, { id: B }, { id: C }], allocations, today)
    expect(s).toEqual([
      { memberId: A, substitutes: [B], substitutesFor: [B], withoutSubstitute: 0 },
      { memberId: B, substitutes: [A, C], substitutesFor: [A], withoutSubstitute: 0 },
      { memberId: C, substitutes: [], substitutesFor: [B], withoutSubstitute: 1 },
    ])
  })
})

describe('capacityWarnings', () => {
  const weeks = weeksFrom('2026-09-28', 4)

  test('přetížení nese týdny a špičku', () => {
    const allocations = [
      alloc({ member_id: A, hours_per_week: 30, substitute_id: B }),
      alloc({ member_id: A, hours_per_week: 20, substitute_id: B, starts_on: '2026-10-05', ends_on: '2026-10-18' }),
    ]
    const w = capacityWarnings([{ id: A }, { id: B, weekly_capacity_hours: 80 }], allocations, weeks, '2026-09-28')
    expect(w[0]).toEqual({ kind: 'overload', memberId: A, weekKeys: ['2026-W41', '2026-W42'], peakLoad: 50, capacity: 40 })
    expect(w).toHaveLength(1)
  })

  test('bez zástupu jen pro alokace, které do plánu zasahují', () => {
    const inPlan = alloc({ member_id: A })
    const before = alloc({ member_id: A, ends_on: '2026-09-20' })
    const after = alloc({ member_id: A, starts_on: '2026-12-01' })
    const w = capacityWarnings([{ id: A }], [inPlan, before, after], weeks, '2026-09-28')
    expect(w).toEqual([{ kind: 'no_substitute', allocationId: inPlan.id, memberId: A }])
  })

  test('zástup bez rezervy: jeho plán + převzaté hodiny > kapacita (první takový týden)', () => {
    const own = alloc({ member_id: B, hours_per_week: 35, starts_on: '2026-10-05', substitute_id: A })
    const covered = alloc({ member_id: A, hours_per_week: 10, substitute_id: B })
    // A má rezervu na B (80 h), takže varování je jen jedno — pro A → B.
    const w = capacityWarnings([{ id: A, weekly_capacity_hours: 80 }, { id: B }], [own, covered], weeks, '2026-09-28')
    expect(w).toContainEqual({
      kind: 'substitute_no_room',
      allocationId: covered.id,
      memberId: A,
      substituteId: B,
      weekKey: '2026-W41',
      needed: 10,
      free: 5,
    })
    expect(w.filter((x) => x.kind === 'substitute_no_room')).toHaveLength(1)
  })

  test('alokace skončená dřív tento týden už varování o zástupu nedává', () => {
    const wk = weeksFrom('2026-09-30', 4)
    const endedMonday = alloc({ member_id: A, starts_on: '2026-09-01', ends_on: '2026-09-28' })
    const endedMondayWithSub = alloc({ member_id: A, hours_per_week: 45, starts_on: '2026-09-01', ends_on: '2026-09-28', substitute_id: B })
    const w = capacityWarnings([{ id: A }, { id: B }], [endedMonday, endedMondayWithSub], wk, '2026-09-30')
    expect(w.filter((x) => x.kind !== 'overload')).toEqual([])
  })

  test('zástup s rezervou je v pořádku', () => {
    const covered = alloc({ member_id: A, hours_per_week: 10, substitute_id: B })
    expect(capacityWarnings([{ id: A }, { id: B }], [covered], weeks, '2026-09-28')).toEqual([])
  })

  test('pořadí: přetížení, zástup bez rezervy, bez zástupu; cizí lidé se ignorují', () => {
    const noSub = alloc({ member_id: C, hours_per_week: 5 })
    const noRoom = alloc({ member_id: A, hours_per_week: 10, substitute_id: B })
    const heavy = alloc({ member_id: B, hours_per_week: 45, substitute_id: A })
    const stranger = alloc({ member_id: '00000000-0000-4000-8000-0000000000ff' })
    const w = capacityWarnings([{ id: A }, { id: B }, { id: C }], [noSub, noRoom, heavy, stranger], weeks, '2026-09-28')
    // noRoom: B má 45 h + 10 h za A; heavy: A má 10 h + 45 h za B.
    expect(w.map((x) => x.kind)).toEqual(['overload', 'substitute_no_room', 'substitute_no_room', 'no_substitute'])
    expect(w.filter((x) => x.kind === 'substitute_no_room').map((x) => 'allocationId' in x && x.allocationId)).toEqual([noRoom.id, heavy.id])
  })
})

describe('canSetCapacity (zrcadlo set_weekly_capacity)', () => {
  test('admin a vedení komukoli, ostatní jen sobě, nepřihlášený nikomu', () => {
    expect(canSetCapacity({ id: A, teamRole: 'partner', isAdmin: true }, B)).toBe(true)
    expect(canSetCapacity({ id: A, teamRole: 'vedeni', isAdmin: false }, B)).toBe(true)
    expect(canSetCapacity({ id: A, teamRole: 'projektak', isAdmin: false }, A)).toBe(true)
    expect(canSetCapacity({ id: A, teamRole: 'obchodnik', isAdmin: false }, B)).toBe(false)
    expect(canSetCapacity(null, A)).toBe(false)
  })
})

describe('cíl alokace', () => {
  test('targetKey ↔ parseTargetKey', () => {
    expect(targetKey({ engagement_id: 12, work_case_id: null })).toBe('engagement:12')
    expect(targetKey({ engagement_id: null, work_case_id: 5 })).toBe('case:5')
    expect(parseTargetKey('engagement:12')).toEqual({ engagement_id: 12, work_case_id: null })
    expect(parseTargetKey(' case:5 ')).toEqual({ engagement_id: null, work_case_id: 5 })
  })

  test('neplatné cíle', () => {
    for (const v of ['engagement:0', 'engagement:-1', 'deal:1', 'case:abc', 'case:', '', 'case:99999999999999999', 5, null]) {
      expect(parseTargetKey(v), String(v)).toBeNull()
    }
  })
})

describe('parseAllocationCreate', () => {
  const base = { member_id: A, target: 'engagement:7', hours_per_week: '7,5', starts_on: '2026-10-01', ends_on: '', substitute_id: '', note: '  ' }

  test('platný vstup: čárka v hodinách, prázdné = null, cíl z pole target', () => {
    expect(parseAllocationCreate(base)).toEqual({
      ok: true,
      data: {
        member_id: A,
        engagement_id: 7,
        work_case_id: null,
        hours_per_week: 7.5,
        starts_on: '2026-10-01',
        ends_on: null,
        substitute_id: null,
        note: null,
      },
    })
  })

  test('pevný cíl stránky má přednost před polem target', () => {
    const r = parseAllocationCreate({ ...base, target: 'case:3' }, { engagement_id: 9, work_case_id: null })
    expect(r.ok && r.data).toMatchObject({ engagement_id: 9, work_case_id: null })
    const noField = parseAllocationCreate({ ...base, target: undefined }, { engagement_id: null, work_case_id: 4 })
    expect(noField.ok && noField.data).toMatchObject({ engagement_id: null, work_case_id: 4 })
  })

  test('hodiny se zaokrouhlí na desetiny', () => {
    const r = parseAllocationCreate({ ...base, hours_per_week: '12.34' })
    expect(r.ok && r.data.hours_per_week).toBe(12.3)
  })

  test('chybí cíl nebo člověk', () => {
    const r = parseAllocationCreate({ ...base, target: '', member_id: '' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.fieldErrors.target).toBe('Vyber dodávku nebo případ.')
      expect(r.fieldErrors.member_id).toBeTruthy()
    }
  })

  test('zástup nesmí být ten samý člověk, konec ne před začátkem', () => {
    const r = parseAllocationCreate({ ...base, substitute_id: A, ends_on: '2026-09-30' })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.fieldErrors.substitute_id).toBeTruthy()
      expect(r.fieldErrors.ends_on).toBe('Konec nesmí být před začátkem.')
    }
  })

  test('hodiny mimo 0,1–80 nebo nečíselné', () => {
    for (const h of ['0', '0.05', '80.5', 'abc', '', '-3']) {
      const r = parseAllocationCreate({ ...base, hours_per_week: h })
      expect(r.ok, h).toBe(false)
      if (!r.ok) expect(r.fieldErrors.hours_per_week, h).toBeTruthy()
    }
    const max = parseAllocationCreate({ ...base, hours_per_week: '80' })
    expect(max.ok).toBe(true)
  })

  test('neexistující datum a dlouhá poznámka', () => {
    const r = parseAllocationCreate({ ...base, starts_on: '2026-02-30', note: 'x'.repeat(NOTE_MAX + 1) })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.fieldErrors.starts_on).toBe('Neplatné datum.')
      expect(r.fieldErrors.note).toBeTruthy()
    }
  })
})

describe('parseAllocationUpdate a parseCapacity', () => {
  test('úprava: zástup ≠ člověk z řádku alokace', () => {
    const input = { hours_per_week: '10', starts_on: '2026-10-01', ends_on: '2026-10-31', substitute_id: B, note: 'Workshopy' }
    expect(parseAllocationUpdate(input, A)).toEqual({
      ok: true,
      data: { hours_per_week: 10, starts_on: '2026-10-01', ends_on: '2026-10-31', substitute_id: B, note: 'Workshopy' },
    })
    const r = parseAllocationUpdate(input, B)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(Object.keys(r.fieldErrors)).toEqual(['substitute_id'])
  })

  test('kapacita 0–80, desetiny', () => {
    expect(parseCapacity({ weekly_capacity_hours: '0' })).toEqual({ ok: true, data: { weekly_capacity_hours: 0 } })
    expect(parseCapacity({ weekly_capacity_hours: '32,5' })).toEqual({ ok: true, data: { weekly_capacity_hours: 32.5 } })
    for (const v of ['80.5', '-1', '', 'hodně']) {
      const r = parseCapacity({ weekly_capacity_hours: v })
      expect(r.ok, v).toBe(false)
    }
  })
})

describe('formátování', () => {
  test('hodiny, dny, období a týden', () => {
    expect(formatHours(7.5)).toBe('7,5 h')
    expect(formatHours(40)).toBe('40 h')
    expect(formatHours(12.345)).toBe('12,3 h')
    expect(formatDay('2026-10-01')).toBe('1. 10. 2026')
    expect(formatPeriod({ starts_on: '2026-10-01', ends_on: null })).toBe('od 1. 10. 2026')
    expect(formatPeriod({ starts_on: '2026-10-01', ends_on: '2026-11-30' })).toBe('1. 10. 2026 – 30. 11. 2026')
    expect(formatWeekRange(W40)).toBe('28. 9. – 4. 10.')
    expect(formatHoursValue(32.5)).toBe('32,5')
    expect(weekLabel(W40)).toBe('T40')
  })
})

describe('describeAllocations', () => {
  const today = '2026-09-28'
  const names = new Map([[A, 'Alena'], [B, 'Bořek']])
  const targets = new Map([
    ['engagement:3', { label: 'Gamaplast · Firemní akce', href: '/cockpit/clients/1/engagements/3/edit' }],
    ['case:4', { label: 'Audit', href: '/cockpit/pripady/4' }],
  ])
  const row = (p: Partial<AllocationLike> & { member_id: string; engagement_id?: number | null; work_case_id?: number | null }) => ({
    engagement_id: null as number | null,
    work_case_id: null as number | null,
    ...alloc(p),
    ...p,
  })

  test('jména, cíl, stav a pořadí běží → naplánováno → skončilo', () => {
    const ended = row({ member_id: A, engagement_id: 3, ends_on: '2026-09-01' })
    const planned = row({ member_id: A, work_case_id: 4, starts_on: '2026-10-05', substitute_id: B })
    const activeB = row({ member_id: B, engagement_id: 3 })
    const activeA = row({ member_id: A, engagement_id: 3 })
    const out = describeAllocations([ended, planned, activeB, activeA], names, targets, today)
    expect(out.map((o) => [o.id, o.status])).toEqual([
      [activeA.id, 'active'],
      [activeB.id, 'active'],
      [planned.id, 'planned'],
      [ended.id, 'ended'],
    ])
    expect(out[2]).toMatchObject({ memberName: 'Alena', substituteName: 'Bořek', target: { label: 'Audit', href: '/cockpit/pripady/4' } })
    expect(out[0].substituteName).toBeNull()
  })

  test('canEnd: ne u skončené ani u té, která dnes končí', () => {
    const endsToday = row({ member_id: A, engagement_id: 3, ends_on: today })
    const running = row({ member_id: A, engagement_id: 3 })
    const planned = row({ member_id: A, engagement_id: 3, starts_on: '2026-10-05' })
    const ended = row({ member_id: A, engagement_id: 3, ends_on: '2026-09-01' })
    const out = describeAllocations([endsToday, running, planned, ended], names, targets, today)
    const byId = new Map(out.map((o) => [o.id, o]))
    expect(byId.get(endsToday.id)).toMatchObject({ status: 'active', canEnd: false })
    expect(byId.get(running.id)?.canEnd).toBe(true)
    expect(byId.get(planned.id)?.canEnd).toBe(true)
    expect(byId.get(ended.id)?.canEnd).toBe(false)
  })

  test('neznámý člověk a cíl dostanou zástupný popisek', () => {
    const [o] = describeAllocations([row({ member_id: C, work_case_id: 99, substitute_id: C })], names, targets, today)
    expect(o).toMatchObject({ memberName: 'Neznámý člen týmu', substituteName: 'Neznámý člen týmu', target: { label: 'Případ', href: null } })
  })
})
