import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { AresUnavailableError, type AresCompany, type AresSearchResult } from '@/connectors/ares'
import { recordAuditWithEvidence } from '@/core/evidence'
import {
  ARES_STATUSES,
  AresMigrationMissingError,
  aresFillPatch,
  aresRegionValue,
  canonicalIco,
  decideAresMatch,
  formatAresEnrichSummary,
  icoVariants,
  legalFormOf,
  runAresEnrichment,
  supabaseAresEnrichDb,
  type AresAuditEntry,
  type AresEnrichAccount,
  type AresEnrichDb,
  type AresEnrichSource,
  type AresEnrichStats,
} from '@/domain/crm/aresEnrich'
import { createSupabaseFake, hasOp, opArgs } from './helpers/supabaseFake'

// Dávkové doplňování IČO z ARESu — bez sítě a bez DB (adaptéry jsou falešné).

vi.mock('@/core/evidence', () => ({ recordAuditWithEvidence: vi.fn(async () => ({ ok: true, id: 1 })) }))
vi.mock('@/core/auditDb', () => ({ dbAuditActive: vi.fn(async () => false) }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))

const co = (legalName: string, ico: string, extra: Partial<AresCompany> = {}): AresCompany => ({
  ico, legalName, city: null, region: null, address: null, founded: null, nace: [], industry: null, ...extra,
})
const found = (candidates: AresCompany[], total = candidates.length): AresSearchResult => ({ candidates, total })
const NONE = new Set<string>()

const acc = (id: number, name: string, extra: Partial<AresEnrichAccount> = {}): AresEnrichAccount => ({
  id, name, ico: null, region: null, nace: null, founded_on: null, ...extra,
})

// ---------------------------------------------------------------- rozhodnutí

describe('decideAresMatch — kdy smí automat přiřadit IČO', () => {
  test('přesná shoda jména (bez právní formy) se přiřadí', () => {
    const d = decideAresMatch('ALFATECH', found([co('ALFATECH, s.r.o.', '25092677')]), NONE)
    expect(d.status).toBe('prirazeno')
    expect(d.company?.ico).toBe('25092677')
  })

  test('přesná shoda v oříznutém seznamu (Presto: 1 z 39) je nejednoznačná', () => {
    const d = decideAresMatch('Presto', found([co('Presto spol. s r.o.', '00510360')], 39), NONE)
    expect(d.status).toBe('nejednoznacne')
    expect(d.reason).toBe('neúplný seznam kandidátů')
    expect(d.company?.ico).toBe('00510360')
  })

  test('ARES odmítl hledat (přes 1000 shod) = nejednoznačné, ne nenalezeno', () => {
    expect(decideAresMatch('Agro', { candidates: [], total: Infinity, tooMany: true }, NONE)).toEqual({
      status: 'nejednoznacne', company: null, reason: 'příliš mnoho shod',
    })
  })

  test('jediný výsledek je jen návrh, ne přiřazení', () => {
    const d = decideAresMatch('NUTREND', found([co('NUTREND D.S., a.s.', '25853902')], 1), NONE)
    expect(d.status).toBe('nejednoznacne')
    expect(d.reason).toBe('jediný výsledek — jen návrh')
    // Návrh se nese dál, ať ho člověk vidí.
    expect(d.company?.ico).toBe('25853902')
  })

  test('běžné jméno s desítkami shod (Magna) je nejednoznačné', () => {
    const d = decideAresMatch('Magna', found([co('AUTENTISTA MORAVIA MAGNA, vinařský spolek', '1')], 56), NONE)
    expect(d).toEqual({ status: 'nejednoznacne', company: null, reason: 'žádná přesná shoda' })
  })

  test('zkratka s jediným výsledkem (CCH) je nejednoznačná', () => {
    expect(decideAresMatch('CCH', found([co('CCH Vzduchotechnika CZ s.r.o.', '2')], 1), NONE).status).toBe('nejednoznacne')
  })

  test('prázdný výsledek = nenalezeno', () => {
    expect(decideAresMatch('Essence BS', found([]), NONE)).toEqual({
      status: 'nenalezeno', company: null, reason: 'ARES nic nenašel',
    })
  })

  test('otazník v názvu = rozhodne člověk, i když ARES nic nevrátil', () => {
    expect(decideAresMatch('CCH (Coca-Cola HBC?)', found([]), NONE).status).toBe('nejednoznacne')
    expect(decideAresMatch('ALFATECH?', found([co('ALFATECH s.r.o.', '25092677')]), NONE).status).toBe('nejednoznacne')
  })

  test('IČO, které už má jiný klient, se nepřiřadí (žádné duplicity)', () => {
    const d = decideAresMatch('ALFATECH', found([co('ALFATECH, s.r.o.', '25092677')]), new Set(['25092677']))
    expect(d.status).toBe('nejednoznacne')
    expect(d.reason).toBe('IČO už má jiný klient')
  })

  test('obsazené IČO se pozná i v kratším zápisu bez úvodních nul', () => {
    const d = decideAresMatch('Mova Plus', found([co('Mova Plus s.r.o.', '00537837')]), new Set([canonicalIco('537837')]))
    expect(d.reason).toBe('IČO už má jiný klient')
  })

  test('dvě různé firmy se stejným jménem = nejednoznačné', () => {
    const d = decideAresMatch('ALFATECH', found([co('ALFATECH s.r.o.', '11111111'), co('ALFATECH a.s.', '22222222')]), NONE)
    expect(d).toEqual({ status: 'nejednoznacne', company: null, reason: 'víc firem stejného jména' })
  })

  test('jméno klienta s právní formou musí sedět i v ní', () => {
    expect(decideAresMatch('Alfatech a.s.', found([co('ALFATECH, s.r.o.', '25092677')]), NONE).reason).toBe('jiná právní forma')
    // „spol. s r.o." je totéž co „s.r.o."
    expect(decideAresMatch('Alfatech s.r.o.', found([co('ALFATECH, spol. s r.o.', '25092677')]), NONE).status).toBe('prirazeno')
  })

  test('závorka v názvu se před porovnáním zahodí', () => {
    expect(decideAresMatch('Mova Plus (Linsan24h)', found([co('Mova Plus s.r.o.', '00537837')]), NONE).status)
      .toBe('prirazeno')
  })
})

describe('legalFormOf / IČO', () => {
  test('kanonická právní forma', () => {
    expect(legalFormOf('ALFATECH, s.r.o.')).toBe('sro')
    expect(legalFormOf('Firma spol. s r. o.')).toBe('sro')
    expect(legalFormOf('CENTR GROUP a.s.')).toBe('as')
    expect(legalFormOf('Novák a syn v.o.s.')).toBe('vos')
    expect(legalFormOf('SE Services s.r.o.')).toBe('sro')
    expect(legalFormOf('Acme GmbH')).toBe('gmbh')
    expect(legalFormOf('ALFATECH')).toBeNull()
    expect(legalFormOf('Vodovody a stoky')).toBeNull()
  })

  test('IČO v kanonickém tvaru a jeho varianty', () => {
    expect(canonicalIco(' 537 837 ')).toBe('00537837')
    expect(canonicalIco('CZ00537837')).toBe('00537837')
    expect(icoVariants('00537837')).toEqual(['00537837', '537837', 'CZ00537837', 'CZ537837', '005 37 837', '00537 837'])
    expect(icoVariants('25092677')).toEqual(['25092677', 'CZ25092677', '250 92 677', '25092 677'])
  })
})

// ---------------------------------------------------------------- doplnění

describe('aresFillPatch — jen prázdná pole', () => {
  const company = co('ALFATECH s.r.o.', '25092677', {
    city: 'Praha', region: 'Hlavní město Praha', nace: ['62010'], founded: '2001-05-14', industry: 'IT a komunikace',
  })

  test('prázdné sídlo, NACE a datum vzniku doplní', () => {
    expect(aresFillPatch({ region: null, nace: null, founded_on: null }, company)).toEqual({
      region: 'Praha', nace: ['62010'], founded_on: '2001-05-14',
    })
  })

  test('vyplněná pole nikdy nepřepíše', () => {
    expect(aresFillPatch({ region: 'Brno', nace: ['47110'], founded_on: '1999-01-01' }, company)).toEqual({})
  })

  test('prázdný řetězec a prázdné pole NACE jsou prázdné', () => {
    expect(aresFillPatch({ region: '  ', nace: [], founded_on: '' }, company)).toEqual({
      region: 'Praha', nace: ['62010'], founded_on: '2001-05-14',
    })
  })

  test('obor (industry) z NACE nedoplňuje — první kód NACE je náhoda (0030)', () => {
    expect(aresFillPatch({ region: null, nace: null, founded_on: null }, company)).not.toHaveProperty('industry')
  })

  test('sídlo = obec jako ve zbytku aplikace, kraj jen když obec chybí', () => {
    expect(aresRegionValue({ city: 'Zlín', region: 'Zlínský kraj' })).toBe('Zlín')
    expect(aresRegionValue({ city: null, region: 'Zlínský kraj' })).toBe('Zlínský kraj')
    expect(aresRegionValue({ city: ' ', region: null })).toBeNull()
  })

  test('nesmyslné datum vzniku nepřevezme', () => {
    expect(aresFillPatch({ region: 'x', nace: ['1'], founded_on: null }, { ...company, founded: '14. 5. 2001' })).toEqual({})
  })
})

test('ARES_STATUSES sedí s CHECKem v migraci 0065', () => {
  const sql = readFileSync(join(__dirname, '..', 'supabase', 'migrations', '0065_account_ares_check.sql'), 'utf8')
  const m = /ares_status IN \(([^)]*)\)/.exec(sql)
  expect(m).not.toBeNull()
  const values = [...m![1].matchAll(/'(\w+)'/g)].map((x) => x[1])
  expect(values).toEqual([...ARES_STATUSES])
})

// ---------------------------------------------------------------- běh

type FakeOpts = {
  backfill?: AresEnrichAccount[]
  /** kanonické IČO → id klienta, který ho už má */
  owners?: Record<string, number>
  assignResult?: boolean
  backfillResult?: boolean
}

function fakeDb(missing: AresEnrichAccount[], opts: FakeOpts = {}) {
  const updates: { id: number; patch: Record<string, unknown> }[] = []
  const assigned: { id: number; patch: Record<string, unknown> }[] = []
  const audits: AresAuditEntry[] = []
  const owners = new Map(Object.entries(opts.owners ?? {}))
  const db: AresEnrichDb = {
    loadMissingIco: vi.fn(async (limit: number) => missing.slice(0, limit)),
    loadRegionBackfill: vi.fn(async (limit: number) => (opts.backfill ?? []).slice(0, limit)),
    findTakenIcos: vi.fn(async (icos: string[], except: number) =>
      new Set(icos.map(canonicalIco).filter((i) => owners.has(i) && owners.get(i) !== except))),
    assignIco: vi.fn(async (id: number, patch: Record<string, unknown>) => {
      assigned.push({ id, patch })
      return opts.assignResult ?? true
    }),
    updateAccount: vi.fn(async (id: number, patch: Record<string, unknown>) => {
      updates.push({ id, patch })
    }),
    backfillAccount: vi.fn(async (id: number, _ico: string, patch: Record<string, unknown>) => {
      if (opts.backfillResult === false) return false
      updates.push({ id, patch })
      return true
    }),
    logAresAudit: vi.fn(async (e: AresAuditEntry) => {
      audits.push(e)
    }),
  }
  return { db, updates, assigned, audits }
}

function fakeAres(byName: Record<string, AresSearchResult | Error>, byIco: Record<string, AresCompany | null | Error> = {}) {
  const source: AresEnrichSource = {
    search: vi.fn(async (name: string) => {
      const r = byName[name]
      if (r instanceof Error) throw r
      return r ?? found([])
    }),
    byIco: vi.fn(async (ico: string) => {
      const r = byIco[ico]
      if (r instanceof Error) throw r
      return r ?? null
    }),
  }
  return source
}

const NOW = Date.parse('2026-09-28T04:00:00Z')

describe('runAresEnrichment — dávka', () => {
  beforeEach(() => vi.clearAllMocks())

  test('přiřadí přesnou shodu, ostatní označí a nic nepřepíše', async () => {
    const { db, updates, assigned, audits } = fakeDb([
      acc(1, 'ALFATECH', { region: 'Ostrava' }),
      acc(2, 'NUTREND'),
      acc(3, 'Acme Ltd'),
    ])
    const ares = fakeAres({
      ALFATECH: found([co('ALFATECH, s.r.o.', '25092677', { city: 'Praha', nace: ['62010'], founded: '2001-05-14' })]),
      NUTREND: found([co('NUTREND D.S., a.s.', '25853902')], 1),
    })

    const stats = await runAresEnrichment(db, ares, { now: () => NOW })

    expect(stats).toMatchObject({ processed: 3, assigned: 1, ambiguous: 1, notFound: 1, errors: 0, budgetExhausted: false })
    // Sídlo už měl (Ostrava) — zůstane; doplní se jen NACE a datum vzniku.
    expect(assigned).toEqual([{
      id: 1,
      patch: {
        ico: '25092677', nace: ['62010'], founded_on: '2001-05-14',
        ares_status: 'prirazeno', ares_checked_at: '2026-09-28T04:00:00.000Z',
      },
    }])
    expect(updates).toEqual(expect.arrayContaining([
      { id: 2, patch: { ares_status: 'nejednoznacne', ares_checked_at: '2026-09-28T04:00:00.000Z' } },
      { id: 3, patch: { ares_status: 'nenalezeno', ares_checked_at: '2026-09-28T04:00:00.000Z' } },
    ]))
    expect(audits).toEqual([{
      accountId: 1,
      action: 'account.ares_ico_assigned',
      ico: '25092677',
      before: { ico: null, nace: null, founded_on: null },
      after: { ico: '25092677', nace: ['62010'], founded_on: '2001-05-14', zdroj: 'ARES', shoda: 'přesná shoda' },
    }])
  })

  test('IČO obsazené jiným klientem → nejednoznačné, žádný zápis IČO', async () => {
    const { db, assigned, updates } = fakeDb([acc(1, 'ALFATECH')], { owners: { '25092677': 99 } })
    const ares = fakeAres({ ALFATECH: found([co('ALFATECH, s.r.o.', '25092677')]) })
    const stats = await runAresEnrichment(db, ares, { now: () => NOW })
    expect(stats.assigned).toBe(0)
    expect(stats.ambiguous).toBe(1)
    expect(assigned).toEqual([])
    expect(updates[0].patch.ares_status).toBe('nejednoznacne')
  })

  test('dva klienti stejného jména v jedné dávce nedostanou stejné IČO', async () => {
    const { db, assigned } = fakeDb([acc(1, 'ALFATECH'), acc(2, 'Alfatech')])
    const ares = fakeAres({
      ALFATECH: found([co('ALFATECH, s.r.o.', '25092677')]),
      Alfatech: found([co('ALFATECH, s.r.o.', '25092677')]),
    })
    const stats = await runAresEnrichment(db, ares, { now: () => NOW, concurrency: 4 })
    expect(assigned).toHaveLength(1)
    expect(stats).toMatchObject({ assigned: 1, ambiguous: 1 })
  })

  test('ARES neodpověděl → chyba, jen čas pokusu (bez stavu), dávka běží dál', async () => {
    const { db, updates } = fakeDb([acc(1, 'ALFATECH'), acc(2, 'Acme')])
    const ares = fakeAres({ ALFATECH: new AresUnavailableError('ARES vrátil HTTP 429', 429) })
    const stats = await runAresEnrichment(db, ares, { now: () => NOW })
    expect(stats).toMatchObject({ errors: 1, notFound: 1 })
    expect(updates).toContainEqual({ id: 1, patch: { ares_checked_at: '2026-09-28T04:00:00.000Z' } })
  })

  test('IČO mezitím doplnil člověk → přeskočeno, bez auditu', async () => {
    const { db, audits } = fakeDb([acc(1, 'ALFATECH')], { assignResult: false })
    const ares = fakeAres({ ALFATECH: found([co('ALFATECH, s.r.o.', '25092677')]) })
    const stats = await runAresEnrichment(db, ares, { now: () => NOW })
    expect(stats).toMatchObject({ assigned: 0, skipped: 1 })
    expect(audits).toEqual([])
  })

  test('jméno s otazníkem se ARESu vůbec neposílá', async () => {
    const { db, updates } = fakeDb([acc(1, 'CCH (Coca-Cola HBC?)')])
    const ares = fakeAres({})
    await runAresEnrichment(db, ares, { now: () => NOW })
    expect(ares.search).not.toHaveBeenCalled()
    expect(updates[0].patch.ares_status).toBe('nejednoznacne')
  })

  test('volná kapacita dávky jde na doplnění sídla u klientů s IČO', async () => {
    const { db, updates, audits } = fakeDb([acc(1, 'Acme')], {
      backfill: [acc(10, 'Firma A', { ico: '25092677' }), acc(11, 'Firma B', { ico: '11111111' })],
    })
    const ares = fakeAres({}, {
      '25092677': co('FIRMA A s.r.o.', '25092677', { city: 'Brno' }),
      '11111111': new AresUnavailableError('ARES neodpověděl do 8000 ms'),
    })
    const stats = await runAresEnrichment(db, ares, { now: () => NOW, limit: 3 })
    expect(db.loadRegionBackfill).toHaveBeenCalledWith(2)
    expect(stats).toMatchObject({ notFound: 1, backfillChecked: 1, regionFilled: 1, errors: 1 })
    expect(updates).toContainEqual({ id: 10, patch: { region: 'Brno', ares_checked_at: '2026-09-28T04:00:00.000Z' } })
    // Výpadek ARESu se neoznačí — příští běh to zkusí znovu.
    expect(updates.find((u) => u.id === 11)).toBeUndefined()
    expect(audits).toEqual([expect.objectContaining({ accountId: 10, action: 'account.ares_backfilled', ico: '25092677' })])
  })

  test('doplnění podle IČO, které mezitím změnil člověk, nic nezapíše ani neauditue', async () => {
    const { db, updates, audits } = fakeDb([], {
      backfill: [acc(10, 'Firma A', { ico: '12345678' })], backfillResult: false,
    })
    const ares = fakeAres({}, { '12345678': co('FIRMA A s.r.o.', '12345678', { city: 'Praha' }) })
    const stats = await runAresEnrichment(db, ares, { now: () => NOW })
    expect(stats).toMatchObject({ skipped: 1, backfillChecked: 0, regionFilled: 0 })
    expect(updates).toEqual([])
    expect(audits).toEqual([])
  })

  test('výchozí dávka je 40 klientů', async () => {
    const { db } = fakeDb(Array.from({ length: 50 }, (_, i) => acc(i + 1, `Firma ${i + 1}`)))
    const stats = await runAresEnrichment(db, fakeAres({}), { now: () => NOW })
    expect(db.loadMissingIco).toHaveBeenCalledWith(40)
    expect(db.loadRegionBackfill).not.toHaveBeenCalled()
    expect(stats.processed).toBe(40)
  })

  test('nikdy víc než 4 dotazy na ARES současně', async () => {
    let inFlight = 0
    let max = 0
    const { db } = fakeDb(Array.from({ length: 12 }, (_, i) => acc(i + 1, `Firma ${i + 1}`)))
    const ares: AresEnrichSource = {
      search: vi.fn(async () => {
        inFlight++
        max = Math.max(max, inFlight)
        await new Promise((r) => setTimeout(r, 1))
        inFlight--
        return found([])
      }),
      byIco: vi.fn(async () => null),
    }
    const stats = await runAresEnrichment(db, ares, { now: () => NOW })
    expect(stats.processed).toBe(12)
    expect(max).toBe(4)
  })

  test('časový rozpočet: po ~40 s nic nového nezačne a běh skončí do 50 s', async () => {
    let t = NOW
    const startedAt: number[] = []
    const { db } = fakeDb(Array.from({ length: 10 }, (_, i) => acc(i + 1, `Firma ${i + 1}`)))
    const ares: AresEnrichSource = {
      // Každý dotaz trvá 10 s (a skončí před svým timeoutem 8 s + rezervou).
      search: vi.fn(async () => {
        startedAt.push(t - NOW)
        t += 10_000
        return found([])
      }),
      byIco: vi.fn(async () => null),
    }
    const stats = await runAresEnrichment(db, ares, { now: () => t, concurrency: 1 })
    // Start povolen, dokud uplynulo + 8 s timeout + 2 s rezerva ≤ 50 s.
    expect(startedAt).toEqual([0, 10_000, 20_000, 30_000, 40_000])
    expect(stats).toMatchObject({ processed: 5, notStarted: 5, budgetExhausted: true })
    expect(stats.durationMs).toBeLessThanOrEqual(50_000)
    expect(formatAresEnrichSummary(stats)).toContain('Na 5 klientů nezbyl čas')
  })

  test('bez migrace 0065 dávka skončí srozumitelnou chybou', async () => {
    const { db } = fakeDb([])
    vi.mocked(db.loadMissingIco).mockRejectedValueOnce(new AresMigrationMissingError())
    await expect(runAresEnrichment(db, fakeAres({}), { now: () => NOW })).rejects.toBeInstanceOf(AresMigrationMissingError)
  })
})

describe('formatAresEnrichSummary', () => {
  const base: AresEnrichStats = {
    processed: 0, assigned: 0, ambiguous: 0, notFound: 0, errors: 0, skipped: 0,
    backfillChecked: 0, regionFilled: 0, notStarted: 0, budgetExhausted: false, durationMs: 0,
  }

  test('souhrn čtyř čísel', () => {
    expect(formatAresEnrichSummary({ ...base, processed: 40, assigned: 3, ambiguous: 10, notFound: 25, errors: 2 }))
      .toBe('Přiřazeno 3 · nejednoznačné 10 · nenalezeno 25 · chyby 2.')
  })

  test('prázdná fronta', () => {
    expect(formatAresEnrichSummary(base)).toBe('Nebylo co ověřovat — fronta automatu je prázdná.')
  })

  test('doplněné sídlo a skloňování', () => {
    expect(formatAresEnrichSummary({
      ...base, processed: 5, backfillChecked: 2, regionFilled: 2, notStarted: 3, budgetExhausted: true,
    })).toBe('Přiřazeno 0 · nejednoznačné 0 · nenalezeno 0 · chyby 0 · doplněné sídlo 2. Na 3 klienty nezbyl čas — přijdou na řadu příště.')
  })
})

// ---------------------------------------------------------------- adaptér

describe('supabaseAresEnrichDb — dotazy a zápisy', () => {
  const actor = { type: 'system' as const, id: 'job:ares-enrich' }
  beforeEach(() => vi.clearAllMocks())

  test('fronta: jen bez IČO a bez výsledku, neověření první, limit', async () => {
    const fake = createSupabaseFake({ resolve: () => ({ data: [acc(1, 'ALFATECH')], error: null }) })
    const rows = await supabaseAresEnrichDb(fake.client as never, actor).loadMissingIco(40)
    expect(rows).toHaveLength(1)
    const call = fake.calls[0]
    expect(call.table).toBe('account')
    expect(call.ops).toEqual(expect.arrayContaining([
      { method: 'is', args: ['ico', null] },
      { method: 'is', args: ['ares_status', null] },
      { method: 'order', args: ['ares_checked_at', { ascending: true, nullsFirst: true }] },
      { method: 'limit', args: [40] },
    ]))
  })

  test('chybějící sloupec (migrace 0065) → AresMigrationMissingError', async () => {
    const fake = createSupabaseFake({ resolve: () => ({ data: null, error: { code: '42703', message: 'column account.ares_status does not exist' } }) })
    await expect(supabaseAresEnrichDb(fake.client as never, actor).loadMissingIco(40))
      .rejects.toBeInstanceOf(AresMigrationMissingError)
  })

  test('doplnění sídla: jen s IČO, bez sídla a bez ověření', async () => {
    const fake = createSupabaseFake({ resolve: () => ({ data: [], error: null }) })
    await supabaseAresEnrichDb(fake.client as never, actor).loadRegionBackfill(5)
    expect(fake.calls[0].ops).toEqual(expect.arrayContaining([
      { method: 'not', args: ['ico', 'is', null] },
      { method: 'is', args: ['region', null] },
      { method: 'is', args: ['ares_checked_at', null] },
      { method: 'limit', args: [5] },
    ]))
  })

  test('obsazená IČO hledá i v zápisu bez nul a ignoruje sebe', async () => {
    const fake = createSupabaseFake({
      resolve: () => ({ data: [{ id: 7, ico: '537837' }, { id: 1, ico: '00537837' }], error: null }),
    })
    const taken = await supabaseAresEnrichDb(fake.client as never, actor).findTakenIcos(['00537837'], 1)
    expect(opArgs(fake.calls[0], 'in')).toEqual(['ico', expect.arrayContaining(['00537837', '537837', 'CZ00537837', '005 37 837'])])
    expect([...taken]).toEqual(['00537837'])
  })

  test('zápis IČO jen tam, kde pořád chybí IČO i doplňovaná pole', async () => {
    const fake = createSupabaseFake({ resolve: () => ({ data: [], error: null }) })
    const ok = await supabaseAresEnrichDb(fake.client as never, actor)
      .assignIco(7, { ico: '25092677', region: 'Praha', nace: ['62010'], founded_on: '2001-05-14' }, ['region', 'nace', 'founded_on'])
    expect(ok).toBe(false)
    const call = fake.calls[0]
    expect(hasOp(call, 'update')).toBe(true)
    expect(call.ops).toEqual(expect.arrayContaining([
      { method: 'eq', args: ['id', 7] },
      { method: 'is', args: ['ico', null] },
      { method: 'or', args: ['region.is.null,region.eq.'] },
      { method: 'or', args: ['nace.is.null,nace.eq.{}'] },
      { method: 'is', args: ['founded_on', null] },
    ]))
  })

  test('doplnění podle IČO jen při nezměněném IČO a prázdných polích', async () => {
    const fake = createSupabaseFake({ resolve: () => ({ data: [{ id: 7 }], error: null }) })
    const ok = await supabaseAresEnrichDb(fake.client as never, actor)
      .backfillAccount(7, '12345678', { region: 'Praha' }, ['region'])
    expect(ok).toBe(true)
    expect(fake.calls[0].ops).toEqual(expect.arrayContaining([
      { method: 'eq', args: ['id', 7] },
      { method: 'eq', args: ['ico', '12345678'] },
      { method: 'or', args: ['region.is.null,region.eq.'] },
    ]))
  })

  test('audit s původem: odkaz na ARES, source_fact, aktér', async () => {
    const fake = createSupabaseFake()
    await supabaseAresEnrichDb(fake.client as never, actor).logAresAudit({
      accountId: 7, action: 'account.ares_ico_assigned', ico: '537837', before: { ico: null }, after: { ico: '00537837' },
    })
    const url = 'https://ares.gov.cz/ekonomicke-subjekty-v-be/rest/ekonomicke-subjekty/00537837'
    expect(recordAuditWithEvidence).toHaveBeenCalledWith(
      fake.client,
      { kind: 'url', sourceId: url, webLink: url },
      'source_fact',
      { entityTable: 'account', entityId: 7, action: 'account.ares_ico_assigned', before: { ico: null }, after: { ico: '00537837' }, actor },
    )
  })
})
