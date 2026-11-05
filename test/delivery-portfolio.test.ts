import { describe, expect, test } from 'vitest'
import {
  STALE_DAYS,
  buildPortfolio,
  filterPortfolio,
  latestMeasured,
  parsePortfolioFilter,
  parsePortfolioScope,
  summarizePortfolio,
  type PortfolioEngagement,
  type PortfolioInput,
  type PortfolioMilestone,
} from '@/domain/delivery/portfolio'

// Portfolio dodávek: řazení podle rizika, důvody, „co musí udělat vedení",
// rozsah z nabídky / předání a filtry. Čisté funkce, žádné I/O.

const TODAY = '2026-09-29'
const ME = 'u-viktor'
const LENKA = 'u-lenka'

const eng = (over: Partial<PortfolioEngagement> = {}): PortfolioEngagement => ({
  id: 1, account_id: 10, account_name: 'ALFATECH', deal_id: null, kind: 'it', phase: 'pilot',
  started_on: '2026-09-01', due_on: '2026-11-06', owner_id: ME, deputy_id: LENKA,
  updated_at: '2026-09-28T09:00:00Z', reference_worthy: false, ...over,
})

const ms = (over: Partial<PortfolioMilestone> = {}): PortfolioMilestone => ({
  id: 1, engagement_id: 1, title: 'Procesní mapa', owner_id: ME, deputy_id: null, status: 'v_praci',
  due_on: '2026-10-10', accepted_at: null, updated_at: '2026-09-28T09:00:00Z', ...over,
})

const input = (over: Partial<PortfolioInput> = {}): PortfolioInput => ({
  today: TODAY,
  engagements: [eng()],
  milestones: [ms()],
  tasks: [],
  offers: new Map(),
  dealTitles: new Map(),
  measures: [],
  cards: [],
  loads: new Map([[ME, { load: 20, capacity: 40, overloaded: false }]]),
  names: new Map([[ME, 'Viktor Kovář'], [LENKA, 'Lenka Horáková']]),
  ...over,
})

const only = (over: Partial<PortfolioInput> = {}) => buildPortfolio(input(over))[0]

describe('buildPortfolio: základ a klidný stav', () => {
  test('zdravá dodávka: bez důvodů, stav v pořádku, vedení nemá co dělat', () => {
    const i = only({ engagements: [eng({ handoff_completed_at: '2026-09-05T08:00:00Z' })] })
    expect(i.reasons).toEqual([])
    expect(i.state).toBe('ok')
    expect(i.riskScore).toBe(0)
    expect(i.leadership).toEqual([])
    expect(i.ownerName).toBe('Viktor Kovář')
    expect(i.deputyName).toBe('Lenka Horáková')
    expect(i.href).toBe('/cockpit/clients/10/engagements/1/edit')
    expect(i.title).toBe('Akce')
    expect(i.phaseLabel).toBe('Zkouška menu')
  })

  test('uzavřené dodávky se do portfolia nedostanou', () => {
    expect(buildPortfolio(input({ engagements: [eng({ phase: 'uzavreno' })] }))).toEqual([])
  })

  test('název bere z obchodu, jinak z druhu dodávky', () => {
    expect(only({ engagements: [eng({ deal_id: 9 })], dealTitles: new Map([[9, 'Pilot: zpracování objednávek']]) }).title).toBe('Pilot: zpracování objednávek')
    expect(only({ engagements: [eng({ deal_id: 9 })] }).title).toBe('Akce')
  })
})

describe('buildPortfolio: signály rizika', () => {
  test('po termínu: dodávka i důvod s počtem dní, vedení má rozhodnout o termínu', () => {
    const i = only({ engagements: [eng({ due_on: '2026-09-26' })] })
    expect(i.flags.late).toBe(true)
    expect(i.state).toBe('late')
    expect(i.reasons[0]).toEqual({ key: 'late', text: 'Po termínu o 3 dny' })
    expect(i.leadership[0]).toContain('Rozhodnout o novém termínu')
    expect(i.riskScore).toBeGreaterThan(1000)
  })

  test('milník po termínu se počítá jako po termínu, přijatý milník ne', () => {
    const late = only({ milestones: [ms({ due_on: '2026-09-20' })] })
    expect(late.flags.late).toBe(true)
    expect(late.reasons[0]).toEqual({ key: 'milestone_late', text: 'Milník po termínu o 9 dní' })
    const accepted = only({ milestones: [ms({ due_on: '2026-09-20', status: 'prijato', accepted_at: '2026-09-21T08:00:00Z' })] })
    expect(accepted.flags.late).toBe(false)
  })

  test('blokované jsou jen otevřené úkoly ve stavu Blokováno', () => {
    const i = only({ tasks: [
      { engagement_id: 1, status: 'blocked', updated_at: '2026-09-28T09:00:00Z' },
      { engagement_id: 1, status: 'todo', updated_at: '2026-09-28T09:00:00Z' },
      { engagement_id: 2, status: 'blocked', updated_at: '2026-09-28T09:00:00Z' },
    ] })
    expect(i.flags.blocked).toBe(true)
    expect(i.waits.blockedTasks).toBe(1)
    expect(i.waits.us).toBe(2) // milník v práci + úkol k udělání
    expect(i.state).toBe('blocked')
    expect(i.leadership[0]).toContain('Odblokovat práci')
  })

  test('čeká na klienta: podklady i schválení, rozdělené; dlouhé čekání vyzve vedení k ozvání', () => {
    const i = only({
      milestones: [
        ms({ id: 1, status: 'ceka_na_vstup', title: 'Podklady' }),
        ms({ id: 2, status: 'ceka_na_schvaleni', title: 'Procesní mapa' }),
      ],
      waitingDays: new Map([[2, 8]]),
    })
    expect(i.waits).toMatchObject({ client: 1, approval: 1 })
    expect(i.flags.waitingClient).toBe(true)
    expect(i.state).toBe('waiting')
    expect(i.leadership.some((t) => t.includes('„Procesní mapa" čeká 8 dní'))).toBe(true)
  })

  test('krátké čekání vedení k ozvání nevyzve', () => {
    const i = only({ milestones: [ms({ status: 'ceka_na_vstup' })], waitingDays: new Map([[1, 2]]) })
    expect(i.flags.waitingClient).toBe(true)
    expect(i.leadership.some((t) => t.startsWith('Ozvat se klientovi'))).toBe(false)
  })

  test('bez pohybu od STALE_DAYS dní; den předtím ještě ne', () => {
    const at = (days: number) => `${new Date(Date.UTC(2026, 8, 29 - days, 10)).toISOString()}`
    const stale = only({ engagements: [eng({ updated_at: at(STALE_DAYS) })], milestones: [ms({ updated_at: at(STALE_DAYS) })] })
    expect(stale.flags.stale).toBe(true)
    expect(stale.lastMove.days).toBe(STALE_DAYS)
    expect(stale.reasons.some((r) => r.key === 'stale')).toBe(true)
    const fresh = only({ engagements: [eng({ updated_at: at(STALE_DAYS - 1) })], milestones: [ms({ updated_at: at(STALE_DAYS - 1) })] })
    expect(fresh.flags.stale).toBe(false)
  })

  test('pohyb je nejnovější z dodávky, milníku, přijetí i úkolu', () => {
    const i = only({
      engagements: [eng({ updated_at: '2026-08-01T09:00:00Z' })],
      milestones: [ms({ updated_at: '2026-08-02T09:00:00Z', accepted_at: '2026-09-25T09:00:00Z' })],
      tasks: [{ engagement_id: 1, status: 'todo', updated_at: '2026-09-27T09:00:00Z' }],
    })
    expect(i.lastMove).toEqual({ at: '2026-09-27', days: 2 })
  })

  test('bez vlastníka a přetížený vlastník', () => {
    const noOwner = only({ engagements: [eng({ owner_id: null })] })
    expect(noOwner.reasons.some((r) => r.key === 'no_owner')).toBe(true)
    expect(noOwner.leadership[0]).toBe('Určit vlastníka dodávky.')
    expect(noOwner.capacity).toBeNull()

    const over = only({ loads: new Map([[ME, { load: 46, capacity: 40, overloaded: true }]]) })
    expect(over.reasons.some((r) => r.key === 'overloaded')).toBe(true)
    expect(over.leadership.some((t) => t.includes('Odlehčit vlastníkovi Viktor Kovář') && t.includes('46 h při kapacitě 40 h'))).toBe(true)
  })

  test('bez zástupce, nepředáno a bez milníků se objeví jako úkol pro vedení', () => {
    const i = only({ engagements: [eng({ deputy_id: null, handoff_completed_at: null })], milestones: [] })
    expect(i.leadership).toEqual(expect.arrayContaining([
      'Určit zástupce vlastníka.', 'Dokončit předání do realizace.', 'Zapsat milníky dodávky.',
    ]))
  })

  test('nenačtené zdroje nevymýšlejí nic: bez milníků a úkolů žádné signály z nich', () => {
    const i = only({ milestones: null, tasks: null, loads: null })
    expect(i.flags).toEqual({ late: false, blocked: false, waitingClient: false, stale: false })
    expect(i.leadership.includes('Zapsat milníky dodávky.')).toBe(false)
    expect(i.capacity).toBeNull()
  })
})

describe('buildPortfolio: řazení podle rizika', () => {
  test('po termínu > blokované > bez pohybu > čeká na klienta > v pořádku', () => {
    const list = buildPortfolio(input({
      engagements: [
        eng({ id: 1, account_name: 'Zdravá' }),
        eng({ id: 2, account_name: 'Čeká', updated_at: '2026-09-28T09:00:00Z' }),
        eng({ id: 3, account_name: 'Blokovaná' }),
        eng({ id: 4, account_name: 'Pozdní', due_on: '2026-09-01' }),
        eng({ id: 5, account_name: 'Nehybná', updated_at: '2026-08-01T09:00:00Z' }),
      ],
      milestones: [
        ms({ id: 20, engagement_id: 2, status: 'ceka_na_vstup' }),
        ms({ id: 50, engagement_id: 5, updated_at: '2026-08-01T09:00:00Z' }),
      ],
      tasks: [{ engagement_id: 3, status: 'blocked', updated_at: '2026-09-28T09:00:00Z' }],
    }))
    expect(list.map((i) => i.accountName)).toEqual(['Pozdní', 'Blokovaná', 'Nehybná', 'Čeká', 'Zdravá'])
  })

  test('víc dní po termínu je výš; při shodě rozhoduje dřívější termín', () => {
    const list = buildPortfolio(input({
      engagements: [eng({ id: 1, due_on: '2026-09-28' }), eng({ id: 2, due_on: '2026-09-10' })],
      milestones: [],
    }))
    expect(list.map((i) => i.id)).toEqual([2, 1])
  })
})

describe('buildPortfolio: co je slíbeno', () => {
  const offers = new Map([[9, { version: 2, scope: 'Workshop a procesní mapa pro tři týmy.', decided_at: '2026-09-12T08:00:00Z' }]])

  test('přijatá nabídka má přednost a nese verzi a datum přijetí', () => {
    const i = only({ engagements: [eng({ deal_id: 9, scope: 'Z předání' })], offers })
    expect(i.promised).toEqual({ source: 'offer', text: 'Workshop a procesní mapa pro tři týmy.', caption: 'Přijatá nabídka, verze 2, přijata 12. 9.' })
  })

  test('bez nabídky (nebo bez práva ji číst) se bere rozsah, pak cíl z předávacího balíčku', () => {
    const noRight = only({ engagements: [eng({ deal_id: 9, scope: 'Rozsah z předání', goal: 'Cíl' })], offers: null })
    expect(noRight.promised).toMatchObject({ source: 'handoff', text: 'Rozsah z předání' })
    expect(only({ engagements: [eng({ goal: 'Zrychlit zpracování' })] }).promised).toMatchObject({ source: 'handoff', text: 'Zrychlit zpracování' })
  })

  test('nic zapsaného: řekne to, nevymýšlí', () => {
    expect(only().promised).toEqual({ source: 'none', text: null, caption: 'Zatím nezapsáno' })
  })

  test('dlouhý text se zkrátí', () => {
    const long = 'A'.repeat(500)
    const i = only({ engagements: [eng({ deal_id: 9 })], offers: new Map([[9, { version: 1, scope: long, decided_at: null }]]) })
    expect(i.promised.text!.length).toBeLessThanOrEqual(180)
    expect(i.promised.text!.endsWith('…')).toBe(true)
  })
})

describe('buildPortfolio: milníky, přijetí, dopad a reference', () => {
  test('další milník je nejbližší otevřený s termínem, přijetí klientem jde ze stavu prijato/uzavreno', () => {
    const i = only({ milestones: [
      ms({ id: 1, title: 'Workshop', status: 'prijato', accepted_at: '2026-09-10T08:00:00Z', due_on: '2026-09-11' }),
      ms({ id: 2, title: 'Mapa', status: 'ceka_na_schvaleni', due_on: '2026-10-03' }),
      ms({ id: 3, title: 'Analýza', status: 'pripraveno', due_on: '2026-11-01' }),
      ms({ id: 4, title: 'Bez data', status: 'pripraveno', due_on: null }),
    ] })
    expect(i.nextMilestone).toEqual({ title: 'Mapa', dueOn: '2026-10-03', daysToDue: 4, statusLabel: 'Čeká na schválení' })
    expect(i.progress).toEqual({ total: 4, accepted: 1, lastAcceptedOn: '2026-09-10' })
  })

  test('otevřené milníky pro přehled po milnících: podle termínu, bez termínu na konci, se jménem vlastníka', () => {
    const i = only({ milestones: [
      ms({ id: 1, title: 'Workshop', status: 'prijato', accepted_at: '2026-09-10T08:00:00Z', due_on: '2026-09-11' }),
      ms({ id: 4, title: 'Bez data', status: 'pripraveno', due_on: null, owner_id: null }),
      ms({ id: 3, title: 'Analýza', status: 'v_praci', due_on: '2026-10-01', owner_id: LENKA }),
      ms({ id: 2, title: 'Mapa', status: 'ceka_na_vstup', due_on: '2026-09-26' }),
    ] })
    expect(i.openMilestones.map((m) => m.id)).toEqual([2, 3, 4])
    expect(i.openMilestones[0]).toEqual({
      id: 2, title: 'Mapa', status: 'ceka_na_vstup', statusLabel: 'Čeká na vstup', dueOn: '2026-09-26', daysToDue: -3, ownerId: ME, ownerName: 'Viktor Kovář',
    })
    expect(i.openMilestones[1]).toMatchObject({ daysToDue: 2, ownerName: 'Lenka Horáková', statusLabel: 'V práci' })
    expect(i.openMilestones[2]).toMatchObject({ dueOn: null, daysToDue: null, ownerId: null, ownerName: null })
    // První otevřený milník je zároveň „další milník“.
    expect(i.nextMilestone).toEqual({ title: 'Mapa', dueOn: '2026-09-26', daysToDue: -3, statusLabel: 'Čeká na vstup' })
  })

  test('předání do realizace: hotové, nedokončené, nebo sloupec chybí (před 0054)', () => {
    expect(only({ engagements: [eng({ handoff_completed_at: '2026-09-05T08:00:00Z' })] }).handoff).toBe('done')
    expect(only({ engagements: [eng({ handoff_completed_at: null })] }).handoff).toBe('pending')
    expect(only({ engagements: [eng()] }).handoff).toBe('unknown')
  })

  test('všechny milníky přijaté: žádný další milník', () => {
    const i = only({ milestones: [ms({ status: 'prijato', accepted_at: '2026-09-10T08:00:00Z' })] })
    expect(i.nextMilestone).toBeNull()
    expect(i.progress.accepted).toBe(1)
  })

  test('dopad: nejnovější měření s výchozím stavem i výsledkem, změna vždy ze skutečných čísel', () => {
    const measures = [
      { id: 1, engagement_id: 1, metric: 'Adopce', unit: '%', baseline: 10, actual: null, observed_on: '2026-09-27' },
      { id: 2, engagement_id: 1, metric: 'Doba zpracování', unit: 'min', baseline: 18, actual: 4, observed_on: '2026-09-20' },
      { id: 3, engagement_id: 2, metric: 'Cizí', unit: null, baseline: 1, actual: 2, observed_on: '2026-09-28' },
    ]
    expect(latestMeasured(measures.filter((m) => m.engagement_id === 1))?.metric).toBe('Doba zpracování')
    const i = only({ measures })
    expect(i.impact).toMatchObject({ metric: 'Doba zpracování', baseline: 18, actual: 4 })
    expect(i.impact!.change).toContain('−14 min')
    expect(only().impact).toBeNull()
  })

  test('reference: souhlas doložený / čeká / žádná', () => {
    expect(only({ cards: [{ engagement_id: 1, approved_public: true, consent_ok: true }] }).reference).toBe('consent')
    expect(only({ cards: [{ engagement_id: 1, approved_public: true, consent_ok: false }] }).reference).toBe('pending')
    expect(only({ engagements: [eng({ reference_worthy: true })] }).reference).toBe('pending')
    expect(only().reference).toBe('none')
  })
})

describe('souhrn a filtry', () => {
  const list = buildPortfolio(input({
    engagements: [
      eng({ id: 1, owner_id: ME }),
      eng({ id: 2, owner_id: LENKA, deputy_id: null, due_on: '2026-09-01' }),
      eng({ id: 3, owner_id: LENKA, deputy_id: null }),
    ],
    milestones: [
      ms({ id: 30, engagement_id: 3, status: 'ceka_na_vstup', owner_id: ME }),
    ],
    tasks: [{ engagement_id: 1, status: 'blocked', updated_at: '2026-09-28T09:00:00Z' }],
  }))

  test('souhrn počítá aktivní, po termínu, čekající na klienta, blokované', () => {
    const s = summarizePortfolio(list)
    expect(s).toMatchObject({ active: 3, late: 1, waitingClient: 1, blocked: 1, stale: 0 })
    expect(s.byState.late + s.byState.blocked + s.byState.waiting + s.byState.stale + s.byState.ok).toBe(3)
  })

  test('Moje = vlastník, zástupce nebo vlastník otevřeného milníku', () => {
    expect(filterPortfolio(list, { scope: 'moje', meId: ME }).map((i) => i.id).sort()).toEqual([1, 3])
    expect(filterPortfolio(list, { scope: 'moje', meId: LENKA }).map((i) => i.id).sort()).toEqual([1, 2, 3])
    expect(filterPortfolio(list, { scope: 'moje', meId: null })).toEqual([])
    expect(filterPortfolio(list, { scope: 'vse', meId: null })).toHaveLength(3)
  })

  test('filtry podle stavu', () => {
    const ids = (f: Parameters<typeof filterPortfolio>[1]['filter']) => filterPortfolio(list, { scope: 'vse', meId: null, filter: f }).map((i) => i.id)
    expect(ids('po-terminu')).toEqual([2])
    expect(ids('ceka-na-klienta')).toEqual([3])
    expect(ids('blokovane')).toEqual([1])
    expect(ids('bez-pohybu')).toEqual([])
  })

  test('parametry adresy: neznámé hodnoty spadnou na výchozí', () => {
    expect(parsePortfolioScope('moje')).toBe('moje')
    expect(parsePortfolioScope(['moje', 'vse'])).toBe('moje')
    expect(parsePortfolioScope('cokoli')).toBe('vse')
    expect(parsePortfolioScope(undefined)).toBe('vse')
    expect(parsePortfolioFilter('blokovane')).toBe('blokovane')
    expect(parsePortfolioFilter('x')).toBeNull()
    expect(parsePortfolioFilter(undefined)).toBeNull()
  })
})
