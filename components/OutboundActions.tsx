'use client'
import { useActionState } from 'react'
import { SubmitButton } from '@/components/SubmitButton'
import { reviewOutreach, reviewSignal, type ReviewResult } from '@/domain/outbound/actions/review'

// Akce CSO na stránce Signály (P7). Každé tlačítko je vlastní formulář
// s vlastním stavem; po akci se ukáže jen věta výsledku.
type Btn = { action: string; label: string; variant?: 'default' | 'coral' | 'soft' | 'quiet' | 'danger' }

function ActionRow({ buttons, run, label }: { buttons: Btn[]; run: (action: string) => Promise<ReviewResult>; label: string }) {
  const [state, act] = useActionState<ReviewResult | null, FormData>(async (_prev, fd) => run(String(fd.get('action') ?? '')), null)
  if (state?.ok) return <span role="status" className="text-footnote text-muted">{state.message}</span>
  return (
    <div className="flex flex-wrap items-center gap-2">
      {buttons.map((b) => (
        <form key={b.action} action={act}>
          <input type="hidden" name="action" value={b.action} />
          <SubmitButton variant={b.variant ?? 'soft'} size="sm" aria-label={`${b.label}: ${label}`}>{b.label}</SubmitButton>
        </form>
      ))}
      {state && !state.ok && <span role="alert" className="m-0 text-footnote text-neg">{state.message}</span>}
    </div>
  )
}

export function SignalActions({ id, status, label }: { id: number; status: string; label: string }) {
  const buttons: Btn[] = status === 'dismissed'
    ? [{ action: 'reopen', label: 'Znovu zvážit' }]
    : ['new', 'review', 'failed'].includes(status)
      ? [{ action: 'create_lead', label: 'Založit lead', variant: 'default' }, { action: 'dismiss', label: 'Odložit', variant: 'quiet' }]
      : []
  if (!buttons.length) return null
  return <ActionRow buttons={buttons} run={(a) => reviewSignal(id, a)} label={label} />
}

export function OutreachActions({ id, channel, status, label }: { id: number; channel: string; status: string; label: string }) {
  let buttons: Btn[] = []
  if (status === 'draft' && channel === 'manual') {
    buttons = [{ action: 'done', label: 'Osloveno ručně', variant: 'default' }, { action: 'reject', label: 'Neoslovovat', variant: 'quiet' }]
  } else if (status === 'draft') {
    buttons = [{ action: 'approve', label: 'Schválit k odeslání', variant: 'default' }, { action: 'reject', label: 'Zamítnout', variant: 'quiet' }]
  } else if (status === 'approved') {
    buttons = [{ action: 'reject', label: 'Zastavit', variant: 'quiet' }]
  }
  if (channel !== 'manual' && ['draft', 'approved', 'queued', 'sent'].includes(status)) {
    buttons.push({ action: 'opt_out', label: 'Zapsat odhlášení', variant: 'danger' })
  }
  if (!buttons.length) return null
  return <ActionRow buttons={buttons} run={(a) => reviewOutreach(id, a)} label={label} />
}
