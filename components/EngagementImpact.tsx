'use client'
// Dopad dodávky (kap. 6, 0061): všechna měření (výchozí stav vs. výsledek
// s rozdílem) a zápis doplňkového měření. Hlavní metriku dodávky (0088)
// zapisuje ImpactPrimaryMetric; její měření jsou tu označená „hlavní".
// Peníze sem nepatří — měnu odmítne zod i CHECK v DB.
import { WorkNotice } from '@/components/WorkUi'
import { FeaturePending } from '@/components/ui/FeaturePending'
import { CARD, CARD_PAD } from '@/components/ui/Card'
import { buttonClass } from '@/components/ui/Button'
import { useActionState, useEffect, useRef } from 'react'
import { useFormStatus } from 'react-dom'
import { FormField } from '@/components/FormField'
import { SubmitButton } from '@/components/SubmitButton'
import { DataTable } from '@/components/DataTable'
import { Chip } from '@/components/Chip'
import { createMetricObservation, deleteMetricObservation } from '@/domain/delivery/actions/impact'
import { formatDelta, impactDelta } from '@/domain/delivery/impact'
import type { MetricObservation } from '@/domain/delivery/queries/impact'
import { safeExternalHref, EXTERNAL_LINK_REL } from '@/core/untrusted'


const fmt = (v: number | null, unit: string | null) =>
  v === null ? '—' : `${v.toLocaleString('cs-CZ')}${unit ? ` ${unit}` : ''}`

function RemoveButton() {
  const { pending } = useFormStatus()
  return (
    <button type="submit" disabled={pending} aria-label="Odebrat měření" className={buttonClass('quiet', 'sm', '!text-neg')}>
      {pending ? 'Odebírám…' : 'Odebrat'}
    </button>
  )
}

function RemoveObservation({ accountId, engagementId, id }: { accountId: number; engagementId: number; id: number }) {
  const [state, formAction] = useActionState(deleteMetricObservation.bind(null, accountId, engagementId, id), null)
  return (
    <form action={formAction}>
      <RemoveButton />
      {state?.error && <p role="alert" className="text-neg text-sm">{state.error}</p>}
    </form>
  )
}

function AddObservationForm({
  accountId, engagementId, documents, today,
}: { accountId: number; engagementId: number; documents: { id: number; title: string }[]; today: string }) {
  const [state, formAction] = useActionState(createMetricObservation.bind(null, accountId, engagementId), null)
  const ref = useRef<HTMLFormElement>(null)
  useEffect(() => {
    if (state?.success) ref.current?.reset()
  }, [state])
  const fe = state?.fieldErrors ?? {}
  return (
    <form ref={ref} action={formAction} className={`${CARD} ${CARD_PAD} grid gap-3 md:grid-cols-2`}>
      <div className="md:col-span-2">
        <h3 className="m-0 font-heading text-title2 font-bold">Doplňkové měření</h3>
        <p className="text-[13px] text-muted m-0 mt-1">Další metrika vedle hlavní (např. spokojenost uživatelů). Pro předání se počítá jen hlavní metrika.</p>
      </div>
      <FormField label="Metrika" error={fe.metric} hint="Např. doba zpracování faktury, podíl aktivních uživatelů.">
        <input name="metric" required maxLength={100} className="w-full" />
      </FormField>
      <FormField label="Jednotka" error={fe.unit} hint="Např. min, %, ks. Peníze sem nepatří.">
        <input name="unit" maxLength={30} className="w-full" />
      </FormField>
      <FormField label="Výchozí stav (před)" error={fe.baseline}>
        <input name="baseline" inputMode="decimal" className="w-full" />
      </FormField>
      <FormField label="Výsledek (po)" error={fe.actual}>
        <input name="actual" inputMode="decimal" className="w-full" />
      </FormField>
      <FormField label="Datum měření" error={fe.observed_on}>
        <input name="observed_on" type="date" required max={today} defaultValue={today} className="w-full" />
      </FormField>
      <FormField label="Doklad (dokument dodávky)" error={fe.document_id} hint="Nepovinné — doklad jde doplnit i později dalším měřením.">
        <select name="document_id" defaultValue="" className="w-full">
          <option value="">Bez dokladu</option>
          {documents.map((d) => (
            <option key={d.id} value={d.id}>{d.title}</option>
          ))}
        </select>
      </FormField>
      <div className="md:col-span-2">
        <FormField label="Poznámka" error={fe.note}>
          <textarea name="note" maxLength={1000} rows={2} className="w-full" />
        </FormField>
      </div>
      <div className="md:col-span-2 flex items-center gap-3">
        <SubmitButton>Přidat měření</SubmitButton>
        {state?.error && <p role="alert" className="text-neg text-sm">{state.error}</p>}
      </div>
    </form>
  )
}

export function EngagementImpact({
  accountId, engagementId, documents, today, state, observations, primaryKey = null,
}: {
  accountId: number
  engagementId: number
  documents: { id: number; title: string }[]
  today: string
  /** Klíč hlavní metriky (0088) — její měření dostanou štítek „hlavní". */
  primaryKey?: string | null
} & (
  | { state: 'missing_migration'; observations?: undefined }
  | { state: 'error'; observations?: undefined }
  | { state: 'ok'; observations: MetricObservation[] }
)) {
  if (state === 'missing_migration') {
    return (
      <FeaturePending card variant="compact" migration="0061">
        Pak tu půjde zapisovat výchozí stav a výsledek.
      </FeaturePending>
    )
  }
  if (state === 'error') return <WorkNotice title="Měření se nepodařilo načíst">Zkus to prosím později.</WorkNotice>
  return (
    <div className="flex flex-col gap-4">
      <h2 className="m-0 font-heading text-title1 font-bold">Všechna měření</h2>
      <DataTable mobile="cards"
        label="Měření dopadu"
        rows={observations}
        empty="Zatím žádné měření. Zapiš výchozí stav při předání a výsledek po dodávce."
        columns={[
          {
            header: 'Metrika',
            cell: (o) => (
              <span className="inline-flex flex-wrap items-center gap-2">
                {o.metric}
                {primaryKey !== null && o.metric_key === primaryKey && <Chip tone="ink">hlavní</Chip>}
              </span>
            ),
          },
          { header: 'Výchozí stav (před)', cell: (o) => fmt(o.baseline, o.unit) },
          { header: 'Výsledek (po)', cell: (o) => fmt(o.actual, o.unit) },
          { header: 'Rozdíl', cell: (o) => formatDelta(impactDelta(o.baseline, o.actual), o.unit) },
          { header: 'Měřeno', cell: (o) => new Date(`${o.observed_on}T12:00:00Z`).toLocaleDateString('cs-CZ') },
          {
            header: 'Doklad',
            cell: (o) =>
              safeExternalHref(o.evidence_link) ? (
                <a href={safeExternalHref(o.evidence_link)!} target="_blank" rel={EXTERNAL_LINK_REL} className="underline">Otevřít</a>
              ) : (
                <Chip tone="warn">Bez dokladu</Chip>
              ),
          },
          { header: 'Akce', cell: (o) => <RemoveObservation accountId={accountId} engagementId={engagementId} id={o.id} /> },
        ]}
      />
      <AddObservationForm accountId={accountId} engagementId={engagementId} documents={documents} today={today} />
    </div>
  )
}
