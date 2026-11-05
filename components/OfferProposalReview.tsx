'use client'
import { useActionState, useState } from 'react'
import { Chip } from '@/components/Chip'
import { FormField } from '@/components/FormField'
import { SubmitButton } from '@/components/SubmitButton'
import { buttonClass } from '@/components/ui/Button'
import { CheckIcon } from '@/components/ui/Icons'
import { confirmOfferProposal, type OfferProposalView } from '@/domain/crm/actions/offers'
import type { OfferAccountHint } from '@/domain/crm/offerAccount'
import { REVENUE_LINES } from '@/domain/crm/offer-extract'
import { derivedOfferStage } from '@/domain/crm/offerProposal'
import { INJECTION_FLAG_LABELS } from '@/core/untrusted'
import { PILLARS, dealStageLabel, isPillar, phasesFor } from '@/lib/domain'

// Návrh AI z jedné nabídky ke kontrole. Nic není založené, dokud člověk
// nepotvrdí — všechna pole jde opravit a server je znovu ověří.
function accountHint(a: OfferAccountHint): string {
  switch (a.kind) {
    case 'existing': return `Obchod se přiřadí ke stávajícímu klientovi „${a.name}“.`
    case 'new': return 'Nový klient — oficiální jméno, IČO a sídlo se po potvrzení doplní z ARES.'
    case 'ambiguous': return 'Pozor: v Cockpitu je víc klientů s tímto názvem — upřesni ho.'
    default: return 'Nepodařilo se ověřit, jestli klient už v Cockpitu je.'
  }
}

// `as="div"` = uvnitř karty ve frontě „Pošta k zařazení" (návrh zakázky z přílohy
// e-mailu); tam zahození řeší tlačítko karty, takže `onDiscard` chybí.
export function OfferProposalReview({ fileName, proposal, onDiscard, as: Root = 'li', source = 'pdf' }:
  { fileName: string; proposal: OfferProposalView; onDiscard?: () => void; as?: 'li' | 'div'; source?: 'pdf' | 'mail' }) {
  const [state, formAction] = useActionState(confirmOfferProposal, null)
  const f = proposal.fields
  const [pillar, setPillar] = useState<string>(f.pillar ?? '')
  const [phase, setPhase] = useState<string>(f.phase ?? '')
  const failed = state && !state.ok ? state : null
  const fe = failed?.fieldErrors ?? {}
  // Po neúspěšném potvrzení React formulář resetuje na defaultValue — proto
  // se vrací odeslané hodnoty, ať se ruční opravy neztratí.
  const v = (key: string, fallback: string | number | null) => failed?.values?.[key] ?? (fallback == null ? '' : String(fallback))
  const stage = derivedOfferStage(pillar || null, phase || null)
  const phases = isPillar(pillar) ? phasesFor(pillar) : []

  if (state?.ok) {
    return (
      <Root className="rounded-card border border-border bg-surface p-4 text-sm">
        <CheckIcon className="mr-1 inline-block align-[-3px] text-pos" />
        {state.alreadyImported ? <>Nabídka už je založená: <b>{state.title}</b></> : <>Založeno po tvém potvrzení: <b>{state.title}</b></>}
        {state.warnings.length > 0 && <div className="text-xs text-muted mt-1">zkontroluj: {state.warnings.join('; ')}</div>}
        <a href={`/cockpit/clients/${state.accountId}?view=business`} className="text-xs underline block mt-1">Otevřít klienta</a>
      </Root>
    )
  }

  return (
    <Root className={source === 'mail' ? 'mt-4 border-t border-border pt-4' : 'rounded-card border border-border bg-surface p-5 shadow-card'}>
      <form action={formAction} className="space-y-3">
        <input type="hidden" name="proposal_id" defaultValue={proposal.proposalId} />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <Chip tone="warn">Návrh AI</Chip>{' '}
            <span className="text-sm text-muted break-all">{fileName}</span>
          </div>
          {onDiscard && <button type="button" onClick={onDiscard} className={buttonClass('quiet', 'sm')}>Zahodit návrh</button>}
        </div>
        <p className="m-0 text-xs text-muted">
          {source === 'mail'
            ? 'Údaje vytáhla AI z PDF v příloze e-mailu (PDF se v Cockpitu neukládá). Nic se nezaloží, dokud je nezkontroluješ a nepotvrdíš.'
            : 'Údaje vytáhla AI z PDF. Nic se nezaloží, dokud je nezkontroluješ a nepotvrdíš.'}
        </p>

        {proposal.flags.length > 0 && (
          <div role="alert" className="rounded-btn bg-[color:var(--c-neg-soft)] px-3 py-2 text-sm text-neg">
            <p className="m-0 font-semibold">Dokument obsahuje text, který vypadá jako pokyny pro AI.</p>
            <p className="m-0 mt-1">
              {proposal.flags.map((flag) => INJECTION_FLAG_LABELS[flag]).join('; ')}. Návrh ber jako nespolehlivý
              a ověř údaje proti PDF — hlavně klienta, částku a fázi.
            </p>
          </div>
        )}
        {proposal.warnings.length > 0 && (
          <div className="rounded-btn bg-[color:var(--c-warn-soft)] px-3 py-2 text-xs text-[color:var(--c-warn)]">
            zkontroluj: {proposal.warnings.join('; ')}
          </div>
        )}
        {failed?.error && <p role="alert" className="m-0 rounded-btn bg-[color:var(--c-neg-soft)] px-3 py-2 text-sm text-neg">{failed.error}</p>}

        <FormField label="Klient" error={fe.account_name} hint={accountHint(proposal.account)}>
          <input name="account_name" defaultValue={v('account_name', f.account_name)} maxLength={200} required />
        </FormField>
        <FormField label="Název projektu" error={fe.title}>
          <input name="title" defaultValue={v('title', f.title)} maxLength={300} required />
        </FormField>
        <div className="grid gap-x-4 sm:grid-cols-2">
          <FormField label="Pilíř" error={fe.pillar}>
            <select name="pillar" value={pillar} onChange={(e) => { setPillar(e.target.value); setPhase('') }}>
              <option value="">— nevybráno —</option>
              {PILLARS.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
            </select>
          </FormField>
          <FormField label="Fáze pilíře" error={fe.phase}>
            <select name="phase" value={phase} onChange={(e) => setPhase(e.target.value)} disabled={phases.length === 0}>
              <option value="">— nevybráno —</option>
              {phases.map((p) => <option key={p.key} value={p.key}>{p.label}</option>)}
            </select>
          </FormField>
          <FormField label="Typ výnosu" error={fe.revenue_line}>
            <select name="revenue_line" defaultValue={v('revenue_line', f.revenue_line)}>
              {REVENUE_LINES.map((line) => <option key={line} value={line}>{line}</option>)}
            </select>
          </FormField>
          <FormField label="Měna částek v nabídce" error={fe.currency}>
            <select name="currency" defaultValue={v('currency', f.currency)}>
              <option value="CZK">CZK</option>
              <option value="EUR">EUR (přepočte se kurzem ČNB)</option>
            </select>
          </FormField>
          <FormField label="Částka bez DPH" error={fe.amount_one_time}>
            <input name="amount_one_time" type="number" step="any" min={0} defaultValue={v('amount_one_time', f.amount_one_time)} />
          </FormField>
          <FormField label="Náklady" error={fe.cogs_one_time}>
            <input name="cogs_one_time" type="number" step="any" min={0} defaultValue={v('cogs_one_time', f.cogs_one_time)} />
          </FormField>
          <FormField label="Odhad MD" error={fe.estimate_md}>
            <input name="estimate_md" type="number" step="any" min={0} defaultValue={v('estimate_md', f.estimate_md)} />
          </FormField>
          <FormField label="Očekávané uzavření" error={fe.expected_close}>
            <input name="expected_close" type="date" defaultValue={v('expected_close', f.expected_close)} />
          </FormField>
        </div>

        <p role="status" className={`m-0 rounded-btn px-3 py-2 text-sm ${stage === 'vyhráno' ? 'bg-[color:var(--c-warn-soft)] text-[color:var(--c-warn)] font-semibold' : 'bg-[color:var(--c-soft)] text-muted'}`}>
          Obchod se založí ve fázi: {dealStageLabel(stage)}
          {stage === 'vyhráno' && ' — tedy rovnou jako VYHRANÝ (podle fáze pilíře). Potvrď jen, pokud je objednávka skutečně podepsaná.'}
        </p>

        <SubmitButton variant="coral">Potvrdit a založit</SubmitButton>
      </form>
    </Root>
  )
}
