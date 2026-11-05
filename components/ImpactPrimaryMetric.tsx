'use client'
// Hlavní metrika dodávky (P1.3, migrace 0088): co se měří, výchozí stav
// a výsledek z metric_observation, zápis měření a volba metriky nebo doložené
// „zatím nelze měřit". Peníze sem nepatří (jednotku ani název nesmí tvořit
// měna — zod i CHECK v DB).
import { useActionState, useEffect, useRef, useState } from 'react'
import { FormField } from '@/components/FormField'
import { SubmitButton } from '@/components/SubmitButton'
import { WorkStatus } from '@/components/WorkUi'
import { Card } from '@/components/ui/Card'
import { ImpactTiles } from '@/components/EngagementImpactSummary'
import { recordPrimaryObservation, saveImpactSettings } from '@/domain/delivery/actions/impact'
import { IMPACT_METRICS, UNMEASURABLE_MIN, formatMetricValue, type PrimaryImpact } from '@/domain/delivery/impactMetric'
import type { MetricObservation } from '@/domain/delivery/queries/impact'

const day = (iso: string) => new Date(`${iso.slice(0, 10)}T12:00:00Z`).toLocaleDateString('cs-CZ')

function RecordForm({
  accountId, engagementId, unit, documents, today, hasBaseline,
}: {
  accountId: number
  engagementId: number
  unit: string | null
  documents: { id: number; title: string }[]
  today: string
  hasBaseline: boolean
}) {
  const [state, formAction] = useActionState(recordPrimaryObservation.bind(null, accountId, engagementId), null)
  const ref = useRef<HTMLFormElement>(null)
  useEffect(() => {
    if (state?.success) ref.current?.reset()
  }, [state])
  const fe = state?.fieldErrors ?? {}
  return (
    <form ref={ref} action={formAction} className="flex flex-col gap-3">
      <h3 className="m-0 font-heading text-headline font-bold">Zapsat měření</h3>
      <fieldset className="m-0 border-0 p-0 min-w-0">
        <legend className="mb-1.5 text-callout font-semibold text-[color:#39414D]">Co zapisuješ</legend>
        <div className="seg">
          {/* Segment: rádio je skryté, vybraná položka je bílá; fokus nese popisek. */}
          <label className="seg-item cursor-pointer has-[:checked]:bg-surface has-[:checked]:text-ink has-[:checked]:shadow-e1 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-[color:var(--focus-ring)]">
            <input type="radio" name="which" value="baseline" defaultChecked={!hasBaseline} className="sr-only" />
            Výchozí stav (před)
          </label>
          <label className="seg-item cursor-pointer has-[:checked]:bg-surface has-[:checked]:text-ink has-[:checked]:shadow-e1 has-[:focus-visible]:outline has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-[color:var(--focus-ring)]">
            <input type="radio" name="which" value="actual" defaultChecked={hasBaseline} className="sr-only" />
            Výsledek (po)
          </label>
        </div>
        {fe.which && <span role="alert" className="block text-neg text-sm mt-1">{fe.which}</span>}
      </fieldset>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label={`Hodnota${unit ? ` (${unit})` : ''}`} error={fe.value}>
          <input name="value" inputMode="decimal" required className="w-full" />
        </FormField>
        <FormField label="Datum měření" error={fe.observed_on}>
          <input name="observed_on" type="date" required max={today} defaultValue={today} className="w-full" />
        </FormField>
      </div>
      <FormField label="Doklad (dokument dodávky)" error={fe.document_id} hint="Nepovinné, ale bez dokladu je měření označené „Bez dokladu“.">
        <select name="document_id" defaultValue="" className="w-full">
          <option value="">Bez dokladu</option>
          {documents.map((d) => (
            <option key={d.id} value={d.id}>{d.title}</option>
          ))}
        </select>
      </FormField>
      <FormField label="Poznámka" error={fe.note}>
        <textarea name="note" maxLength={1000} rows={2} className="w-full" />
      </FormField>
      <div className="flex flex-wrap items-center gap-3">
        <SubmitButton variant="coral">Zapsat měření</SubmitButton>
        {state?.success && <p role="status" className="m-0 text-callout text-pos">Měření je zapsané.</p>}
        {state?.error && <p role="alert" className="m-0 text-callout text-neg">{state.error}</p>}
      </div>
    </form>
  )
}

function SettingsForm({
  accountId, engagementId, primary, kindLabel, defaultKey,
}: {
  accountId: number
  engagementId: number
  primary: PrimaryImpact<MetricObservation>
  kindLabel: string
  defaultKey: string
}) {
  const [state, formAction] = useActionState(saveImpactSettings.bind(null, accountId, engagementId), null)
  const [key, setKey] = useState(primary.metric.key)
  const [unmeasurable, setUnmeasurable] = useState(primary.unmeasurable !== null)
  const fe = state?.fieldErrors ?? {}
  const selected = IMPACT_METRICS.types.find((t) => t.key === key)
  return (
    <details className="group rounded-[16px] bg-[color:var(--c-soft)]">
      <summary className="flex min-h-[44px] cursor-pointer list-none items-center justify-between gap-3 rounded-[16px] px-4 py-2 text-sm font-semibold [&::-webkit-details-marker]:hidden">
        <span>Změnit metriku nebo doložit, že zatím měřit nejde</span>
        <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" className="shrink-0 text-muted transition-transform duration-fast group-open:rotate-180"><path d="m6 9 6 6 6-6" /></svg>
      </summary>
      <form action={formAction} className="flex flex-col gap-3 border-t border-border px-4 pb-4 pt-3">
        <FormField
          label="Hlavní metrika"
          error={fe.metric_key}
          hint={`${selected?.hint ?? ''} Výchozí pro druh „${kindLabel}“: ${IMPACT_METRICS.types.find((t) => t.key === defaultKey)?.label ?? defaultKey}.`}
        >
          <select name="metric_key" value={key} onChange={(e) => setKey(e.target.value)} className="w-full">
            {IMPACT_METRICS.types.map((t) => (
              <option key={t.key} value={t.key}>{t.label}{t.unit ? ` (${t.unit})` : ''}</option>
            ))}
          </select>
        </FormField>
        {selected?.custom && (
          <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_160px]">
            <FormField label="Název vlastní metriky" error={fe.custom_label}>
              <input name="custom_label" maxLength={100} defaultValue={primary.metric.custom ? primary.metric.label : ''} className="w-full" />
            </FormField>
            <FormField label="Jednotka" error={fe.custom_unit} hint="Např. ks, min, %. Peníze sem nepatří.">
              <input name="custom_unit" maxLength={30} defaultValue={primary.metric.custom ? primary.metric.unit ?? '' : ''} className="w-full" />
            </FormField>
          </div>
        )}
        <FormField label="Zatím nelze měřit" checkbox>
          <input type="checkbox" name="unmeasurable" checked={unmeasurable} onChange={(e) => setUnmeasurable(e.target.checked)} />
        </FormField>
        {unmeasurable && (
          <FormField
            label="Proč zatím měřit nejde a kdy to půjde"
            error={fe.unmeasurable_reason}
            hint={`Aspoň ${UNMEASURABLE_MIN} znaků. Uloží se, kdo a kdy to doložil; s doloženým důvodem jde dodávku předat.`}
          >
            <textarea name="unmeasurable_reason" rows={3} maxLength={1000} defaultValue={primary.unmeasurable?.reason ?? ''} className="w-full" />
          </FormField>
        )}
        <div className="flex flex-wrap items-center gap-3">
          <SubmitButton variant="soft">Uložit metriku</SubmitButton>
          {state?.success && <p role="status" className="text-sm text-muted m-0">Uloženo.</p>}
          {state?.error && <p role="alert" className="text-neg text-sm m-0">{state.error}</p>}
        </div>
      </form>
    </details>
  )
}

export function ImpactPrimaryMetric({
  accountId, engagementId, primary, kindLabel, defaultKey, documents, today, unmeasurableByName,
}: {
  accountId: number
  engagementId: number
  primary: PrimaryImpact<MetricObservation>
  /** Druh dodávky slovy (Vzdělávání, IT implementace…). */
  kindLabel: string
  defaultKey: string
  documents: { id: number; title: string }[]
  today: string
  unmeasurableByName: string | null
}) {
  const { metric, baseline, result, unmeasurable } = primary
  return (
    <Card
      title="Hlavní metrika dodávky"
      badge={
        unmeasurable ? (
          <WorkStatus tone="info">Zatím nelze měřit</WorkStatus>
        ) : baseline ? (
          <WorkStatus tone="done">Výchozí stav změřen</WorkStatus>
        ) : (
          <WorkStatus tone="wait">Chybí výchozí stav</WorkStatus>
        )
      }
    >

      <div className="mb-4 flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <span className="font-heading text-title1 font-bold">{metric.label}</span>
        {metric.unit && <span className="eyebrow">{metric.unit}</span>}
        <span className="text-[13px] text-muted">
          {metric.isDefault ? `výchozí pro druh „${kindLabel}“` : 'zvolená pro tuto dodávku'}
          {metric.better === 'lower' ? ' · lepší je méně' : metric.better === 'higher' ? ' · lepší je více' : ''}
        </span>
      </div>

      {unmeasurable && (
        <div className="mb-4 rounded-[16px] bg-[color:var(--c-soft)] px-4 py-3 text-sm">
          <p className="m-0 font-semibold">Zatím nelze měřit</p>
          <p className="m-0 mt-1 whitespace-pre-line">{unmeasurable.reason}</p>
          <p className="m-0 mt-1 text-[13px] text-muted">
            Doloženo{unmeasurableByName ? ` · ${unmeasurableByName}` : ''}{unmeasurable.at ? ` · ${day(unmeasurable.at)}` : ''}
          </p>
        </div>
      )}

      <ImpactTiles
        label={metric.label}
        unit={metric.unit}
        baseline={baseline?.baseline ?? null}
        actual={result?.actual ?? null}
        improved={primary.improved}
      />
      <p className="mt-3 mb-0 text-[13px] text-muted">
        {baseline
          ? `Výchozí stav ${formatMetricValue(baseline.baseline, metric.unit)} změřen ${day(baseline.observed_on)}${baseline.evidence_link ? ' s dokladem' : ' bez dokladu'}.`
          : 'Výchozí stav zatím není zapsaný — bez něj (nebo doloženého důvodu) nejde dodávku předat do realizace.'}
        {result ? ` Výsledek ${formatMetricValue(result.actual, metric.unit)} změřen ${day(result.observed_on)}.` : ''}
      </p>

      <div className="mt-5 grid gap-5 lg:grid-cols-2 items-start">
        <RecordForm
          accountId={accountId}
          engagementId={engagementId}
          unit={metric.unit}
          documents={documents}
          today={today}
          hasBaseline={baseline !== null}
        />
        <SettingsForm
          accountId={accountId}
          engagementId={engagementId}
          primary={primary}
          kindLabel={kindLabel}
          defaultKey={defaultKey}
        />
      </div>
    </Card>
  )
}
