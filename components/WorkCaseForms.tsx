'use client'
import { useActionState, useEffect, useMemo, useRef, useState } from 'react'
import { FormField } from '@/components/FormField'
import { SubmitButton } from '@/components/SubmitButton'
import { AccountPicker, type AccountOption } from '@/components/AccountPicker'
import { levelWords } from '@/components/WorkUi'
import type { ActionResult } from '@/lib/actionResult'
import { CARD } from '@/components/ui/Card'

type Action = (prev: unknown, formData: FormData) => Promise<ActionResult>

function useResettingForm(action: Action) {
  const [state, formAction] = useActionState(action, null)
  const ref = useRef<HTMLFormElement>(null)
  useEffect(() => {
    if (state?.success) ref.current?.reset()
  }, [state])
  return { state, formAction, ref, fe: state?.fieldErrors ?? {} }
}

// Samostatný formulář je karta (docs/PROVOZ.md §5); formulář uvnitř
// jiné karty kartu nemá (karta v kartě jen s hranou nebo výplní).
const box = `${CARD} space-y-4 p-5 sm:p-6`

// --- Nový případ ------------------------------------------------------------

export type NewCaseProps = {
  action: Action
  nodes: { value: string; label: string; ownerId: string | null }[]
  templates: { id: string; label: string; suggestedNode: string | null; steps: readonly string[] }[]
  members: { id: string; full_name: string }[]
  deals: { id: number; title: string; account_id: number }[]
  // Klient se hledá (AccountPicker); z URL přijde jen předvybraná firma.
  initial: { node: string; account: AccountOption | null; dealId: number | null; template: string }
}

export function WorkCaseCreateForm({ action, nodes, templates, members, deals, initial }: NewCaseProps) {
  const [state, formAction] = useActionState(action, null)
  const fe = state?.fieldErrors ?? {}
  const [template, setTemplate] = useState(initial.template)
  const [node, setNode] = useState(initial.node)
  const [accountId, setAccountId] = useState(initial.account ? String(initial.account.id) : '')
  const [dealId, setDealId] = useState(initial.dealId ? String(initial.dealId) : '')

  const memberName = useMemo(() => new Map(members.map((m) => [m.id, m.full_name])), [members])
  const owner = nodes.find((n) => n.value === node)?.ownerId ?? null
  const ownerLabel = owner ? `— vlastník oblasti (${memberName.get(owner) ?? 'neznámý'}) —` : '— vlastník oblasti (neobsazeno) —'
  const tpl = templates.find((t) => t.id === template) ?? null
  const dealChoices = accountId ? deals.filter((d) => String(d.account_id) === accountId) : deals

  return (
    <form action={formAction} className={box}>
      {state?.error && <p role="alert" className="m-0 text-callout text-neg">{state.error}</p>}
      <FormField label="Šablona" error={fe.template} hint={tpl ? `Založí kroky: ${tpl.steps.join(' → ')} a otevřené rozhodnutí.` : undefined}>
        <select
          name="template"
          value={template}
          onChange={(e) => {
            setTemplate(e.target.value)
            const t = templates.find((x) => x.id === e.target.value)
            if (t?.suggestedNode) setNode(t.suggestedNode)
          }}
        >
          <option value="">Prázdný případ</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>{t.label}</option>
          ))}
        </select>
      </FormField>
      <FormField label="Název" error={fe.title}>
        <input name="title" required maxLength={300} />
      </FormField>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <FormField label="Oblast" error={fe.node}>
          <select name="node" value={node} onChange={(e) => setNode(e.target.value)} required>
            {nodes.map((n) => (
              <option key={n.value} value={n.value}>{n.label}</option>
            ))}
          </select>
        </FormField>
        <FormField label="Vlastník případu" error={fe.lead_owner_id}>
          <select name="lead_owner_id" defaultValue="">
            <option value="">{ownerLabel}</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>{m.full_name}</option>
            ))}
          </select>
        </FormField>
        <FormField label="Klient (volitelně)" error={fe.account_id}>
          <AccountPicker
            name="account_id"
            initial={initial.account}
            // React po každém odeslání formulář resetuje — i po chybě
            // validace. Volba klienta (dřív řízený select) má přežít.
            keepOnReset
            placeholder="Bez klienta — nebo začni psát název či IČO…"
            onChange={(option) => {
              setAccountId(option ? String(option.id) : '')
              setDealId('')
            }}
          />
        </FormField>
        <FormField label="Obchod (volitelně)" error={fe.deal_id}>
          <select name="deal_id" value={dealId} onChange={(e) => setDealId(e.target.value)}>
            <option value="">— bez obchodu —</option>
            {dealChoices.map((d) => (
              <option key={d.id} value={d.id}>{d.title}</option>
            ))}
          </select>
        </FormField>
      </div>
      <SubmitButton variant="coral">Založit případ</SubmitButton>
    </form>
  )
}

// --- Detail případu ---------------------------------------------------------

export function AddStepForm({ action, caseId }: { action: Action; caseId: number }) {
  const { state, formAction, ref, fe } = useResettingForm(action)
  return (
    <form ref={ref} action={formAction} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="case_id" value={caseId} />
      <div className="flex-1 min-w-[14rem]">
        <FormField label="Nový krok" error={fe.title}>
          <input name="title" required maxLength={300} />
        </FormField>
      </div>
      <SubmitButton variant="soft">Přidat krok</SubmitButton>
      {state?.error && <p role="alert" className="m-0 w-full text-callout text-neg">{state.error}</p>}
    </form>
  )
}

// „Potvrdit další krok" (0084): po schválení jiným členem týmu se krok sám
// založí v případu a řešitel dostane úkol s termínem.
export function NextStepApprovalForm({
  action, caseId, members, defaultAssignee, defaultDue, decisions, validityDays,
}: {
  action: Action
  caseId: number
  members: { id: string; full_name: string | null }[]
  defaultAssignee: string | null
  defaultDue: string
  decisions: { id: number; label: string }[]
  validityDays: number | null
}) {
  const { state, formAction, ref, fe } = useResettingForm(action)
  return (
    <form ref={ref} action={formAction} className={box} aria-labelledby={`next-step-${caseId}`}>
      <input type="hidden" name="case_id" value={caseId} />
      <div>
        <h2 id={`next-step-${caseId}`} className="m-0 font-heading text-title2 font-bold">Navrhnout další krok ke schválení</h2>
        <p className="m-0 mt-1 text-callout text-muted">
          Po schválení se krok sám založí v případu a řešitel dostane úkol s termínem. Když žádost někdo zamítne nebo
          vyprší, dostane vlastník případu úkol rozhodnout, jak dál. Schvaluje jiný člen týmu s pravomocí (čtyři oči).
        </p>
      </div>
      {state?.error && <p role="alert" className="m-0 text-callout text-neg">{state.error}</p>}
      {state?.success && <p role="status" className="m-0 text-callout text-pos">Návrh čeká na stránce Ke schválení.</p>}
      <FormField label="Další krok" error={fe.title}>
        <input name="title" required maxLength={300} placeholder="např. Technická analýza" />
      </FormField>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <FormField label="Kdo ho udělá" error={fe.assignee_id}>
          <select name="assignee_id" required defaultValue={defaultAssignee ?? ''}>
            <option value="" disabled>— vyberte —</option>
            {members.map((m) => (
              <option key={m.id} value={m.id}>{m.full_name ?? 'bez jména'}</option>
            ))}
          </select>
        </FormField>
        <FormField label="Termín" error={fe.due_on}>
          <input name="due_on" type="date" required defaultValue={defaultDue} />
        </FormField>
        <FormField label="Z rozhodnutí (volitelně)" error={fe.decision_id}>
          <select name="decision_id" defaultValue="">
            <option value="">— bez vazby na rozhodnutí —</option>
            {decisions.map((d) => (
              <option key={d.id} value={d.id}>{d.label}</option>
            ))}
          </select>
        </FormField>
        <FormField
          label="Žádost platí do (volitelně)"
          error={fe.expires_on}
          hint={validityDays ? `Bez data platí ${validityDays} ${validityDays === 1 ? 'den' : validityDays < 5 ? 'dny' : 'dní'}.` : undefined}
        >
          <input name="expires_on" type="date" />
        </FormField>
      </div>
      <SubmitButton>Požádat o schválení kroku</SubmitButton>
    </form>
  )
}

export function RequestApprovalForm({
  action, caseId, knownKinds,
}: { action: Action; caseId: number; knownKinds: { kind: string; level: string }[] }) {
  const { state, formAction, ref, fe } = useResettingForm(action)
  return (
    <form ref={ref} action={formAction} className={box}>
      <input type="hidden" name="case_id" value={caseId} />
      <p className="m-0 text-callout text-muted">
        Obecná žádost se jen zapíše (kdo co povolil); po schválení se nic samo neprovede.
      </p>
      {state?.error && <p role="alert" className="m-0 text-callout text-neg">{state.error}</p>}
      {state?.success && <p role="status" className="m-0 text-callout text-pos">Požadavek čeká na stránce Ke schválení.</p>}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <FormField
          label="Činnost"
          error={fe.action_kind}
          hint="Stupeň pravomoci se určí podle pravidel, ne tady."
        >
          <input name="action_kind" required list={`kinds-${caseId}`} defaultValue="external_commitment" />
        </FormField>
        <FormField label="Platí do (volitelně)" error={fe.expires_on}>
          <input name="expires_on" type="date" />
        </FormField>
      </div>
      <datalist id={`kinds-${caseId}`}>
        {knownKinds.map((k) => (
          <option key={k.kind} value={k.kind}>{`${k.kind} (${levelWords(k.level)})`}</option>
        ))}
      </datalist>
      <SubmitButton variant="soft">Požádat o schválení</SubmitButton>
    </form>
  )
}

export function RecordDecisionForm({ action, caseId }: { action: Action; caseId: number }) {
  const { state, formAction, ref, fe } = useResettingForm(action)
  return (
    <form ref={ref} action={formAction} className="space-y-3">
      <input type="hidden" name="case_id" value={caseId} />
      {state?.error && <p role="alert" className="m-0 text-callout text-neg">{state.error}</p>}
      <FormField label="Otázka" error={fe.question}>
        <input name="question" required maxLength={1000} />
      </FormField>
      <FormField label="Možnosti (oddělené čárkou)" error={fe.options} hint="Prázdné = volná odpověď.">
        <input name="options" placeholder="ano, ne" />
      </FormField>
      <SubmitButton variant="soft">Přidat otázku</SubmitButton>
    </form>
  )
}

export function ResolveDecisionFreeForm({ action, decisionId, question }: { action: Action; decisionId: number; question: string }) {
  const { state, formAction, ref, fe } = useResettingForm(action)
  return (
    <form ref={ref} action={formAction} className="flex flex-wrap items-end gap-2">
      <input type="hidden" name="decision_id" value={decisionId} />
      <div className="flex-1 min-w-[12rem]">
        <FormField label="Rozhodnutí" error={fe.chosen}>
          <input name="chosen" required maxLength={300} aria-label={`Odpověď — ${question}`} />
        </FormField>
      </div>
      <SubmitButton>Rozhodnout</SubmitButton>
      {state?.error && <p role="alert" className="m-0 w-full text-callout text-neg">{state.error}</p>}
    </form>
  )
}
