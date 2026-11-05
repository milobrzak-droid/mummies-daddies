'use client'
import { useActionState, useEffect, useState } from 'react'
import { FormField } from '@/components/FormField'
import { SubmitButton } from '@/components/SubmitButton'
import { ChevronRightIcon } from '@/components/ui/Icons'
import type { ActionResult } from '@/lib/actionResult'
import type { Contact, Deal, DealCurrency, DealStage, Partner, TeamMember } from '@/lib/types'
import { DEAL_KINDS, DEAL_STAGES, DEFAULT_DEAL_STAGE, DEFAULT_REVENUE_LINE, PILLARS, REVENUE_LINES, phasesFor, DELIVERY_TEAMS, type Pillar } from '@/lib/domain'
import { checkDealInvariant, DEAL_INVARIANT_MESSAGES } from '@/domain/crm/dealInvariant'
import { DEAL_TRANSITION_FIELDS, DEAL_TRANSITION_MESSAGES, transitionIssues } from '@/domain/crm/dealTransition'

type Action = (prev: unknown, formData: FormData) => Promise<ActionResult>
const SUBSIDIES = ['none','opz_plus','digi_pro_firmy','mpsv_rekvalifikace']
const ADVANCED_FIELDS = new Set([
  'forecast_category', 'probability_pct', 'pillar', 'phase', 'delivery_team', 'revenue_line',
  'cogs_one_time', 'subsidy_program', 'subsidy_pct', 'sourced_by_partner', 'won_at',
  'estimate_md', 'dev_team', 'note', 'status_done', 'status_next', 'status_blocker',
])

export function DealForm({ action, partners, members, contacts, initial }:
  { action: Action; partners: Partner[]; members: TeamMember[]; contacts: Contact[]; initial?: Deal }) {
  const [state, formAction] = useActionState(action, null)
  const fe = state?.fieldErrors ?? {}
  const [pillar, setPillar] = useState<Pillar>((initial?.pillar as Pillar) ?? PILLARS[0].key)
  const [phase, setPhase] = useState<string>(initial?.phase ?? '')
  const [stage, setStage] = useState<DealStage>(initial?.stage ?? DEFAULT_DEAL_STAGE)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const [ownerId, setOwnerId] = useState<string>(initial?.owner_id ?? '')
  const [nextStep, setNextStep] = useState<string>(initial?.next_step ?? '')
  const [nextStepDue, setNextStepDue] = useState<string>(initial?.next_step_due ?? '')
  const [noStepReason, setNoStepReason] = useState<string>(initial?.no_next_step_reason ?? '')
  const [decisionMaker, setDecisionMaker] = useState<string>(initial?.decision_maker ?? '')
  const [decisionDue, setDecisionDue] = useState<string>(initial?.decision_due ?? '')
  const [lostReason, setLostReason] = useState<string>(initial?.lost_reason ?? '')
  // Povinná pole při PŘECHODU fáze (0052) — stejná pravidla jako server
  // a DB trigger; ukazují se hned u výběru fáze, ne až po uložení.
  const stageIssues = transitionIssues({
    stage: initial?.stage ?? null,
    decision_maker: decisionMaker, decision_due: decisionDue, lost_reason: lostReason,
  }, stage)
  const issueFields = new Set(stageIssues.map((issue) => DEAL_TRANSITION_FIELDS[issue]))
  const opportunityFirst = stage === 'rozhodovani'
  // Prázdný vlastník u nového obchodu se doplní automaticky podle klienta,
  // proto se tam za porušení nebere. Ukládání se neblokuje — jen varování.
  const violations = checkDealInvariant({
    stage, owner_id: ownerId || (initial ? null : 'auto'),
    next_step: nextStep, next_step_due: nextStepDue, no_next_step_reason: noStepReason,
  })
  const missingStep = violations.includes('missing_next_step')
  const hasStep = nextStep.trim() !== '' && nextStepDue !== ''
  const phases = phasesFor(pillar)
  const isClosedStage = stage === 'vyhráno' || stage === 'prohráno'

  const [currency, setCurrency] = useState<DealCurrency>(initial?.currency ?? 'CZK')
  const [amountEur, setAmountEur] = useState<string>(initial?.amount_one_time_original?.toString() ?? '')
  const [fxRate, setFxRate] = useState<number | null>(initial?.fx_rate != null ? Number(initial.fx_rate) : null)
  const [fxError, setFxError] = useState('')

  const hasAdvancedErrors = Object.keys(fe).some((field) => ADVANCED_FIELDS.has(field))

  useEffect(() => {
    if (currency !== 'EUR') return
    let cancelled = false
    fetch('/api/fx')
      .then((r) => r.json())
      .then((d) => { if (!cancelled && d.czkPerEur) { setFxRate(d.czkPerEur); setFxError('') } })
      .catch(() => { if (!cancelled) setFxError('Kurz se nepodařilo načíst, dopočítá se až při uložení.') })
    return () => { cancelled = true }
  }, [currency])

  return (
    <form action={formAction} className="max-w-3xl rounded-card border border-border bg-surface p-5 shadow-card sm:p-6">
      <div className="mb-6 flex items-start justify-between gap-3">
        <div>
          <h2 className="m-0 font-heading text-title2 font-bold">{initial ? 'Upravit obchod' : 'Založit obchod'}</h2>
          <p className="mb-0 mt-1 text-callout text-muted">Začni tím důležitým. Interní a realizační údaje můžeš doplnit později.</p>
        </div>
        <span className="eyebrow">Rychlé zadání</span>
      </div>

      {state?.error && <p role="alert" className="mb-4 rounded-btn bg-[color:var(--c-neg-soft)] px-3 py-2 text-sm text-neg">{state.error}</p>}

      <FormField label="Název obchodu" error={fe.title}>
        <input name="title" defaultValue={initial?.title ?? ''} placeholder="Např. AI akademie pro management" autoFocus={!initial} required />
      </FormField>

      <div className="mt-4 grid gap-x-4 sm:grid-cols-2">
        <FormField label="Fáze" error={fe.stage}>
          <select name="stage" value={stage} onChange={(e) => setStage(e.target.value as DealStage)}>
            {DEAL_STAGES.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
          </select>
        </FormField>
        <FormField label="Obchodník" error={fe.owner_id}>
          <select name="owner_id" value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
            <option value="">Automaticky podle klienta</option>
            {members.map((member) => <option key={member.id} value={member.id}>{member.full_name}</option>)}
          </select>
        </FormField>
        <FormField label="Hlavní kontakt" error={fe.primary_contact_id}>
          <select name="primary_contact_id" defaultValue={initial?.primary_contact_id ?? ''}>
            <option value="">— zatím nevybrán —</option>
            {contacts.map((contact) => <option key={contact.id} value={contact.id}>{contact.full_name}</option>)}
          </select>
        </FormField>
        <FormField label="Očekávané uzavření" error={fe.expected_close}>
          <input name="expected_close" type="date" defaultValue={initial?.expected_close ?? ''} />
        </FormField>
      </div>

      {stageIssues.length > 0 && (
        <div role="status" className="mt-1 rounded-btn bg-[color:var(--c-neg-soft)] px-3 py-2 text-sm text-neg">
          {stageIssues.map((issue) => <p key={issue} className="m-0">{DEAL_TRANSITION_MESSAGES[issue]}</p>)}
        </div>
      )}

      {stage === 'prohráno' && (
        <div className="mt-1">
          <FormField label="Důvod prohry" error={fe.lost_reason}>
            <input
              name="lost_reason"
              value={lostReason}
              onChange={(e) => setLostReason(e.target.value)}
              placeholder="Co se tým může z tohoto obchodu naučit?"
              aria-invalid={issueFields.has('lost_reason') || undefined}
              required
            />
          </FormField>
        </div>
      )}

      <section className="mt-5 rounded-card border border-border p-4">
        <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
          <div>
            <p className="eyebrow m-0">Příležitost</p>
            <h3 className="mb-0 mt-1 text-headline">Co klient řeší a jak rozhoduje?</h3>
          </div>
          {opportunityFirst && <span className="text-xs text-muted">Pro fázi Rozhodování je povinný rozhodovatel a termín.</span>}
        </div>
        <div className="grid gap-x-4 sm:grid-cols-2">
          <FormField label="Typ obchodu" error={fe.deal_kind}>
            <select name="deal_kind" defaultValue={initial?.deal_kind ?? ''}>
              <option value="">— doplnit —</option>
              {DEAL_KINDS.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
            </select>
          </FormField>
          <FormField label="Zdroj odhadu hodnoty" error={fe.value_basis}>
            <input name="value_basis" defaultValue={initial?.value_basis ?? ''} maxLength={500} placeholder="Např. ceník workshopu, rozpočet od klienta" />
          </FormField>
        </div>
        <p className="mb-3 mt-0 text-xs text-muted">Workshop a implementace jsou samostatné obchody — domluvený workshop ještě není schválená implementace.</p>
        <div className="grid gap-x-4 sm:grid-cols-2">
          <FormField label="Problém" error={fe.problem}>
            <textarea name="problem" rows={2} defaultValue={initial?.problem ?? ''} maxLength={2000} placeholder="Co klienta pálí?" />
          </FormField>
          <FormField label="Očekávaný výsledek" error={fe.expected_outcome}>
            <textarea name="expected_outcome" rows={2} defaultValue={initial?.expected_outcome ?? ''} maxLength={2000} placeholder="Podle čeho klient pozná, že se to povedlo?" />
          </FormField>
          <FormField label="Kdo rozhoduje" error={fe.decision_maker}>
            <input
              name="decision_maker"
              value={decisionMaker}
              onChange={(e) => setDecisionMaker(e.target.value)}
              maxLength={200}
              placeholder="Jméno a role"
              aria-invalid={issueFields.has('decision_maker') || undefined}
            />
          </FormField>
          <FormField label="Termín rozhodnutí" error={fe.decision_due}>
            <input
              name="decision_due"
              type="date"
              value={decisionDue}
              onChange={(e) => setDecisionDue(e.target.value)}
              aria-invalid={issueFields.has('decision_due') || undefined}
            />
          </FormField>
        </div>
        <FormField label="Rozhodovací proces" error={fe.decision_process}>
          <textarea name="decision_process" rows={2} defaultValue={initial?.decision_process ?? ''} maxLength={2000} placeholder="Kdo schvaluje, v jakém pořadí, co k tomu potřebuje" />
        </FormField>
      </section>

      <section className="mt-5 rounded-card border border-[color:rgba(20,25,34,.12)] bg-[color:var(--c-soft)] p-4">
        <div className="mb-3">
          <p className="eyebrow m-0">Nejdůležitější pro tým</p>
          <h3 className="mb-0 mt-1 text-headline">Co se má stát dál?</h3>
        </div>
        <div className="grid gap-x-4 sm:grid-cols-[1fr_180px]">
          <FormField label="Další krok" error={fe.next_step}>
            <input name="next_step" value={nextStep} onChange={(e) => setNextStep(e.target.value)} placeholder="Např. poslat upravenou nabídku" />
          </FormField>
          <FormField label="Termín" error={fe.next_step_due}>
            <input name="next_step_due" type="date" value={nextStepDue} onChange={(e) => setNextStepDue(e.target.value)} />
          </FormField>
        </div>
        {violations.length > 0 && (
          <div role="status" className="mt-2 rounded-btn bg-[color:var(--c-neg-soft)] px-3 py-2 text-sm text-neg">
            {violations.map((v) => <p key={v} className="m-0">{DEAL_INVARIANT_MESSAGES[v]}</p>)}
          </div>
        )}
        {(!hasStep || noStepReason) && (
          <div className="mt-3">
            <FormField label="Proč žádný další krok není?" error={fe.no_next_step_reason}>
              <input
                name="no_next_step_reason"
                value={noStepReason}
                onChange={(e) => setNoStepReason(e.target.value)}
                maxLength={500}
                placeholder="Např. čekáme na rozpočet klienta do Q1"
                aria-invalid={missingStep || undefined}
              />
            </FormField>
          </div>
        )}
      </section>

      <div className="mt-5 grid gap-x-4 sm:grid-cols-2">
        <FormField label="Měna">
          <select name="currency" value={currency} onChange={(e) => setCurrency(e.target.value as DealCurrency)}>
            <option value="CZK">Kč</option>
            <option value="EUR">EUR — přepočet živým kurzem ČNB</option>
          </select>
        </FormField>
        {currency === 'CZK' ? (
          <FormField label="Hodnota obchodu (Kč)" error={fe.amount_one_time}>
            <input name="amount_one_time" type="number" step="0.01" defaultValue={initial?.amount_one_time ?? ''} placeholder="0" />
          </FormField>
        ) : (
          <FormField label="Hodnota obchodu (EUR)" error={fe.amount_one_time_original}>
            <input name="amount_one_time_original" type="number" step="0.01" value={amountEur} onChange={(e) => setAmountEur(e.target.value)} placeholder="0" />
            <p className="mt-1 text-xs text-muted">
              {fxError ? fxError : fxRate
                ? `≈ ${amountEur ? Math.round(Number(amountEur) * fxRate).toLocaleString('cs-CZ') : '—'} Kč (kurz ${fxRate.toFixed(3)} Kč/€)`
                : 'Načítám kurz…'}
            </p>
          </FormField>
        )}
      </div>

      <details
        className="group mt-5 rounded-card border border-border"
        open={advancedOpen || hasAdvancedErrors}
        onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}
      >
        <summary className="cursor-pointer list-none px-4 py-3 text-sm font-medium text-ink">
          <ChevronRightIcon className="mr-1 inline-block align-[-3px] transition-transform group-open:rotate-90" />
          Pokročilé údaje
          <span className="ml-2 text-xs font-normal text-muted">odhad, dotace, realizace a interní stav</span>
        </summary>
        <div className="space-y-6 border-t border-border p-4">
          <section>
            <h3 className="mb-3 mt-0 text-headline">Odhad a obchodní model</h3>
            <div className="grid gap-x-4 sm:grid-cols-2">
              <FormField label="Odhad výsledku" error={fe.forecast_category}>
                <select name="forecast_category" defaultValue={isClosedStage ? 'closed' : (initial?.forecast_category ?? 'pipeline')}>
                  {isClosedStage ? <option value="closed">Uzavřeno</option> : <><option value="pipeline">Běžný</option><option value="best_case">Optimistický scénář</option><option value="commit">Jisté</option></>}
                </select>
              </FormField>
              <FormField label="Pravděpodobnost %" error={fe.probability_pct}>
                <input name="probability_pct" type="number" min="0" max="100" defaultValue={initial?.probability_pct ?? ''} placeholder="Doplní se podle fáze" />
              </FormField>
              <FormField label="Produktová linka" error={fe.revenue_line}>
                <select name="revenue_line" defaultValue={initial?.revenue_line ?? DEFAULT_REVENUE_LINE}>
                  {REVENUE_LINES.map((line) => <option key={line.key} value={line.key}>{line.label}</option>)}
                </select>
              </FormField>
              <FormField label="Přímé náklady (Kč)" error={fe.cogs_one_time}>
                <input name="cogs_one_time" type="number" step="0.01" defaultValue={initial?.cogs_one_time ?? ''} />
              </FormField>
            </div>
          </section>

          <section>
            <h3 className="mb-3 mt-0 text-headline">Pilíř a realizace</h3>
            <div className="grid gap-x-4 sm:grid-cols-3">
              <FormField label="Pilíř" error={fe.pillar}>
                <select name="pillar" value={pillar} onChange={(e) => { const value = e.target.value as Pillar; setPillar(value); setPhase('') }}>
                  {PILLARS.map((item) => <option key={item.key} value={item.key}>{item.label} — {item.sub}</option>)}
                </select>
              </FormField>
              <FormField label="Fáze realizace" error={fe.phase}>
                <select name="phase" value={phase} onChange={(e) => setPhase(e.target.value)}>
                  <option value="">—</option>
                  {phases.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
                </select>
              </FormField>
              <FormField label="Realizační tým" error={fe.delivery_team}>
                <select name="delivery_team" defaultValue={initial?.delivery_team ?? ''}>
                  <option value="">—</option>
                  {DELIVERY_TEAMS.map((item) => <option key={item.key} value={item.key}>{item.label}</option>)}
                </select>
              </FormField>
            </div>
          </section>

          <section>
            <h3 className="mb-3 mt-0 text-headline">Dotace a kanál</h3>
            <div className="grid gap-x-4 sm:grid-cols-2">
              <FormField label="Dotační program" error={fe.subsidy_program}>
                <select name="subsidy_program" defaultValue={initial?.subsidy_program ?? 'none'}>{SUBSIDIES.map((value) => <option key={value} value={value}>{value}</option>)}</select>
              </FormField>
              <FormField label="Dotace %" error={fe.subsidy_pct}>
                <input name="subsidy_pct" type="number" min="0" max="100" step="0.01" defaultValue={initial?.subsidy_pct ?? '0'} />
              </FormField>
              <FormField label="Kanál / dodavatel" error={fe.sourced_by_partner}>
                <select name="sourced_by_partner" defaultValue={initial?.sourced_by_partner ?? ''}>
                  <option value="">—</option>
                  {partners.map((partner) => <option key={partner.id} value={partner.id}>{partner.name}</option>)}
                </select>
              </FormField>
              <FormField label="Vyhráno dne" error={fe.won_at}>
                <input name="won_at" type="date" defaultValue={initial?.won_at ?? ''} />
              </FormField>
            </div>
          </section>

          <section>
            <h3 className="mb-3 mt-0 text-headline">Interní stav dodávky</h3>
            <div className="grid gap-x-4 sm:grid-cols-2">
              <FormField label="Odhad rozsahu (MD)" error={fe.estimate_md}><input name="estimate_md" type="number" defaultValue={initial?.estimate_md ?? ''} /></FormField>
              <FormField label="Řešitelé (čárkou)" error={fe.dev_team}><input name="dev_team" defaultValue={(initial?.dev_team ?? []).join(', ')} placeholder="Jirka, Vítek" /></FormField>
            </div>
            <FormField label="Poznámka / rozsah" error={fe.note}><textarea name="note" rows={2} defaultValue={initial?.note ?? ''} /></FormField>
            <div className="mt-3 grid gap-x-4 sm:grid-cols-3">
              <FormField label="Hotovo" error={fe.status_done}><input name="status_done" defaultValue={initial?.status_done ?? ''} /></FormField>
              <FormField label="Další krok dodávky" error={fe.status_next}><input name="status_next" defaultValue={initial?.status_next ?? ''} /></FormField>
              <FormField label="Blokery" error={fe.status_blocker}><input name="status_blocker" defaultValue={initial?.status_blocker ?? ''} /></FormField>
            </div>
          </section>
        </div>
      </details>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 border-t border-border pt-5">
        <p className="m-0 text-xs text-muted">Hodnotu i detaily lze kdykoliv upravit na tabuli obchodů.</p>
        <SubmitButton variant="coral">{initial ? 'Uložit změny' : 'Založit obchod'}</SubmitButton>
      </div>
    </form>
  )
}
