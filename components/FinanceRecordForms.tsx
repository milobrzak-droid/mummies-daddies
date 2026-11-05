'use client'
// Formuláře finančních záznamů (0063): založení, úprava a zrušení.
// Záznam se nemaže, jen ruší — historie zůstává. Zrušení je nevratné (ze stavu
// „Zrušeno“ nevede žádný přechod), proto se potvrzuje; přidání a úprava jsou
// v bočním panelu nad tabulkou, ne ve formuláři pod ní.
import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'
import { FormField } from '@/components/FormField'
import { SubmitButton } from '@/components/SubmitButton'
import { FinancePanel } from '@/components/FinancePanel'
import { buttonClass } from '@/components/ui/Button'
import { useUndoToast } from '@/components/ui/Toast'
import {
  cancelFinancialRecord,
  createFinancialRecord,
  updateFinancialRecord,
} from '@/domain/finance/actions/records'
import type { ActionResult } from '@/lib/actionResult'
import {
  CURRENCIES,
  FINANCIAL_KINDS,
  FINANCIAL_KIND_LABEL,
  FINANCIAL_SOURCE_LABEL,
  FINANCIAL_STATUS_TRANSITIONS,
  FINANCIAL_STATUS_LABEL,
  MANUAL_SOURCES,
  formatMoney,
  monthOf,
  type Currency,
  type FinancialKind,
  type FinancialStatus,
} from '@/domain/finance/records'

type AccountOption = { id: number; name: string }

export function FinanceRecordCreateForm({
  accounts,
  defaultMonth,
  accountingSystem,
  onSaved,
}: {
  accounts: AccountOption[]
  defaultMonth: string
  accountingSystem: string
  /** Po úspěšném uložení (panel se zavře a toast to potvrdí). */
  onSaved?: () => void
}) {
  const [state, formAction] = useActionState(async (prev: ActionResult | null, fd: FormData) => {
    const res = await createFinancialRecord(prev, fd)
    if (res.success) onSaved?.()
    return res
  }, null)
  const fe = state?.fieldErrors
  // Splatnost dává smysl jen u faktury (0090), jinak pole vůbec není ve formuláři.
  const [kind, setKind] = useState<FinancialKind>('potential')
  return (
    <form action={formAction} className="grid gap-4 sm:grid-cols-2">
      <div className="sm:col-span-2">
        <FormField label="Firma" error={fe?.account_id}>
          <select name="account_id" required defaultValue="" className="w-full">
            <option value="" disabled>Vyber firmu…</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </FormField>
      </div>
      <div className="sm:col-span-2">
        <FormField label="Druh" error={fe?.kind}>
          <select name="kind" required value={kind} onChange={(e) => setKind(e.target.value as FinancialKind)} className="w-full">
            {FINANCIAL_KINDS.map((k) => (
              <option key={k} value={k}>{FINANCIAL_KIND_LABEL[k]}</option>
            ))}
          </select>
        </FormField>
      </div>
      <FormField label="Částka" error={fe?.amount}>
        <input name="amount" required inputMode="decimal" placeholder="např. 120000" className="w-full tabular-nums" />
      </FormField>
      <FormField label="Měna" error={fe?.currency}>
        <select name="currency" defaultValue="CZK" className="w-full">
          {CURRENCIES.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      </FormField>
      <FormField label="Měsíc" error={fe?.period_month}>
        <input name="period_month" type="month" required defaultValue={defaultMonth} className="w-full" />
      </FormField>
      <FormField label="Stav" error={fe?.status}>
        <select name="status" defaultValue="draft" className="w-full">
          <option value="draft">{FINANCIAL_STATUS_LABEL.draft}</option>
          <option value="confirmed">{FINANCIAL_STATUS_LABEL.confirmed}</option>
        </select>
      </FormField>
      <FormField label="Zdroj" error={fe?.source}>
        <select name="source" defaultValue="rucne" className="w-full">
          {MANUAL_SOURCES.map((s) => (
            <option key={s} value={s}>{FINANCIAL_SOURCE_LABEL[s]}</option>
          ))}
        </select>
      </FormField>
      <FormField
        label={`Číslo dokladu (${accountingSystem})`}
        error={fe?.external_ref}
        hint="Povinné u potvrzené faktury a úhrady."
      >
        <input name="external_ref" maxLength={200} className="w-full" />
      </FormField>
      {kind === 'invoiced' && (
        <FormField label="Splatnost" error={fe?.due_on} hint="Volitelné. Bez data se po splatnosti nehlídá.">
          <input name="due_on" type="date" className="w-full" />
        </FormField>
      )}
      <div className="sm:col-span-2">
        <FormField label="Poznámka" error={fe?.note}>
          <input name="note" maxLength={2000} className="w-full" />
        </FormField>
      </div>
      <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
        <SubmitButton variant="coral">Přidat záznam</SubmitButton>
        {state?.error && <p role="alert" className="m-0 text-callout text-neg">{state.error}</p>}
      </div>
    </form>
  )
}

/** Hlavní akce stránky: „Přidat záznam“ otevře boční panel s formulářem. */
export function FinanceRecordCreatePanel({
  accounts,
  defaultMonth,
  accountingSystem,
}: {
  accounts: AccountOption[]
  defaultMonth: string
  accountingSystem: string
}) {
  const [open, setOpen] = useState(false)
  const toast = useUndoToast()
  return (
    <>
      <button type="button" className={buttonClass('primary')} onClick={() => setOpen(true)} aria-haspopup="dialog">
        <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
        Přidat záznam
      </button>
      <FinancePanel
        open={open}
        onClose={() => setOpen(false)}
        title="Přidat záznam"
        sub={`Každý druh peněz se vede zvlášť. Doklady opisuješ z ${accountingSystem}.`}
      >
        <FinanceRecordCreateForm
          accounts={accounts}
          defaultMonth={defaultMonth}
          accountingSystem={accountingSystem}
          onSaved={() => {
            setOpen(false)
            toast.show({ message: 'Záznam je uložený.' })
          }}
        />
      </FinancePanel>
    </>
  )
}

function CancelConfirmButton() {
  const { pending } = useFormStatus()
  return (
    <button type="submit" disabled={pending} aria-busy={pending} className={buttonClass('danger', 'sm')}>
      {pending ? 'Ruším…' : 'Ano, zrušit'}
    </button>
  )
}

type EditableRecord = {
  id: number
  kind: FinancialKind
  amount: number | string
  currency: Currency
  period_month: string
  status: FinancialStatus
  external_ref: string | null
  note: string | null
  /** Splatnost faktury (0090); pole se ukáže jen u druhu Vyfakturováno. */
  due_on?: string | null
  account_name?: string | null
}

function FinanceRecordEditForm({ record, accountingSystem, onSaved }: { record: EditableRecord; accountingSystem: string; onSaved: () => void }) {
  const [state, formAction] = useActionState(async (prev: ActionResult | null, fd: FormData) => {
    const res = await updateFinancialRecord(record.id, prev, fd)
    if (res.success) onSaved()
    return res
  }, null)
  const statuses: FinancialStatus[] = [record.status, ...FINANCIAL_STATUS_TRANSITIONS[record.status]].filter(
    (s) => s !== 'cancelled',
  )
  const fe = state?.fieldErrors
  return (
    <form action={formAction} className="grid gap-4 sm:grid-cols-2">
      <FormField label="Částka" error={fe?.amount}>
        <input name="amount" required inputMode="decimal" defaultValue={String(record.amount)} className="w-full tabular-nums" />
      </FormField>
      <FormField label="Měna" error={fe?.currency}>
        <select name="currency" defaultValue={record.currency} className="w-full">
          {CURRENCIES.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
      </FormField>
      <FormField label="Měsíc" error={fe?.period_month}>
        <input name="period_month" type="month" required defaultValue={monthOf(record.period_month)} className="w-full" />
      </FormField>
      <FormField label="Stav" error={fe?.status}>
        <select name="status" defaultValue={record.status} className="w-full">
          {statuses.map((s) => (
            <option key={s} value={s}>{FINANCIAL_STATUS_LABEL[s]}</option>
          ))}
        </select>
      </FormField>
      <div className="sm:col-span-2">
        <FormField label={`Číslo dokladu (${accountingSystem})`} error={fe?.external_ref}>
          <input name="external_ref" maxLength={200} defaultValue={record.external_ref ?? ''} className="w-full" />
        </FormField>
      </div>
      {record.kind === 'invoiced' && (
        <div className="sm:col-span-2">
          <FormField label="Splatnost" error={fe?.due_on} hint="Prázdné pole = bez splatnosti (po splatnosti se nehlídá).">
            <input name="due_on" type="date" defaultValue={record.due_on ?? ''} className="w-full" />
          </FormField>
        </div>
      )}
      <div className="sm:col-span-2">
        <FormField label="Poznámka" error={fe?.note}>
          <input name="note" maxLength={2000} defaultValue={record.note ?? ''} className="w-full" />
        </FormField>
      </div>
      <div className="flex flex-wrap items-center gap-3 sm:col-span-2">
        <SubmitButton>Uložit změny</SubmitButton>
        {state?.error && <p role="alert" className="m-0 text-callout text-neg">{state.error}</p>}
      </div>
    </form>
  )
}

export function FinanceRecordActions({
  record,
  accountingSystem,
}: {
  record: EditableRecord
  accountingSystem: string
}) {
  const [open, setOpen] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const toast = useUndoToast()
  const [cancelState, cancelAction] = useActionState(async () => {
    const res = await cancelFinancialRecord(record.id)
    if (res.success) {
      setConfirming(false)
      toast.show({ message: 'Záznam je zrušený. V historii zůstává.' })
    }
    return res
  }, null)
  if (record.status === 'cancelled') return <span className="text-footnote text-muted">—</span>
  const what = `${FINANCIAL_KIND_LABEL[record.kind]} ${formatMoney(Number(record.amount), record.currency)}${record.account_name ? ` · ${record.account_name}` : ''}`
  return (
    <div className="flex flex-col items-end gap-2">
      {confirming ? (
        <form action={cancelAction} className="flex flex-wrap items-center justify-end gap-2" aria-label={`Zrušit záznam ${what}`}>
          <span className="text-footnote text-muted">Zrušení nejde vrátit.</span>
          <CancelConfirmButton />
          <button type="button" className={buttonClass('quiet', 'sm')} onClick={() => setConfirming(false)}>Nechat</button>
        </form>
      ) : (
        <div className="flex flex-wrap items-center justify-end gap-1">
          <button type="button" className={buttonClass('outline', 'sm')} onClick={() => setOpen(true)} aria-haspopup="dialog" aria-label={`Upravit — ${what}`}>
            Upravit
          </button>
          <button type="button" className={buttonClass('quiet', 'sm', 'text-neg hover:text-neg')} onClick={() => setConfirming(true)} aria-label={`Zrušit záznam — ${what}`}>
            Zrušit záznam
          </button>
        </div>
      )}
      {cancelState?.error && <p role="alert" className="m-0 text-callout text-neg">{cancelState.error}</p>}
      <FinancePanel open={open} onClose={() => setOpen(false)} title="Upravit záznam" sub={what}>
        <FinanceRecordEditForm
          record={record}
          accountingSystem={accountingSystem}
          onSaved={() => {
            setOpen(false)
            toast.show({ message: 'Změny jsou uložené.' })
          }}
        />
      </FinancePanel>
    </div>
  )
}
