// Čtení dopadu dodávky (metric_observation, 0061). Tabulka ještě nemusí
// existovat — chybějící relace (42P01 / PGRST205) je stav „čeká na migraci".
// Sloupec metric_key (hlavní metrika, 0088) také ne — pak se čte bez něj
// a `metricKeys` je false (předání pak jede podle starého pravidla).
import { createClient } from '@/lib/supabase/server'
import { isMissingRelation } from '@/core/loopQueries'
import { isMissingColumnError } from '@/domain/crm/dealInvariant'
import type { Loaded } from '@/domain/delivery/queries/documents'

export type MetricObservation = {
  id: number
  engagement_id: number
  /** Klíč hlavní metriky (0088); null = doplňkové měření nebo 0088 ještě neběžela. */
  metric_key: string | null
  metric: string
  unit: string | null
  baseline: number | null
  actual: number | null
  observed_on: string
  evidence_id: number | null
  note: string | null
  created_at: string
  evidence_link: string | null
}

type Raw = Omit<MetricObservation, 'evidence_link' | 'baseline' | 'actual' | 'metric_key'> & {
  metric_key?: string | null
  baseline: number | string | null
  actual: number | string | null
  evidence: { web_link: string | null } | { web_link: string | null }[] | null
}

const num = (v: number | string | null): number | null => (v === null ? null : Number(v))

const BASE_COLUMNS = 'id, engagement_id, metric, unit, baseline, actual, observed_on, evidence_id, note, created_at, evidence(web_link)'

export async function getMetricObservations(
  engagementId: number,
): Promise<Loaded<{ observations: MetricObservation[]; metricKeys: boolean }>> {
  const s = await createClient()
  const query = (cols: string) =>
    s.from('metric_observation').select(cols).eq('engagement_id', engagementId).order('observed_on', { ascending: false })
  let metricKeys = true
  let { data, error } = await query(`metric_key, ${BASE_COLUMNS}`)
  if (isMissingColumnError(error as { code?: string } | null)) {
    metricKeys = false
    ;({ data, error } = await query(BASE_COLUMNS))
  }
  if (isMissingRelation(error)) return { state: 'missing_migration' }
  if (error) return { state: 'error', message: error.message }
  const observations = ((data ?? []) as unknown as Raw[]).map((r) => {
    const ev = Array.isArray(r.evidence) ? r.evidence[0] : r.evidence
    return {
      id: r.id,
      engagement_id: r.engagement_id,
      metric_key: r.metric_key ?? null,
      metric: r.metric,
      unit: r.unit,
      baseline: num(r.baseline),
      actual: num(r.actual),
      observed_on: r.observed_on,
      evidence_id: r.evidence_id,
      note: r.note,
      created_at: r.created_at,
      evidence_link: ev?.web_link ?? null,
    }
  })
  return { state: 'ok', observations, metricKeys }
}
