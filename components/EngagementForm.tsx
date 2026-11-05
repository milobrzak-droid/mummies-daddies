'use client'
import { useActionState } from 'react'
import { FormField } from '@/components/FormField'
import { SubmitButton } from '@/components/SubmitButton'
import type { ActionResult } from '@/lib/actionResult'
import type { Engagement } from '@/lib/types'
import { DELIVERY_GATES } from '@/domain/delivery/deliveryGates'
import { DELIVERY_PHASES, engagementKindLabel } from '@/lib/domain'

type Action = (prev: unknown, formData: FormData) => Promise<ActionResult>
const KINDS = ['edu','it','platform']

export function EngagementForm({ action, initial }: { action: Action; initial?: Engagement }) {
  const [state, formAction] = useActionState(action, null)
  const fe = state?.fieldErrors ?? {}
  const d = initial
  return (
    <form action={formAction} className="flex flex-col gap-4">
      {state?.error && <p role="alert" className="m-0 text-callout text-neg">{state.error}</p>}
      <FormField label="Druh" error={fe.kind}>
        <select name="kind" defaultValue={d?.kind ?? 'edu'}>{KINDS.map((v) => <option key={v} value={v}>{engagementKindLabel(v)}</option>)}</select>
      </FormField>
      <FormField label="Fáze" error={fe.phase}>
        <select name="phase" defaultValue={d?.phase ?? 'sm_diagnostika'}>{DELIVERY_PHASES.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}</select>
      </FormField>
      <FormField label="Zahájeno" error={fe.started_on}><input name="started_on" type="date" defaultValue={d?.started_on ?? ''} /></FormField>
      <FormField label="Termín" error={fe.due_on}><input name="due_on" type="date" defaultValue={d?.due_on ?? ''} /></FormField>
      <fieldset className="rounded-tile border border-border p-4 min-w-0 flex flex-col gap-3">
        <legend className="px-2 text-callout font-bold">Vstupní audit (výchozí stav)</legend>
        <p className="m-0 text-callout text-muted">
          Výchozí stav pro předání a dopad se zapisuje na záložce Dopad jako měření hlavní metriky dodávky.
        </p>
        <FormField label="Adopce % (výchozí stav)" error={fe.baseline_adoption_pct}><input name="baseline_adoption_pct" type="number" step="0.01" defaultValue={d?.baseline_adoption_pct ?? ''} /></FormField>
        <FormField label="Zachyceno dne" error={fe.baseline_captured_on}><input name="baseline_captured_on" type="date" defaultValue={d?.baseline_captured_on ?? ''} /></FormField>
      </fieldset>
      <fieldset className="rounded-tile border border-border p-4 min-w-0 flex flex-col gap-3">
        <legend className="px-2 text-callout font-bold">Výstupní audit a měření po 6 měsících</legend>
        <FormField label="Adopce % (po)" error={fe.post_adoption_pct}><input name="post_adoption_pct" type="number" step="0.01" defaultValue={d?.post_adoption_pct ?? ''} /></FormField>
        <FormField label="Vyškoleno" error={fe.trained_count}><input name="trained_count" type="number" defaultValue={d?.trained_count ?? ''} /></FormField>
        <FormField label="Ušetřeno min/týden" error={fe.time_saved_min_week}><input name="time_saved_min_week" type="number" defaultValue={d?.time_saved_min_week ?? ''} /></FormField>
        <FormField label="Workshopů" error={fe.workshops_delivered}><input name="workshops_delivered" type="number" defaultValue={d?.workshops_delivered ?? ''} /></FormField>
        <FormField label="NNPSA" error={fe.nnpsa}><input name="nnpsa" type="number" defaultValue={d?.nnpsa ?? ''} /></FormField>
        <FormField label="Návratnost (Kč za rok)" error={fe.roi_czk_year}><input name="roi_czk_year" type="number" step="0.01" defaultValue={d?.roi_czk_year ?? ''} /></FormField>
        <FormField label="Zachyceno dne" error={fe.post_captured_on}><input name="post_captured_on" type="date" defaultValue={d?.post_captured_on ?? ''} /></FormField>
      </fieldset>
      <fieldset className="rounded-tile border border-border p-4 min-w-0 flex flex-col gap-3">
        <legend className="px-2 text-callout font-bold">Kvalitativní brány</legend>
        <p className="m-0 mb-3 text-callout text-muted">
          Dodávka projde jen se všemi šesti. &bdquo;Nehodnoceno&ldquo; schválně není
          totéž jako &bdquo;nesplněno&ldquo; — dokud brána není posouzená, nechej ji prázdnou.
        </p>
        {DELIVERY_GATES.map((g) => (
          <FormField key={g.key} label={g.label} hint={g.hint} error={fe[g.key]}>
            <select name={g.key} defaultValue={d?.[g.key] === true ? 'yes' : d?.[g.key] === false ? 'no' : ''}>
              <option value="">Nehodnoceno</option>
              <option value="yes">Splněno</option>
              <option value="no">Nesplněno</option>
            </select>
          </FormField>
        ))}
        <FormField label="Balíček výstupů (odkaz)" hint="Kam jsme klientovi uložili výstupy, shrnutí a další kroky." error={fe.deliverable_pack_url}>
          <input name="deliverable_pack_url" type="url" defaultValue={d?.deliverable_pack_url ?? ''} placeholder="https://…" />
        </FormField>
        <FormField label="Kontrolní schůzka" hint="Schůzka s klientem po skončení dodávky: jak se výsledky používají." error={fe.follow_up_checkpoint_on}>
          <input name="follow_up_checkpoint_on" type="date" defaultValue={d?.follow_up_checkpoint_on ?? ''} />
        </FormField>
      </fieldset>
      <FormField label="Vhodné jako reference"><input name="reference_worthy" type="checkbox" defaultChecked={d?.reference_worthy ?? false} /></FormField>
      <SubmitButton>Uložit dodávku</SubmitButton>
    </form>
  )
}
