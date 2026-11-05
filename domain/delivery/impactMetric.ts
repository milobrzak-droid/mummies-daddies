// Hlavní metrika dopadu dodávky (P1.3, migrace 0088). Čistá logika bez DB.
//
// Každá dodávka má JEDNU hlavní metriku: typ z nabídky firmy
// (COMPANY.impactMetrics v config/mummiesDaddies.ts — čas na úkon, počet položek,
// chybovost, adopce, úspora hodin, vlastní), výchozí podle druhu dodávky.
// Výchozí stav a výsledek jsou měření v metric_observation s metric_key =
// klíč metriky. Když měřit zatím nejde, člověk to doloží důvodem (kdo a kdy
// doplní DB). Předávací položka „Výchozí metrika" je splněná, když existuje
// výchozí měření zvolené metriky, nebo doložené „zatím nelze měřit".
//
// Dřív se výchozí stav bral jen z pole Adopce % (engagement.baseline_adoption_pct)
// — u zakázek bez adopce vznikala falešná „adopce 0 %". To pole se už pro
// předání nepoužívá; jen dokud 0088 v DB není, platí staré pravidlo
// (legacyBaselineOk), aby se předání nerozbilo.
import { z } from 'zod'
import { COMPANY } from '@/config'
import type { CompanyConfig, ImpactMetricsConfig, ImpactMetricType } from '@/core/tenant'
import { CURRENCY_MESSAGE, containsCurrency, impactDelta, type ImpactDelta } from '@/domain/delivery/impact'

const FALLBACK: ImpactMetricsConfig = {
  types: [{ key: 'vlastni', label: 'Vlastní metrika', unit: null, better: null, hint: 'Vlastní název a jednotka.', custom: true }],
  defaultByKind: {},
  fallback: 'vlastni',
}

export const IMPACT_METRICS: ImpactMetricsConfig = (COMPANY as unknown as CompanyConfig).impactMetrics ?? FALLBACK

/** Tvar klíče — stejný jako CHECK engagement_impact_metric_key_check v 0088. */
export const METRIC_KEY_RE = /^[a-z][a-z0-9_]{0,39}$/

export function metricType(key: string | null | undefined): ImpactMetricType | undefined {
  return key ? IMPACT_METRICS.types.find((t) => t.key === key) : undefined
}

/** Výchozí typ metriky podle druhu dodávky (edu / it / platform). */
export function defaultMetricKey(kind: string | null | undefined): string {
  const k = kind ? IMPACT_METRICS.defaultByKind[kind] : undefined
  if (k && metricType(k)) return k
  return metricType(IMPACT_METRICS.fallback) ? IMPACT_METRICS.fallback : IMPACT_METRICS.types[0].key
}

/** Sloupce dodávky z 0088. Chybějící klíč = migrace ještě neběžela. */
export type ImpactSettings = {
  impact_metric_key?: string | null
  impact_metric_label?: string | null
  impact_metric_unit?: string | null
  impact_unmeasurable_reason?: string | null
  impact_unmeasurable_at?: string | null
  impact_unmeasurable_by?: string | null
}

export const IMPACT_SETTINGS_COLUMNS =
  'impact_metric_key, impact_metric_label, impact_metric_unit, impact_unmeasurable_reason, impact_unmeasurable_at, impact_unmeasurable_by'

/** Nese řádek dodávky sloupce z 0088? (select('*') je vrátí až po migraci) */
export function hasImpactSettings(row: object): boolean {
  return 'impact_metric_key' in row
}

export type ResolvedMetric = {
  key: string
  label: string
  unit: string | null
  better: 'lower' | 'higher' | null
  hint: string
  custom: boolean
  /** Nikdo ji nevybral — platí výchozí podle druhu dodávky. */
  isDefault: boolean
}

export function resolveMetric(e: { kind: string | null } & ImpactSettings): ResolvedMetric {
  const chosen = metricType(e.impact_metric_key)
  const t = chosen ?? metricType(defaultMetricKey(e.kind)) ?? IMPACT_METRICS.types[0]
  const custom = t.custom === true
  return {
    key: t.key,
    label: custom ? e.impact_metric_label?.trim() || t.label : t.label,
    unit: custom ? e.impact_metric_unit?.trim() || null : t.unit,
    better: t.better,
    hint: t.hint,
    custom,
    isDefault: !chosen,
  }
}

// Minimum z měření (domain/delivery/queries/impact.ts MetricObservation).
export type KeyedObservation = {
  id: number
  metric_key?: string | null
  baseline: number | null
  actual: number | null
  observed_on: string
}

const newestFirst = <T extends KeyedObservation>(a: T, b: T) => b.observed_on.localeCompare(a.observed_on) || b.id - a.id

export type PrimaryImpact<T extends KeyedObservation = KeyedObservation> = {
  metric: ResolvedMetric
  /** Doložené „zatím nelze měřit"; null = měří se. */
  unmeasurable: { reason: string; at: string | null; by: string | null } | null
  /** Nejnovější měření hlavní metriky s výchozí hodnotou. */
  baseline: T | null
  /** Nejnovější měření hlavní metriky se skutečností (výsledkem). */
  result: T | null
  delta: ImpactDelta
  /** true = zlepšení, false = zhoršení, null = nejde říct (vlastní metrika, beze změny, chybí hodnota). */
  improved: boolean | null
  /** Všechna měření hlavní metriky, nejnovější první. */
  observations: T[]
}

export function primaryImpact<T extends KeyedObservation>(
  e: { kind: string | null } & ImpactSettings,
  observations: readonly T[],
): PrimaryImpact<T> {
  const metric = resolveMetric(e)
  const mine = observations.filter((o) => o.metric_key === metric.key).sort(newestFirst)
  const baseline = mine.find((o) => o.baseline !== null) ?? null
  const result = mine.find((o) => o.actual !== null) ?? null
  const delta = impactDelta(baseline?.baseline ?? null, result?.actual ?? null)
  const improved = !delta || delta.abs === 0 || metric.better === null
    ? null
    : metric.better === 'higher' ? delta.abs > 0 : delta.abs < 0
  const reason = e.impact_unmeasurable_reason?.trim()
  return {
    metric,
    unmeasurable: reason ? { reason, at: e.impact_unmeasurable_at ?? null, by: e.impact_unmeasurable_by ?? null } : null,
    baseline,
    result,
    delta,
    improved,
    observations: mine,
  }
}

/** Předávací položka „Výchozí metrika" (0088): výchozí měření hlavní metriky, nebo doložené „nelze měřit". */
export function handoffBaselineOk(p: PrimaryImpact): boolean {
  return p.unmeasurable !== null || p.baseline !== null
}

/** Staré pravidlo, dokud 0088 v DB není: pole Adopce % nebo jakékoli měření s výchozí hodnotou. */
export function legacyBaselineOk(baselineAdoptionPct: number | string | null, observations: readonly KeyedObservation[]): boolean {
  return baselineAdoptionPct !== null || observations.some((o) => o.baseline !== null)
}

/**
 * Jedno místo pro stránku dodávky i completeHandoff.
 * settings = null → 0088 neběžela (staré pravidlo); observations = null → 0061 neběžela.
 */
export function baselineMetricOk(input: {
  kind: string | null
  settings: ImpactSettings | null
  observations: readonly KeyedObservation[] | null
  baselineAdoptionPct: number | string | null
}): boolean {
  const obs = input.observations ?? []
  if (input.settings === null) return legacyBaselineOk(input.baselineAdoptionPct, obs)
  return handoffBaselineOk(primaryImpact({ kind: input.kind, ...input.settings }, obs))
}

// ---------------------------------------------------------------------------
// Formuláře (zod) — sdílí je server akce (actions/impact.ts) a testy.

const emptyToNull = (v: unknown) => (v == null || (typeof v === 'string' && v.trim() === '') ? null : v)
const optText = (max: number, msg: string) =>
  z.preprocess(emptyToNull, z.string().trim().max(max, msg).nullable())

export const UNMEASURABLE_MIN = 10

export const impactSettingsSchema = z
  .object({
    metric_key: z.string().refine((k) => metricType(k) !== undefined, 'Vyber metriku z nabídky.'),
    custom_label: optText(100, 'Nejvýš 100 znaků.'),
    custom_unit: optText(30, 'Nejvýš 30 znaků.'),
    unmeasurable: z.preprocess((v) => v === 'on' || v === 'true' || v === true, z.boolean()),
    unmeasurable_reason: optText(1000, 'Nejvýš 1000 znaků.'),
  })
  .superRefine((v, ctx) => {
    const t = metricType(v.metric_key)
    if (t?.custom) {
      if (v.custom_label === null) ctx.addIssue({ code: 'custom', path: ['custom_label'], message: 'Pojmenuj vlastní metriku.' })
      if (v.custom_unit === null) ctx.addIssue({ code: 'custom', path: ['custom_unit'], message: 'Vyplň jednotku (např. ks, min, %).' })
      if (containsCurrency(v.custom_label)) ctx.addIssue({ code: 'custom', path: ['custom_label'], message: CURRENCY_MESSAGE })
      if (containsCurrency(v.custom_unit)) ctx.addIssue({ code: 'custom', path: ['custom_unit'], message: CURRENCY_MESSAGE })
    }
    if (v.unmeasurable && (v.unmeasurable_reason === null || v.unmeasurable_reason.length < UNMEASURABLE_MIN)) {
      ctx.addIssue({
        code: 'custom',
        path: ['unmeasurable_reason'],
        message: `Napiš, proč zatím měřit nejde a kdy to půjde (aspoň ${UNMEASURABLE_MIN} znaků).`,
      })
    }
  })
  .transform((v) => {
    const custom = metricType(v.metric_key)?.custom === true
    return {
      impact_metric_key: v.metric_key,
      impact_metric_label: custom ? v.custom_label : null,
      impact_metric_unit: custom ? v.custom_unit : null,
      impact_unmeasurable_reason: v.unmeasurable ? v.unmeasurable_reason : null,
    }
  })
export type ImpactSettingsInput = z.infer<typeof impactSettingsSchema>

// Povinné číslo z formuláře: „1 234,5" → 1234.5; prázdné je chyba (ne 0).
const requiredNumber = z.preprocess(
  (v) => {
    const e = emptyToNull(v)
    return typeof e === 'string' ? e.replace(/\s/g, '').replace(',', '.') : e
  },
  z
    .union([z.string(), z.number()], { message: 'Zadej hodnotu.' })
    .transform((v) => Number(v))
    .refine((n) => Number.isFinite(n), 'Zadej číslo.'),
)
const optId = z.preprocess(
  (v) => (v === '' || v == null ? null : v),
  z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER).nullable(),
)

/** Měření hlavní metriky: výchozí stav (před) nebo výsledek (po). */
export const primaryObservationSchema = z.object({
  which: z.enum(['baseline', 'actual'], { message: 'Vyber, co zapisuješ.' }),
  value: requiredNumber,
  observed_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Zadej datum.'),
  document_id: optId,
  note: optText(1000, 'Nejvýš 1000 znaků.'),
})
export type PrimaryObservationInput = z.infer<typeof primaryObservationSchema>

// ---------------------------------------------------------------------------
// Texty

export function formatMetricValue(v: number | null, unit: string | null): string {
  return v === null ? '—' : `${v.toLocaleString('cs-CZ')}${unit ? ` ${unit}` : ''}`
}

export function improvementLabel(p: PrimaryImpact): string | null {
  if (p.improved === true) return 'zlepšení'
  if (p.improved === false) return 'zhoršení'
  return null
}
