import { formatDelta, impactDelta } from '@/domain/delivery/impact'
import { FeaturePending } from '@/components/ui/FeaturePending'
import { improvementLabel, type PrimaryImpact } from '@/domain/delivery/impactMetric'
import type { MetricObservation } from '@/domain/delivery/queries/impact'
import { WorkStatus } from '@/components/WorkUi'
import { Card } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'

// Přehled dopadu na klienta: výchozí stav (před) → výsledek (po) → změna.
// Bere jen skutečná měření. S `primary` (hlavní metrika dodávky, 0088) ukazuje
// její výchozí stav a výsledek; bez něj (0088 ještě neběžela) titulní je
// nejnovější měření s oběma hodnotami. Ostatní měření jsou vedle jako řádky.
// Peníze sem nepatří.

const num = (v: number) => v.toLocaleString('cs-CZ')

export type ImpactHeadline = {
  obs: MetricObservation
  baseline: number
  actual: number
  /** šířka pruhů 0–100 vůči většímu z obou čísel */
  beforePct: number
  afterPct: number
  changePct: number | null
  changeBar: number
}

export function pickHeadline(observations: readonly MetricObservation[]): ImpactHeadline | null {
  const sorted = [...observations].sort((a, b) => b.observed_on.localeCompare(a.observed_on) || b.id - a.id)
  const obs = sorted.find((o) => o.baseline !== null && o.actual !== null)
  if (!obs || obs.baseline === null || obs.actual === null) return null
  const max = Math.max(Math.abs(obs.baseline), Math.abs(obs.actual))
  const d = impactDelta(obs.baseline, obs.actual)
  return {
    obs,
    baseline: obs.baseline,
    actual: obs.actual,
    beforePct: max === 0 ? 0 : (Math.abs(obs.baseline) / max) * 100,
    afterPct: max === 0 ? 0 : (Math.abs(obs.actual) / max) * 100,
    changePct: d?.pct ?? null,
    changeBar: d?.pct == null ? 0 : Math.min(100, Math.abs(d.pct)),
  }
}

export function signedPct(p: number): string {
  return `${p > 0 ? '+' : p < 0 ? '−' : '±'}${num(Math.abs(p))} %`
}

/**
 * Tři dlaždice před / po / změna. Chybějící hodnota = „zatím nezměřeno",
 * nikdy vymyšlená nula.
 */
export function ImpactTiles({
  label, unit, baseline, actual, improved,
}: {
  label: string
  unit: string | null
  baseline: number | null
  actual: number | null
  improved?: boolean | null
}) {
  const u = unit ? ` ${unit}` : ''
  const d = impactDelta(baseline, actual)
  const max = Math.max(Math.abs(baseline ?? 0), Math.abs(actual ?? 0))
  const width = (v: number | null) => (v === null || max === 0 ? 0 : (Math.abs(v) / max) * 100)
  const change = d === null ? null : d.pct === null ? formatDelta(d, null) : signedPct(d.pct)
  const changeBar = d?.pct == null ? 0 : Math.min(100, Math.abs(d.pct))
  const aria = [
    `Metrika ${label}`,
    baseline === null ? 'výchozí stav zatím nezměřen' : `před ${num(baseline)}${u}`,
    actual === null ? 'výsledek zatím nezměřen' : `po ${num(actual)}${u}`,
    d ? `rozdíl ${formatDelta(d, unit)}` : null,
    improved === true ? 'zlepšení' : improved === false ? 'zhoršení' : null,
  ].filter(Boolean).join(', ')
  const missing = <span className="text-base font-bold">zatím nezměřeno</span>
  return (
    <div className="grid gap-3 md:grid-cols-3" role="img" aria-label={aria}>
      <div className="tile" aria-hidden="true">
        <span className="eyebrow !text-ink-2">Výchozí stav (před)</span>
        <div className="big-num text-[44px] mt-2">
          {baseline === null ? missing : <>{num(baseline)}<small className="text-base font-bold ml-1">{unit}</small></>}
        </div>
        <div className="bar thin navy mt-3" style={{ background: 'rgba(20,25,34,.1)' }}><i style={{ width: `${width(baseline)}%` }} /></div>
      </div>
      <div className="tile tile-mint" aria-hidden="true">
        <span className="eyebrow !text-ink-2">Výsledek (po)</span>
        <div className="big-num text-[44px] mt-2">
          {actual === null ? missing : <>{num(actual)}<small className="text-base font-bold ml-1">{unit}</small></>}
        </div>
        <div className="bar thin turquoise mt-3" style={{ background: 'rgba(20,25,34,.1)' }}><i style={{ width: `${width(actual)}%` }} /></div>
      </div>
      <div className="tile" style={{ background: 'var(--c-navy)', color: '#fff' }} aria-hidden="true">
        <span className="eyebrow !text-white/80">Změna{improved === true ? ' · zlepšení' : improved === false ? ' · zhoršení' : ''}</span>
        <div className="big-num text-[44px] mt-2">{change ?? <span className="text-base font-bold">až po výsledku</span>}</div>
        <div className="bar thin mt-3" style={{ background: 'rgba(255,255,255,.2)' }}><i style={{ width: `${changeBar}%`, backgroundColor: 'var(--brand-turquoise)' }} /></div>
      </div>
    </div>
  )
}

function OtherObservations({ list }: { list: readonly MetricObservation[] }) {
  if (list.length === 0) return null
  return (
    <div className="lg:border-l lg:border-[color:var(--c-line)] lg:pl-5">
      <div className="eyebrow mb-2">Další měření</div>
      <ul className="list-none p-0 m-0">
        {list.slice(0, 4).map((o) => (
          <li key={o.id} className="flex items-baseline gap-2 py-2 border-t border-[color:var(--c-line)] first:border-t-0 text-sm">
            <span className="font-semibold">{o.metric}</span>
            <span className="ml-auto text-muted whitespace-nowrap">{formatDelta(impactDelta(o.baseline, o.actual), o.unit)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

const day = (iso: string) => new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString('cs-CZ')

export function EngagementImpactSummary({
  observations, state, tabHref, primary,
}: {
  observations: MetricObservation[]
  state: 'ok' | 'missing_migration' | 'error'
  tabHref?: string
  /** Hlavní metrika dodávky (0088); undefined = 0088 neběžela, titulní je nejnovější úplné měření. */
  primary?: PrimaryImpact<MetricObservation>
}) {
  const open = tabHref ? { href: tabHref, hrefLabel: 'Otevřít dopad' } : {}

  if (state === 'ok' && primary) {
    const { metric, baseline, result, unmeasurable } = primary
    const mineIds = new Set(primary.observations.map((o) => o.id))
    const others = observations.filter((o) => !mineIds.has(o.id))
    const measured = baseline !== null || result !== null
    const verdict = improvementLabel(primary)
    return (
      <Card
        title="Dopad na klienta"
        sub={<>{metric.label}{metric.unit ? ` · ${metric.unit}` : ''}{verdict ? ` · ${verdict}` : ''}</>}
        badge={
          unmeasurable ? (
            <WorkStatus tone="info">Zatím nelze měřit</WorkStatus>
          ) : baseline ? (
            <WorkStatus tone="done">Výchozí stav {day(baseline.observed_on)}</WorkStatus>
          ) : (
            <WorkStatus tone="wait">Chybí výchozí stav</WorkStatus>
          )
        }
        {...open}
      >
        {!measured && unmeasurable ? (
          <EmptyState compact title={`Zatím nelze měřit: ${metric.label}`}>{unmeasurable.reason}</EmptyState>
        ) : !measured ? (
          <EmptyState
            compact
            title={`Chybí výchozí stav metriky „${metric.label}“`}
            action={tabHref ? { href: tabHref, label: 'Zapsat výchozí stav' } : undefined}
          >
            Zapiš ho na záložce Dopad, nebo dolož, proč zatím měřit nejde. Bez toho dodávku nejde předat do realizace.
          </EmptyState>
        ) : (
          <div className={others.length > 0 ? 'grid gap-5 lg:grid-cols-[minmax(0,1fr)_280px]' : ''}>
            <ImpactTiles
              label={metric.label}
              unit={metric.unit}
              baseline={baseline?.baseline ?? null}
              actual={result?.actual ?? null}
              improved={primary.improved}
            />
            <OtherObservations list={others} />
          </div>
        )}
      </Card>
    )
  }

  const head = state === 'ok' ? pickHeadline(observations) : null
  const others = head ? observations.filter((o) => o.id !== head.obs.id) : observations
  return (
    <Card
      title="Dopad na klienta"
      sub={head ? <>{head.obs.metric} · měřeno {day(head.obs.observed_on)}</> : undefined}
      {...open}
    >
      {state === 'missing_migration' ? (
        <FeaturePending variant="compact" migration="0061">Pak tu bude vidět výchozí stav a výsledek.</FeaturePending>
      ) : state === 'error' ? (
        <EmptyState compact title="Měření se nepodařilo načíst">Zkus to prosím později.</EmptyState>
      ) : !head ? (
        <EmptyState
          compact
          title="Zatím žádné měření s výchozím stavem i výsledkem"
          action={tabHref ? { href: tabHref, label: 'Přidat měření' } : undefined}
        >
          Zapiš výchozí stav při předání a výsledek po dodávce, tady se ukáže změna.
        </EmptyState>
      ) : (
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_280px]">
          <ImpactTiles label={head.obs.metric} unit={head.obs.unit} baseline={head.baseline} actual={head.actual} />
          <OtherObservations list={others} />
        </div>
      )}
    </Card>
  )
}
