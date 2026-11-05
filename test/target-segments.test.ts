// Pravidla segmentů cílových seznamů (domain/crm/targetSegments.ts). Čistá
// logika, bez DB. Firma zatím žádné segmenty nemá (outbound je fáze 2),
// proto test nese vlastní ukázková pravidla.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, test } from 'vitest'
import { COMPANY } from '@/config'
import { TARGET_SEGMENTS_FIXTURE } from './helpers/targetSegmentsFixture'
import {
  accountRelationship,
  describeSegmentRule,
  evaluateSegment,
  firmy,
  foldText,
  KRAJE,
  krajOf,
  matchAccountToSegments,
  OKRESY,
  planSegmentSuggestions,
  segmentRuleFor,
  suggestSummary,
  SUGGEST_CAP,
  type SegmentAccount,
  type SuggestCandidate,
  type TargetSegmentRule,
} from '@/domain/crm/targetSegments'

const RULES: Readonly<Record<string, TargetSegmentRule>> = TARGET_SEGMENTS_FIXTURE
const VYROBA: TargetSegmentRule = RULES['vyroba-praha']
const LOGISTIKA: TargetSegmentRule = RULES['logistika-doprava']

const acc = (industry: string | null, region: string | null = null, status: SegmentAccount['status'] = 'prospekt'): SegmentAccount =>
  ({ industry, region, status })
const segments = (a: SegmentAccount) => matchAccountToSegments(a, RULES).map((m) => m.segment)

// Malé pravidlo jen pro testy — nezávislé na tom, jak se ladí konfigurace.
const TEST_RULE: TargetSegmentRule = {
  label: 'Test',
  industryPrefixes: ['Kovo', 'Výroba'],
  industryKeywords: ['spedi', 'nákladní doprav'],
  regions: ['Hlavní město Praha', 'Středočeský kraj'],
  excludeStatuses: ['klient', 'aktivni_obchod'],
}

describe('foldText — bez velikosti písmen a diakritiky', () => {
  test('diakritika, velká písmena, pomlčky a mezery', () => {
    expect(foldText('Výroba – Telekomunikační  technika')).toBe('vyroba telekomunikacni technika')
    expect(foldText('  STŘEDOČESKÝ kraj ')).toBe('stredocesky kraj')
    expect(foldText('Praha-východ')).toBe('praha vychod')
    expect(foldText('')).toBe('')
  })
})

describe('evaluateSegment — obor', () => {
  test('prefix kategorie i uprostřed slova („Kovo" → „Kovovýroba")', () => {
    expect(evaluateSegment(acc('Kovovýroba a lakovna', 'Středočeský kraj'), TEST_RULE).ok).toBe(true)
    expect(evaluateSegment(acc('Výroba – plastové díly', 'Středočeský kraj'), TEST_RULE).ok).toBe(true)
  })

  test('diakritika a velikost písmen se ignorují', () => {
    expect(evaluateSegment(acc('VYROBA – plasty', 'stredocesky KRAJ'), TEST_RULE).ok).toBe(true)
    expect(evaluateSegment(acc('výroba', 'Hlavni mesto Praha'), TEST_RULE).ok).toBe(true)
  })

  test('prefix platí jen na začátku oboru, ne uprostřed', () => {
    const v = evaluateSegment(acc('Software – výroba aplikací', 'Středočeský kraj'), TEST_RULE)
    expect(v).toEqual({ ok: false, why: 'obor' })
  })

  test('klíčové slovo kdekoli, ale jen jako začátek slova', () => {
    expect(evaluateSegment(acc('Obchod – spedice zboží', 'Středočeský kraj'), TEST_RULE).ok).toBe(true)
    expect(evaluateSegment(acc('Služby – nákladní doprava', 'Středočeský kraj'), TEST_RULE).ok).toBe(true)
    expect(evaluateSegment(acc('Obchod – respedice', 'Středočeský kraj'), TEST_RULE)).toEqual({ ok: false, why: 'obor' })
    expect(evaluateSegment(acc('Obchod – osobní doprava', 'Středočeský kraj'), TEST_RULE)).toEqual({ ok: false, why: 'obor' })
  })

  test('prázdný nebo chybějící obor nikdy neprojde', () => {
    expect(evaluateSegment(acc(null, 'Středočeský kraj'), TEST_RULE)).toEqual({ ok: false, why: 'obor' })
    expect(evaluateSegment(acc('   ', 'Středočeský kraj'), TEST_RULE)).toEqual({ ok: false, why: 'obor' })
    expect(evaluateSegment(acc('–', 'Středočeský kraj'), TEST_RULE)).toEqual({ ok: false, why: 'obor' })
  })
})

describe('evaluateSegment — region', () => {
  test('shodný region → důvod s regionem', () => {
    expect(evaluateSegment(acc('Výroba – telekomunikační technika', 'Středočeský kraj'), TEST_RULE)).toEqual({
      ok: true, regionVerified: true, reason: 'Obor: Výroba – telekomunikační technika; region: Středočeský kraj',
    })
  })

  test('bez regionu projde s poznámkou „region neověřen"', () => {
    expect(evaluateSegment(acc('Výroba – telekomunikační technika', null), TEST_RULE)).toEqual({
      ok: true, regionVerified: false, reason: 'Obor: Výroba – telekomunikační technika; region neověřen',
    })
    expect(evaluateSegment(acc('Výroba', '  '), TEST_RULE)).toMatchObject({ ok: true, regionVerified: false })
  })

  test('kraj, který pravidlo nezahrnuje, neprojde (i v delším textu a bez diakritiky)', () => {
    expect(evaluateSegment(acc('Výroba', 'Jihomoravský kraj'), TEST_RULE)).toEqual({ ok: false, why: 'region' })
    expect(evaluateSegment(acc('Výroba', 'JIHOMORAVSKY KRAJ'), TEST_RULE)).toEqual({ ok: false, why: 'region' })
    expect(evaluateSegment(acc('Výroba', 'Kraj Vysočina'), TEST_RULE)).toEqual({ ok: false, why: 'region' })
    expect(evaluateSegment(acc('Výroba', 'Brno, Jihomoravský kraj'), TEST_RULE)).toEqual({ ok: false, why: 'region' })
  })

  test('shoda jen celým názvem (+ upřesnění), ne podřetězcem — „Prahanovice" Praha není', () => {
    expect(evaluateSegment(acc('Výroba', 'Prahanovice'), { ...TEST_RULE, regions: ['Praha'] })).toEqual({
      ok: true, regionVerified: false, reason: 'Obor: Výroba; region neověřen (Prahanovice)',
    })
  })

  test('upřesnění za mezerou/pomlčkou („Praha 4", „Praha-východ") projde', () => {
    const rule = { ...TEST_RULE, regions: ['Praha'] }
    expect(evaluateSegment(acc('Výroba', 'Praha 4'), rule).ok).toBe(true)
    expect(evaluateSegment(acc('Výroba', 'Praha-východ'), rule).ok).toBe(true)
  })

  test('kraj z názvu v delším textu ověří („Kladno, Středočeský kraj")', () => {
    expect(evaluateSegment(acc('Výroba', 'Kladno, Středočeský kraj'), TEST_RULE)).toEqual({
      ok: true, regionVerified: true, reason: 'Obor: Výroba; region: Kladno, Středočeský kraj',
    })
  })

  test('pravidlo bez regionů region neřeší ani v důvodu', () => {
    const rule = { ...TEST_RULE, regions: undefined }
    expect(evaluateSegment(acc('Výroba', 'Jihomoravský kraj'), rule)).toEqual({ ok: true, regionVerified: null, reason: 'Obor: Výroba' })
    expect(evaluateSegment(acc('Výroba', null), rule)).toEqual({ ok: true, regionVerified: null, reason: 'Obor: Výroba' })
  })

  test('důvod se vejde do CHECKu target_list_item.reason (2000 znaků)', () => {
    const v = evaluateSegment(acc(`Výroba ${'x'.repeat(3000)}`, null), TEST_RULE)
    expect(v.ok && v.reason.length).toBe(2000)
  })
})

// account.region je volný text: formulář firmy (ARES lookup), nabídky,
// plánování schůzky a importní skripty do něj píšou OBEC (sidlo.nazevObce),
// jen doplnění IČO kraj (sidlo.nazevKraje). Obec nesmí firmu tiše vyřadit.
describe('evaluateSegment — region zapsaný jako obec', () => {
  test('okresní město v povoleném kraji → ověřeno, v důvodu i kraj', () => {
    expect(evaluateSegment(acc('Výroba – kovovýroba', 'Kladno'), TEST_RULE)).toEqual({
      ok: true, regionVerified: true, reason: 'Obor: Výroba – kovovýroba; region: Kladno (Středočeský kraj)',
    })
    for (const town of ['Mladá Boleslav', 'Mělník', 'Beroun', 'KOLÍN', 'Kutna Hora', 'Příbram']) {
      expect(evaluateSegment(acc('Výroba – kovovýroba', town), TEST_RULE), town).toMatchObject({ ok: true, regionVerified: true })
    }
  })

  test('obec, kterou neumíme zařadit → projde s „region neověřen (obec)", jako firma bez regionu', () => {
    expect(evaluateSegment(acc('Výroba – kovovýroba', 'Říčany'), TEST_RULE)).toEqual({
      ok: true, regionVerified: false, reason: 'Obor: Výroba – kovovýroba; region neověřen (Říčany)',
    })
    expect(evaluateSegment(acc('Výroba', 'Střední Čechy'), TEST_RULE)).toMatchObject({ ok: true, regionVerified: false })
    // „… kraj", který mezi krajem z ARESu není — nevíme který, tak nevyřazovat
    expect(evaluateSegment(acc('Výroba', 'Pražský kraj'), TEST_RULE)).toMatchObject({ ok: true, regionVerified: false })
  })

  test('okresní město nebo okres jiného kraje → mimo region', () => {
    for (const town of ['Brno', 'Brno-venkov', 'Ostrava', 'Plzeň', 'Zlín', 'Ústí nad Labem', 'Liberec', 'Tábor']) {
      expect(evaluateSegment(acc('Výroba – kovovýroba', town), TEST_RULE), town).toEqual({ ok: false, why: 'region' })
    }
  })

  test('Praha a její obvody; Praha-východ/-západ patří Středočeskému kraji', () => {
    expect(evaluateSegment(acc('Výroba', 'Praha'), TEST_RULE)).toEqual({
      ok: true, regionVerified: true, reason: 'Obor: Výroba; region: Praha (Hlavní město Praha)',
    })
    expect(evaluateSegment(acc('Výroba', 'Praha 9'), TEST_RULE)).toMatchObject({ ok: true, regionVerified: true })
    expect(evaluateSegment(acc('Výroba', 'Praha-západ'), TEST_RULE)).toMatchObject({ ok: true, regionVerified: true })
    const prahaOnly = { ...TEST_RULE, regions: ['Hlavní město Praha'] }
    expect(evaluateSegment(acc('Výroba', 'Praha 4'), prahaOnly)).toEqual({
      ok: true, regionVerified: true, reason: 'Obor: Výroba; region: Praha 4 (Hlavní město Praha)',
    })
    expect(evaluateSegment(acc('Výroba', 'Praha-východ'), prahaOnly)).toEqual({ ok: false, why: 'region' })
  })

  test('pravidlo s obcí: kraj bez obce nevyřadí (může to být ona), jiný kraj ano', () => {
    const kladno = { ...TEST_RULE, regions: ['Kladno'] }
    expect(evaluateSegment(acc('Výroba', 'Kladno'), kladno)).toMatchObject({ ok: true, regionVerified: true })
    expect(evaluateSegment(acc('Výroba', 'Středočeský kraj'), kladno)).toEqual({
      ok: true, regionVerified: false, reason: 'Obor: Výroba; region neověřen (Středočeský kraj)',
    })
    expect(evaluateSegment(acc('Výroba', 'Brno'), kladno)).toEqual({ ok: false, why: 'region' })
  })
})

describe('krajOf — kraj z regionu, jen když je jistý', () => {
  test('název kraje, i v delším textu a bez diakritiky', () => {
    expect(krajOf('Středočeský kraj')).toBe('Středočeský kraj')
    expect(krajOf('hlavni mesto praha')).toBe('Hlavní město Praha')
    expect(krajOf('Kladno, Středočeský kraj')).toBe('Středočeský kraj')
    expect(krajOf('Kraj Vysočina')).toBe('Kraj Vysočina')
  })

  test('Praha a její obvody; Praha-východ a Praha-západ jsou okresy Středočeského kraje', () => {
    expect(krajOf('Praha')).toBe('Hlavní město Praha')
    expect(krajOf('Praha 10')).toBe('Hlavní město Praha')
    expect(krajOf('Praha 4 – Chodov')).toBe('Hlavní město Praha')
    expect(krajOf('Praha-východ')).toBe('Středočeský kraj')
    expect(krajOf('Praha - západ')).toBe('Středočeský kraj')
  })

  test('okresní město nebo okres jen jako celý text', () => {
    expect(krajOf('Kladno')).toBe('Středočeský kraj')
    expect(krajOf('Brno-venkov')).toBe('Jihomoravský kraj')
    expect(krajOf('Frýdek-Místek')).toBe('Moravskoslezský kraj')
    // Benešov nad Ploučnicí je Ústecký kraj, ne okres Benešov
    expect(krajOf('Benešov nad Ploučnicí')).toBeNull()
  })

  test('neznámá obec, volný text, neznámý „… kraj" nebo dva kraje → null', () => {
    expect(krajOf('Říčany')).toBeNull()
    expect(krajOf('Česká republika')).toBeNull()
    expect(krajOf('Pražský kraj')).toBeNull()
    expect(krajOf('Jihomoravský kraj / Zlínský kraj')).toBeNull()
    expect(krajOf('  ')).toBeNull()
  })
})

describe('kraje a okresy (číselník)', () => {
  test('14 krajů ve tvaru z ARESu; okresy pro každý kraj kromě Prahy', () => {
    expect(KRAJE).toHaveLength(14)
    expect(new Set(KRAJE.map(foldText)).size).toBe(14)
    expect(Object.keys(OKRESY).sort()).toEqual(KRAJE.filter((k) => k !== 'Hlavní město Praha').sort())
    // 76 okresů; Plzeň, Brno a Ostrava navíc i jako město vedle „-město"
    expect(Object.values(OKRESY).flat()).toHaveLength(76 + 3)
  })

  test('žádné místo ve dvou krajích ani shodné s názvem kraje', () => {
    const places = Object.values(OKRESY).flat().map(foldText)
    expect(places.every((p) => p !== '')).toBe(true)
    expect(new Set(places).size).toBe(places.length)
    const krajNames = KRAJE.map(foldText)
    expect(places.filter((p) => krajNames.includes(p))).toEqual([])
  })
})

describe('evaluateSegment — jen prospekty', () => {
  test('klient a rozjednaný obchod se vynechají, i když obor i region sedí', () => {
    expect(evaluateSegment(acc('Výroba', 'Středočeský kraj', 'klient'), TEST_RULE)).toEqual({ ok: false, why: 'vztah' })
    expect(evaluateSegment(acc('Výroba', 'Středočeský kraj', 'aktivni_obchod'), TEST_RULE)).toEqual({ ok: false, why: 'vztah' })
    expect(evaluateSegment(acc('Výroba', 'Středočeský kraj', 'prospekt'), TEST_RULE).ok).toBe(true)
  })

  test('pravidlo bez vylučovaných stavů vezme i klienta', () => {
    expect(evaluateSegment(acc('Výroba', null, 'klient'), { ...TEST_RULE, excludeStatuses: [] }).ok).toBe(true)
  })
})

describe('matchAccountToSegments nad konfigurací firmy', () => {
  test('reálné obory z importu radaru', () => {
    expect(segments(acc('Výroba – telekomunikační technika', 'Středočeský kraj'))).toEqual(['vyroba-praha'])
    expect(segments(acc('Automotive – spojovací a upevňovací prvky', 'Hlavní město Praha'))).toEqual(['vyroba-praha'])
    expect(segments(acc('Logistika – spedice a přeprava', null))).toEqual(['logistika-doprava'])
    expect(segments(acc('Strojírenství – obráběcí stroje', null))).toEqual(['vyroba-praha'])
    expect(segments(acc('Potravinářství – pekárny', 'Praha'))).toEqual(['vyroba-praha'])
    expect(segments(acc('Kovovýroba', null))).toEqual(['vyroba-praha'])
    expect(segments(acc('Chemický průmysl', null))).toEqual(['vyroba-praha'])
    expect(segments(acc('Zpracovatelský průmysl', null))).toEqual(['vyroba-praha'])
    expect(segments(acc('Doprava a skladování', 'Jihomoravský kraj'))).toEqual(['logistika-doprava'])
    expect(segments(acc('Spedice', null))).toEqual(['logistika-doprava'])
  })

  test('mimo segmenty', () => {
    expect(segments(acc('IT – vývoj software', 'Hlavní město Praha'))).toEqual([])
    expect(segments(acc('Finance a pojišťovnictví', 'Hlavní město Praha'))).toEqual([])
    expect(segments(acc('Software – výroba aplikací', 'Hlavní město Praha'))).toEqual([])
  })

  test('výroba mimo Prahu a Středočeský kraj ne, logistika kdekoli', () => {
    expect(segments(acc('Výroba – nábytek', 'Zlínský kraj'))).toEqual([])
    expect(segments(acc('Logistika – sklady', 'Zlínský kraj'))).toEqual(['logistika-doprava'])
  })

  test('výroba s obcí místo kraje (formulář firmy a importy píšou obec z ARESu)', () => {
    for (const town of ['Kladno', 'Mladá Boleslav', 'Mělník', 'Beroun', 'Praha', 'Praha 4', 'Říčany']) {
      expect(segments(acc('Výroba – kovovýroba', town)), town).toEqual(['vyroba-praha'])
    }
    expect(segments(acc('Výroba – kovovýroba', 'Brno'))).toEqual([])
    expect(segments(acc('Logistika – sklady', 'Brno'))).toEqual(['logistika-doprava'])
  })

  test('důvod pro logistiku bez regionu (pravidlo region nefiltruje)', () => {
    expect(matchAccountToSegments(acc('Logistika – spedice a přeprava', null), RULES)).toEqual([{
      segment: 'logistika-doprava', label: 'Logistika a doprava',
      reason: 'Obor: Logistika – spedice a přeprava', regionVerified: null,
    }])
  })

  test('důvod pro výrobu bez regionu nese „region neověřen"', () => {
    const [m] = matchAccountToSegments(acc('Výroba – telekomunikační technika', null), RULES)
    expect(m.reason).toBe('Obor: Výroba – telekomunikační technika; region neověřen')
  })

  test('klienti se nenavrhují do žádného segmentu', () => {
    expect(segments(acc('Logistika – spedice a přeprava', null, 'klient'))).toEqual([])
    expect(segments(acc('Výroba', 'Praha', 'aktivni_obchod'))).toEqual([])
  })
})

describe('accountRelationship', () => {
  const base = { dealStages: [], hasEngagement: false, hasRunningSubscription: false }

  test('bez obchodů, dodávek a předplatného = prospekt', () => {
    expect(accountRelationship(base)).toBe('prospekt')
    expect(accountRelationship({ ...base, dealStages: ['prohráno', 'odloženo', null] })).toBe('prospekt')
  })

  test('otevřený obchod (i stará fáze před 0050) = rozjednaný', () => {
    expect(accountRelationship({ ...base, dealStages: ['kvalifikace'] })).toBe('aktivni_obchod')
    expect(accountRelationship({ ...base, dealStages: ['prohráno', 'nabídka'] })).toBe('aktivni_obchod')
  })

  test('klient: vyhraný obchod, dodávka, předplatné, „klient od", reference', () => {
    expect(accountRelationship({ ...base, dealStages: ['vyhráno', 'kvalifikace'] })).toBe('klient')
    expect(accountRelationship({ ...base, hasEngagement: true })).toBe('klient')
    expect(accountRelationship({ ...base, hasRunningSubscription: true })).toBe('klient')
    expect(accountRelationship({ ...base, client_since: '2025-01-01' })).toBe('klient')
    expect(accountRelationship({ ...base, is_reference: true })).toBe('klient')
  })
})

describe('segmentRuleFor', () => {
  test('přesný klíč i ručně psaný segment', () => {
    expect(segmentRuleFor('vyroba-praha', RULES)?.key).toBe('vyroba-praha')
    expect(segmentRuleFor(' Výroba Praha ', RULES)?.key).toBe('vyroba-praha')
    expect(segmentRuleFor('LOGISTIKA-DOPRAVA', RULES)?.rule).toBe(LOGISTIKA)
  })

  test('neznámý, prázdný nebo „prototypový" segment → null', () => {
    expect(segmentRuleFor('stavebnictvi', RULES)).toBeNull()
    expect(segmentRuleFor('', RULES)).toBeNull()
    expect(segmentRuleFor(null, RULES)).toBeNull()
    expect(segmentRuleFor('constructor', RULES)).toBeNull()
    expect(segmentRuleFor('toString', RULES)).toBeNull()
  })
})

describe('planSegmentSuggestions', () => {
  const cand = (id: number, name: string, industry: string | null, region: string | null = null,
    status: SuggestCandidate['status'] = 'prospekt'): SuggestCandidate => ({ id, name, industry, region, status })

  test('přeskočí firmy už v seznamu, spočítá vynechané', () => {
    const plan = planSegmentSuggestions([
      cand(1, 'Alfa', 'Výroba', 'Středočeský kraj'),
      cand(2, 'Beta', 'Výroba', null),
      cand(3, 'Gama', 'Výroba', 'Jihomoravský kraj'),
      cand(4, 'Delta', 'Výroba', null, 'klient'),
      cand(5, 'Epsilon', 'IT'),
      cand(6, 'Zeta', 'Výroba', 'Praha'),
    ], VYROBA, new Set([6]))
    expect(plan.rows.map((r) => r.account_id)).toEqual([1, 2])
    expect(plan).toMatchObject({ matched: 3, alreadyInList: 1, remaining: 0, excludedStatus: 1, outsideRegion: 1, unverifiedRegion: 1 })
  })

  test('obec místo kraje: okresní město ověří, neznámá obec projde neověřená, cizí kraj ne', () => {
    const plan = planSegmentSuggestions([
      cand(1, 'Alfa', 'Výroba – kovovýroba', 'Říčany'),
      cand(2, 'Beta', 'Výroba – kovovýroba', 'Kladno'),
      cand(3, 'Gama', 'Výroba – kovovýroba', 'Brno'),
    ], VYROBA, new Set())
    expect(plan.rows).toEqual([
      { account_id: 2, reason: 'Obor: Výroba – kovovýroba; region: Kladno (Středočeský kraj)' },
      { account_id: 1, reason: 'Obor: Výroba – kovovýroba; region neověřen (Říčany)' },
    ])
    expect(plan).toMatchObject({ matched: 2, outsideRegion: 1, unverifiedRegion: 1 })
  })

  test('ověřený region napřed, pak podle abecedy (česky)', () => {
    const plan = planSegmentSuggestions([
      cand(1, 'Čokoláda', 'Výroba', null),
      cand(2, 'Cukr', 'Výroba', null),
      cand(3, 'Zámky', 'Výroba', 'Hlavní město Praha'),
      cand(4, 'Hrad', 'Výroba', null),
    ], VYROBA, new Set())
    expect(plan.rows.map((r) => r.account_id)).toEqual([3, 2, 1, 4])
  })

  test('limit na jedno kliknutí; zbytek se ukáže jako „zbývá"', () => {
    const many = Array.from({ length: 350 }, (_, i) => cand(i + 1, `Firma ${String(i + 1).padStart(3, '0')}`, 'Logistika'))
    const plan = planSegmentSuggestions(many, LOGISTIKA, new Set())
    expect(plan.rows).toHaveLength(SUGGEST_CAP)
    expect(plan.remaining).toBe(50)
    expect(plan.matched).toBe(350)
    // druhé kliknutí: prvních 300 už je v seznamu → zbytek 50
    const again = planSegmentSuggestions(many, LOGISTIKA, new Set(plan.rows.map((r) => r.account_id)))
    expect(again.rows).toHaveLength(50)
    expect(again.remaining).toBe(0)
    expect(again.alreadyInList).toBe(300)
  })

  test('duplicitní firma ve vstupu se navrhne jen jednou', () => {
    const plan = planSegmentSuggestions([cand(1, 'A', 'Logistika'), cand(1, 'A', 'Logistika')], LOGISTIKA, new Set())
    expect(plan.rows).toHaveLength(1)
  })
})

describe('texty', () => {
  test('firmy — české skloňování', () => {
    expect([0, 1, 2, 4, 5, 22, 300].map(firmy)).toEqual(['firem', 'firma', 'firmy', 'firmy', 'firem', 'firem', 'firem'])
  })

  const plan = (over: Partial<ReturnType<typeof planSegmentSuggestions>>) => ({
    rows: [], matched: 0, alreadyInList: 0, remaining: 0, excludedStatus: 0, outsideRegion: 0, unverifiedRegion: 0, ...over,
  })

  test('souhrn po kliknutí', () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({ account_id: i + 1, reason: 'x' }))
    expect(suggestSummary(plan({ rows, matched: 5, alreadyInList: 2, unverifiedRegion: 1, excludedStatus: 4 }), 3))
      .toBe('Přidáno do návrhů: 3 firmy (z toho bez ověřeného regionu 1). Už v seznamu: 2. Vynecháno: klienti a rozjednané obchody 4.')
    expect(suggestSummary(plan({ rows, matched: 3, remaining: 50 }), 3)).toContain('zbývá 50, klikni znovu')
    expect(suggestSummary(plan({ rows, matched: 3 }), 2)).toContain('Mezitím je do seznamu přidal někdo jiný: 1.')
  })

  test('nic nového / nic neodpovídá', () => {
    expect(suggestSummary(plan({ matched: 4, alreadyInList: 4 }), 0))
      .toBe('Nic nového — všechny odpovídající firmy (4) už v seznamu jsou.')
    expect(suggestSummary(plan({ outsideRegion: 2 }), 0))
      .toBe('Pravidlu segmentu teď neodpovídá žádná firma. Vynecháno: mimo region 2.')
  })

  test('popis pravidla na detailu seznamu', () => {
    const v = describeSegmentRule('vyroba-praha', VYROBA)
    expect(v[0]).toEqual({ term: 'Pravidlo segmentu', value: 'Výroba kolem Prahy (vyroba-praha)' })
    expect(v.find((l) => l.term === 'Obor začíná na')?.value).toContain('Výrob…')
    expect(v.find((l) => l.term === 'Region')?.value).toContain('region neověřen')
    expect(v.find((l) => l.term === 'Region')?.value).toContain('jiného kraje')
    expect(v.find((l) => l.term === 'Vynechá')?.value).toBe('klienty, firmy s otevřeným obchodem')
    expect(describeSegmentRule('logistika-doprava', LOGISTIKA).find((l) => l.term === 'Region')?.value).toBe('libovolný')
  })
})

describe('konfigurace segmentů', () => {
  test('firma zatím segmenty nemá a seed 0055 žádný seznam nezakládá', () => {
    expect(COMPANY.targetSegments).toEqual({})
    const sql = readFileSync(join(__dirname, '..', 'supabase', 'migrations', '0055_seed_target_lists.sql'), 'utf8')
    expect(sql).not.toMatch(/INSERT INTO target_list/)
  })

  test('pravidla: neprázdné obory, jen prospekty, popisek', () => {
    for (const [key, rule] of Object.entries(RULES) as [string, TargetSegmentRule][]) {
      expect(key).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/)
      expect(rule.label.trim()).not.toBe('')
      expect(rule.industryPrefixes.length).toBeGreaterThan(0)
      for (const p of [...rule.industryPrefixes, ...(rule.industryKeywords ?? [])]) expect(foldText(p)).not.toBe('')
      expect(rule.excludeStatuses).toEqual(expect.arrayContaining(['klient', 'aktivni_obchod']))
    }
  })

  test('výroba: Praha a Středočeský kraj ve tvaru z ARESu (nazevKraje)', () => {
    expect(VYROBA.regions).toEqual(expect.arrayContaining(['Hlavní město Praha', 'Středočeský kraj']))
    expect(LOGISTIKA.regions).toBeUndefined()
  })
})

describe('návrhy nesahají na obchody', () => {
  const src = (f: string) => readFileSync(join(__dirname, '..', f), 'utf8')

  test('čistá doména nečte DB', () => {
    expect(src('domain/crm/targetSegments.ts')).not.toMatch(/\.from\(|createClient|rpc\(/)
  })

  test('čtení kandidátů: z obchodů jen account_id a fáze, žádné zápisy', () => {
    const q = src('domain/crm/queries/targetSegments.ts')
    expect(q).not.toMatch(/\.(insert|update|upsert|delete)\(/)
    expect(q).not.toMatch(/rpc\(/)
    const dealSelects = [...q.matchAll(/from\('deal'\)\.select\('([^']*)'\)/g)].map((m) => m[1])
    expect(dealSelects).toEqual(['account_id, stage'])
  })
})
