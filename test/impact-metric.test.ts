// Hlavní metrika dopadu dodávky (P1.3, migrace 0088): konfigurace firmy,
// výběr metriky podle druhu dodávky, výchozí stav a výsledek z měření,
// předávací položka „Výchozí metrika", formuláře a server akce.
import { readFileSync } from 'node:fs'
import { beforeEach, describe, expect, test, vi } from 'vitest'
import { createClient } from '@/lib/supabase/server'
import { tryRequireUser } from '@/lib/auth/requireUser'
import { COMPANY } from '@/config'
import { CURRENCY_PATTERN } from '@/domain/delivery/impact'
import {
  IMPACT_METRICS,
  METRIC_KEY_RE,
  baselineMetricOk,
  defaultMetricKey,
  handoffBaselineOk,
  impactSettingsSchema,
  improvementLabel,
  primaryImpact,
  primaryObservationSchema,
  resolveMetric,
  type KeyedObservation,
} from '@/domain/delivery/impactMetric'
import { recordPrimaryObservation, saveImpactSettings } from '@/domain/delivery/actions/impact'
import { createSupabaseFake, hasOp, opArgs, type QueryCall, type QueryResult } from './helpers/supabaseFake'

vi.mock('@/lib/auth/requireUser', () => ({ requireUser: vi.fn(), tryRequireUser: vi.fn(), AUTH_ERROR_MESSAGE: 'auth' }))
vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn() }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: vi.fn(() => ({ admin: true })) }))
vi.mock('@/core/evidence', () => ({ recordEvidence: vi.fn(async () => ({ ok: true, id: 77 })) }))
vi.mock('@/core/audit', () => ({ recordAudit: vi.fn() }))
vi.mock('@/lib/log', () => ({ logError: vi.fn(), logWarn: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/pragueDate', async (orig) => ({ ...(await orig<object>()), pragueToday: () => '2026-09-29' }))

const SQL = readFileSync('supabase/migrations/0088_impact_metric_owner_transfer.sql', 'utf8')

const obs = (p: Partial<KeyedObservation> & { id: number }): KeyedObservation => ({
  metric_key: 'cas_na_ukon', baseline: null, actual: null, observed_on: '2026-09-01', ...p,
})

describe('konfigurace firmy (config/mummiesDaddies.ts)', () => {
  test('klíče jsou unikátní, mají tvar z CHECKu v 0088 a jednotky nejsou měna', () => {
    const keys = IMPACT_METRICS.types.map((t) => t.key)
    expect(new Set(keys).size).toBe(keys.length)
    for (const t of IMPACT_METRICS.types) {
      expect(t.key).toMatch(METRIC_KEY_RE)
      expect(new RegExp(CURRENCY_PATTERN).test(`${t.label} ${t.unit ?? ''}`.toLowerCase())).toBe(false)
    }
  })

  test('nabídka obsahuje typy ze zadání a vlastní metriku', () => {
    expect(IMPACT_METRICS.types.map((t) => t.label)).toEqual([
      'Čas výdeje', 'Počet obsloužených hostů', 'Reklamace', 'Opakované objednávky', 'Úspora hodin', 'Vlastní metrika',
    ])
    expect(IMPACT_METRICS.types.filter((t) => t.custom).map((t) => t.key)).toEqual(['vlastni'])
  })

  test('každý druh dodávky má výchozí metriku z nabídky; adopce jen u vzdělávání', () => {
    expect(defaultMetricKey('edu')).toBe('adopce')
    expect(defaultMetricKey('it')).toBe('cas_na_ukon')
    expect(defaultMetricKey('platform')).toBe('pocet_polozek')
    expect(defaultMetricKey('neznamy')).toBe('vlastni')
    expect(defaultMetricKey(null)).toBe('vlastni')
    for (const k of Object.values(IMPACT_METRICS.defaultByKind)) expect(IMPACT_METRICS.types.some((t) => t.key === k)).toBe(true)
  })

  test('literály převodu v 0088 (klíč adopce, druh edu) sedí s konfigurací', () => {
    expect(COMPANY.impactMetrics.defaultByKind.edu).toBe('adopce')
    expect(SQL).toContain(`metric_key = 'adopce'`)
    expect(SQL).toContain(`e.kind <> 'edu'`)
  })

  test('SQL kopie: tvar klíče a vzor měny v 0088 = TS', () => {
    expect(SQL).toContain(`'${METRIC_KEY_RE.source}'`)
    const checks = [...SQL.matchAll(/!~ '([^']+)'/g)].map((m) => m[1])
    expect(checks).toHaveLength(2)
    for (const c of checks) expect(c).toBe(CURRENCY_PATTERN)
  })
})

describe('resolveMetric', () => {
  test('bez volby platí výchozí podle druhu dodávky', () => {
    expect(resolveMetric({ kind: 'it' })).toMatchObject({ key: 'cas_na_ukon', label: 'Čas výdeje', unit: 'min', better: 'lower', isDefault: true })
  })
  test('zvolená metrika a vlastní název a jednotka', () => {
    expect(resolveMetric({ kind: 'it', impact_metric_key: 'chybovost' })).toMatchObject({ key: 'chybovost', unit: '%', isDefault: false })
    expect(resolveMetric({ kind: 'edu', impact_metric_key: 'vlastni', impact_metric_label: ' NPS lektora ', impact_metric_unit: 'bodů' }))
      .toMatchObject({ key: 'vlastni', label: 'NPS lektora', unit: 'bodů', custom: true, better: null })
  })
  test('neznámý uložený klíč (změna konfigurace) → výchozí, ne pád', () => {
    expect(resolveMetric({ kind: 'edu', impact_metric_key: 'zruseny' })).toMatchObject({ key: 'adopce', isDefault: true })
  })
})

describe('primaryImpact — výchozí stav a výsledek z měření', () => {
  const e = { kind: 'it' }
  test('bere nejnovější výchozí stav a výsledek hlavní metriky, jiné metriky ignoruje', () => {
    const p = primaryImpact(e, [
      obs({ id: 1, baseline: 20, observed_on: '2026-08-01' }),
      obs({ id: 2, baseline: 18, observed_on: '2026-09-01' }),
      obs({ id: 3, actual: 4, observed_on: '2026-09-20' }),
      obs({ id: 4, metric_key: 'adopce', baseline: 0, actual: 50, observed_on: '2026-09-25' }),
      obs({ id: 5, metric_key: null, baseline: 1, observed_on: '2026-09-28' }),
    ])
    expect(p.baseline?.id).toBe(2)
    expect(p.result?.id).toBe(3)
    expect(p.delta).toEqual({ abs: -14, pct: -77.8 })
    expect(p.improved).toBe(true) // čas na úkon: méně je lépe
    expect(improvementLabel(p)).toBe('zlepšení')
    expect(p.observations.map((o) => o.id)).toEqual([3, 2, 1])
    expect(handoffBaselineOk(p)).toBe(true)
  })

  test('vyšší je lepší u počtu položek; beze změny ani u vlastní metriky nic netvrdí', () => {
    expect(primaryImpact({ kind: 'platform' }, [obs({ id: 1, metric_key: 'pocet_polozek', baseline: 100, actual: 80 })]).improved).toBe(false)
    expect(primaryImpact({ kind: 'it' }, [obs({ id: 1, baseline: 5, actual: 5 })]).improved).toBeNull()
    expect(primaryImpact({ kind: 'x', impact_metric_key: 'vlastni', impact_metric_label: 'A', impact_metric_unit: 'b' },
      [obs({ id: 1, metric_key: 'vlastni', baseline: 1, actual: 9 })]).improved).toBeNull()
  })

  test('IT dodávka s „adopcí 0 %" nemá výchozí stav své metriky', () => {
    const p = primaryImpact({ kind: 'it' }, [obs({ id: 1, metric_key: 'adopce', baseline: 0 })])
    expect(p.baseline).toBeNull()
    expect(handoffBaselineOk(p)).toBe(false)
  })

  test('doložené „zatím nelze měřit" splní předávací položku i bez měření', () => {
    const p = primaryImpact({ kind: 'it', impact_unmeasurable_reason: '  Data z ERP až v listopadu.  ', impact_unmeasurable_at: '2026-09-29T10:00:00Z', impact_unmeasurable_by: 'u1' }, [])
    expect(p.unmeasurable).toEqual({ reason: 'Data z ERP až v listopadu.', at: '2026-09-29T10:00:00Z', by: 'u1' })
    expect(handoffBaselineOk(p)).toBe(true)
  })
})

describe('baselineMetricOk — stránka i completeHandoff', () => {
  test('po 0088 rozhoduje hlavní metrika, stará Adopce % se nepočítá', () => {
    expect(baselineMetricOk({ kind: 'edu', settings: {}, observations: [], baselineAdoptionPct: 17 })).toBe(false)
    expect(baselineMetricOk({ kind: 'edu', settings: {}, observations: [obs({ id: 1, metric_key: 'adopce', baseline: 17 })], baselineAdoptionPct: null })).toBe(true)
  })
  test('před 0088 (settings null) platí staré pravidlo', () => {
    expect(baselineMetricOk({ kind: 'it', settings: null, observations: null, baselineAdoptionPct: 0 })).toBe(true)
    expect(baselineMetricOk({ kind: 'it', settings: null, observations: [obs({ id: 1, metric_key: null, baseline: 3 })], baselineAdoptionPct: null })).toBe(true)
    expect(baselineMetricOk({ kind: 'it', settings: null, observations: [], baselineAdoptionPct: null })).toBe(false)
  })
})

describe('impactSettingsSchema', () => {
  const parse = (v: Record<string, string>) => impactSettingsSchema.safeParse(v)
  const errors = (v: Record<string, string>) => {
    const r = parse(v)
    return r.success ? {} : Object.fromEntries(r.error.issues.map((i) => [String(i.path[0]), i.message]))
  }

  test('typ z nabídky; vlastní název a jednotka se u jiného typu zahodí', () => {
    expect(parse({ metric_key: 'chybovost', custom_label: 'x', custom_unit: 'y' })).toMatchObject({
      success: true,
      data: { impact_metric_key: 'chybovost', impact_metric_label: null, impact_metric_unit: null, impact_unmeasurable_reason: null },
    })
    expect(errors({ metric_key: 'neco' }).metric_key).toMatch(/nabídky/)
  })

  test('vlastní metrika potřebuje název a jednotku, peníze odmítne', () => {
    expect(errors({ metric_key: 'vlastni' })).toMatchObject({ custom_label: expect.any(String), custom_unit: expect.any(String) })
    expect(errors({ metric_key: 'vlastni', custom_label: 'Úspora v Kč', custom_unit: 'ks' }).custom_label).toMatch(/Peníze/)
    expect(errors({ metric_key: 'vlastni', custom_label: 'Tikety', custom_unit: 'EUR' }).custom_unit).toMatch(/Peníze/)
    expect(parse({ metric_key: 'vlastni', custom_label: 'Tikety', custom_unit: 'ks/týden' }).data)
      .toMatchObject({ impact_metric_label: 'Tikety', impact_metric_unit: 'ks/týden' })
  })

  test('„zatím nelze měřit" jen s důvodem (aspoň 10 znaků); bez zaškrtnutí se důvod nezapíše', () => {
    expect(errors({ metric_key: 'adopce', unmeasurable: 'on', unmeasurable_reason: 'nevím' }).unmeasurable_reason).toMatch(/10 znaků/)
    expect(parse({ metric_key: 'adopce', unmeasurable: 'on', unmeasurable_reason: 'Klient zatím nemá licence.' }).data?.impact_unmeasurable_reason)
      .toBe('Klient zatím nemá licence.')
    expect(parse({ metric_key: 'adopce', unmeasurable_reason: 'Klient zatím nemá licence.' }).data?.impact_unmeasurable_reason).toBeNull()
  })
})

describe('primaryObservationSchema', () => {
  test('české číslo s mezerou a čárkou', () => {
    expect(primaryObservationSchema.parse({ which: 'baseline', value: '1 234,5', observed_on: '2026-09-01' }).value).toBe(1234.5)
  })
  test('prázdná hodnota není nula; text není číslo', () => {
    const empty = primaryObservationSchema.safeParse({ which: 'actual', value: '', observed_on: '2026-09-01' })
    expect(empty.success).toBe(false)
    expect(empty.error?.issues[0].message).toBe('Zadej hodnotu.')
    const text = primaryObservationSchema.safeParse({ which: 'actual', value: 'abc', observed_on: '2026-09-01' })
    expect(text.error?.issues[0].message).toBe('Zadej číslo.')
  })
  test('co se zapisuje, je povinné', () => {
    expect(primaryObservationSchema.safeParse({ value: '1', observed_on: '2026-09-01' }).success).toBe(false)
  })
})

// --- Server akce --------------------------------------------------------------

function fd(entries: Record<string, string>): FormData {
  const f = new FormData()
  for (const [k, v] of Object.entries(entries)) f.append(k, v)
  return f
}
function setup(resolve: (c: QueryCall) => QueryResult) {
  const fake = createSupabaseFake({ resolve })
  vi.mocked(createClient).mockResolvedValue(fake.client as never)
  return fake
}
const MISSING_COL = { data: null, error: { code: '42703', message: 'column does not exist' } }

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(tryRequireUser).mockResolvedValue({ id: 'user-1' } as never)
})

describe('saveImpactSettings', () => {
  test('uloží volbu jen na dodávku této firmy; kdo a kdy doplní DB', async () => {
    const fake = setup((c) => (c.table === 'engagement' && hasOp(c, 'update') ? { data: [{ id: 2 }], error: null } : { data: null, error: null }))
    expect(await saveImpactSettings(1, 2, null, fd({ metric_key: 'chybovost', unmeasurable: 'on', unmeasurable_reason: 'Chyby se zatím neevidují.' })))
      .toEqual({ success: true })
    const upd = fake.calls.find((c) => hasOp(c, 'update'))!
    expect(opArgs(upd, 'update')![0]).toEqual({
      impact_metric_key: 'chybovost', impact_metric_label: null, impact_metric_unit: null,
      impact_unmeasurable_reason: 'Chyby se zatím neevidují.',
    })
    expect(upd.ops).toContainEqual({ method: 'eq', args: ['account_id', 1] })
  })

  test('bez uživatele nic; před 0088 klidná hláška', async () => {
    vi.mocked(tryRequireUser).mockResolvedValueOnce(null)
    const fake = setup(() => MISSING_COL)
    expect(await saveImpactSettings(1, 2, null, fd({ metric_key: 'adopce' }))).toEqual({ success: false, error: 'auth' })
    expect(fake.calls).toHaveLength(0)
    expect(await saveImpactSettings(1, 2, null, fd({ metric_key: 'adopce' }))).toEqual({
      success: false, error: 'Hlavní metrika ještě není dostupná — čeká na migraci 0088.',
    })
  })
})

describe('recordPrimaryObservation', () => {
  const engagement = (row: Record<string, unknown>) => (c: QueryCall): QueryResult | null =>
    c.table === 'engagement' && hasOp(c, 'maybeSingle') ? { data: { id: 2, account_id: 1, ...row }, error: null } : null

  test('metrika, jednotka a klíč z dodávky v DB, ne z formuláře', async () => {
    const fake = setup((c) => engagement({ kind: 'it', impact_metric_key: null })(c) ?? { data: null, error: null })
    const r = await recordPrimaryObservation(1, 2, null, fd({ which: 'baseline', value: '18', observed_on: '2026-09-01', metric: 'podvrh', unit: 'Kč' }))
    expect(r).toEqual({ success: true })
    const ins = fake.calls.find((c) => c.table === 'metric_observation' && hasOp(c, 'insert'))!
    expect(opArgs(ins, 'insert')![0]).toMatchObject({
      engagement_id: 2, metric_key: 'cas_na_ukon', metric: 'Čas výdeje', unit: 'min', baseline: 18, actual: null,
    })
  })

  test('výsledek vlastní metriky', async () => {
    const fake = setup((c) => engagement({ kind: 'edu', impact_metric_key: 'vlastni', impact_metric_label: 'NPS', impact_metric_unit: 'bodů' })(c) ?? { data: null, error: null })
    await recordPrimaryObservation(1, 2, null, fd({ which: 'actual', value: '42', observed_on: '2026-09-02' }))
    const ins = fake.calls.find((c) => c.table === 'metric_observation' && hasOp(c, 'insert'))!
    expect(opArgs(ins, 'insert')![0]).toMatchObject({ metric_key: 'vlastni', metric: 'NPS', unit: 'bodů', baseline: null, actual: 42 })
  })

  test('cizí dodávka, budoucí datum a chybějící 0088 nic nezapíšou', async () => {
    let fake = setup((c) => engagement({ account_id: 9, kind: 'it' })(c) ?? { data: null, error: null })
    expect((await recordPrimaryObservation(1, 2, null, fd({ which: 'baseline', value: '1', observed_on: '2026-09-01' }))).error).toMatch(/nebyla nalezena/)
    expect(fake.calls.some((c) => hasOp(c, 'insert'))).toBe(false)

    fake = setup(() => ({ data: null, error: null }))
    expect((await recordPrimaryObservation(1, 2, null, fd({ which: 'baseline', value: '1', observed_on: '2026-12-01' }))).fieldErrors?.observed_on).toBeTruthy()
    expect(fake.calls).toHaveLength(0)

    fake = setup((c) => (c.table === 'engagement' ? MISSING_COL : { data: null, error: null }))
    expect((await recordPrimaryObservation(1, 2, null, fd({ which: 'baseline', value: '1', observed_on: '2026-09-01' }))).error).toMatch(/0088/)
    expect(fake.calls.some((c) => hasOp(c, 'insert'))).toBe(false)
  })
})
