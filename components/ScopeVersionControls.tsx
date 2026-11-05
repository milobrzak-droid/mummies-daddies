'use client'
// Ovládání verzí nabídky na detailu obchodu (kap. 5, migrace 0072):
// tlačítka přechodů (odeslat / přijmout / odmítnout) a formulář nové verze
// předvyplněný z poslední verze. Jen pro obchodní role — stránka komponentu
// jiným rolím nevykreslí. Od 0084 koncept, který potřebuje schválení, nabídne
// „Požádat o schválení odeslání"; schválený „Označit jako odeslanou".
import { useActionState, useEffect, useRef } from 'react'
import { useFormStatus } from 'react-dom'
import { FormField } from '@/components/FormField'
import { SubmitButton } from '@/components/SubmitButton'
import { buttonClass } from '@/components/ui/Button'
import Link from 'next/link'
import {
  acceptScopeVersion,
  createScopeVersion,
  rejectScopeVersion,
  requestScopeVersionSendApproval,
  sendScopeVersion,
} from '@/domain/crm/actions/scopeVersions'
import {
  scopeVersionActions,
  type ScopeDraftDefaults,
  type ScopeSendState,
  type ScopeVersionAction,
  type ScopeVersionStatus,
} from '@/domain/crm/scopeVersion'

const ACTION_LABEL: Record<ScopeVersionAction, string> = {
  send: 'Odeslat',
  accept: 'Přijmout',
  reject: 'Odmítnout',
  request_send: 'Požádat o schválení odeslání',
}

const ACTION_FN = {
  send: sendScopeVersion,
  accept: acceptScopeVersion,
  reject: rejectScopeVersion,
  request_send: requestScopeVersionSendApproval,
} as const

function SmallButton({ children, label, tone = 'ink' }: { children: React.ReactNode; label: string; tone?: 'ink' | 'neg' }) {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      aria-label={label}
      aria-busy={pending}
      className={buttonClass(tone === 'neg' ? 'danger' : 'outline', 'sm')}
    >
      {pending ? 'Ukládám…' : children}
    </button>
  )
}

function ActionForm({
  accountId, dealId, versionId, version, kind, label,
}: {
  accountId: number; dealId: number; versionId: number; version: number; kind: ScopeVersionAction; label?: string
}) {
  const [state, formAction] = useActionState(ACTION_FN[kind].bind(null, accountId, dealId, versionId), null)
  const text = label ?? ACTION_LABEL[kind]
  if (kind === 'request_send' && state?.success) {
    return <span role="status" className="text-sm font-semibold text-pos">Žádost čeká na schválení.</span>
  }
  return (
    <form
      action={formAction}
      className="inline-flex items-center gap-2"
      onSubmit={(e) => {
        if (kind === 'accept' && !window.confirm(`Přijmout verzi ${version}? Částky obchodu se nastaví podle ní a ostatní otevřené verze budou nahrazeny.`)) {
          e.preventDefault()
        }
      }}
    >
      <SmallButton label={`${text} — verze ${version}`} tone={kind === 'reject' ? 'neg' : 'ink'}>
        {text}
      </SmallButton>
      {state?.error && <span role="alert" className="text-neg text-sm">{state.error}</span>}
    </form>
  )
}

export function ScopeVersionButtons({
  accountId, dealId, versionId, version, status, sendState = 'free',
}: {
  accountId: number; dealId: number; versionId: number; version: number; status: ScopeVersionStatus; sendState?: ScopeSendState
}) {
  const actions = scopeVersionActions(status, sendState)
  if (status === 'draft' && sendState === 'pending') {
    return (
      <Link href="/cockpit/rozhodnuti?druh=schvaleni" className="st no-underline" aria-label={`Verze ${version} čeká na schválení odeslání`}>
        Čeká na schválení
      </Link>
    )
  }
  if (actions.length === 0) return <span className="text-muted">—</span>
  return (
    <div className="flex flex-wrap items-center gap-3">
      {status === 'draft' && sendState === 'approved' && <span className="st done">Schváleno k odeslání</span>}
      {actions.map((a) => (
        <ActionForm
          key={a}
          accountId={accountId}
          dealId={dealId}
          versionId={versionId}
          version={version}
          kind={a}
          label={a === 'send' && sendState === 'approved' ? 'Označit jako odeslanou' : undefined}
        />
      ))}
    </div>
  )
}

export function NewScopeVersionForm({
  accountId, dealId, defaults, nextVersion,
}: { accountId: number; dealId: number; defaults: ScopeDraftDefaults; nextVersion: number }) {
  const [state, formAction] = useActionState(createScopeVersion.bind(null, accountId, dealId), null)
  const formRef = useRef<HTMLFormElement>(null)
  useEffect(() => {
    if (state?.success) formRef.current?.closest('details')?.removeAttribute('open')
  }, [state])
  return (
    <details className="mt-3 rounded-tile border border-border bg-[color:var(--c-soft)] px-5 py-3">
      <summary className="flex min-h-[40px] cursor-pointer items-center text-headline">+ Nová verze (v{nextVersion})</summary>
      <form ref={formRef} action={formAction} className="mt-3 grid gap-3 md:grid-cols-3">
        <p className="md:col-span-3 text-sm text-muted m-0">
          Předvyplněno z poslední verze. Nová verze vznikne jako koncept; klientovi ji pak označ jako odeslanou.
        </p>
        <div className="md:col-span-3">
          <FormField label="Rozsah" error={state?.fieldErrors?.scope}>
            <textarea name="scope" required maxLength={4000} rows={4} defaultValue={defaults.scope} className="w-full" />
          </FormField>
        </div>
        <FormField label="Jednorázově" error={state?.fieldErrors?.amount_one_time}>
          <input name="amount_one_time" type="number" min={0} step="0.01" inputMode="decimal" defaultValue={defaults.amount_one_time} className="w-full" />
        </FormField>
        <FormField label="Měsíčně" error={state?.fieldErrors?.expected_mrr}>
          <input name="expected_mrr" type="number" min={0} step="0.01" inputMode="decimal" defaultValue={defaults.expected_mrr} className="w-full" />
        </FormField>
        <FormField label="Měna" error={state?.fieldErrors?.currency}>
          <select name="currency" defaultValue={defaults.currency} className="w-full">
            <option value="CZK">CZK</option>
            <option value="EUR">EUR</option>
          </select>
        </FormField>
        <div className="md:col-span-3 flex items-center gap-3">
          <SubmitButton>Založit koncept</SubmitButton>
          {state?.error && <span role="alert" className="text-neg text-sm">{state.error}</span>}
        </div>
      </form>
    </details>
  )
}
