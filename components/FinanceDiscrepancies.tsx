'use client'
// „Rozdíly k vyřešení" z iDokladu (0092) na stránce Finance: co denní čtení
// nedokázalo zapsat jednoznačně nebo v čem se Cockpit a iDoklad liší. Každý
// rozdíl říká česky, co je jinak, a nabízí jen akce, které dávají smysl:
// převzít z iDokladu, založit záznam z faktury, zrušit záznam, nebo označit
// jako vyřešené. Do iDokladu se nikdy nic nezapisuje.
import Link from 'next/link'
import { useActionState, useState } from 'react'
import { useFormStatus } from 'react-dom'
import { FormField } from '@/components/FormField'
import { buttonClass } from '@/components/ui/Button'
import { Card } from '@/components/ui/Card'
import { useUndoToast } from '@/components/ui/Toast'
import { applyDiscrepancy, cancelRecordOfDiscrepancy, dismissDiscrepancy } from '@/domain/finance/actions/idoklad'
import { DISCREPANCY_KIND_LABEL } from '@/domain/finance/idoklad'
import type { DiscrepancyRow } from '@/domain/finance/queries/idoklad'
import type { ActionResult } from '@/lib/actionResult'
import { formatMoney, type Currency } from '@/domain/finance/records'

type AccountOption = { id: number; name: string }

function money(amount: number | null, currency: string | null): string {
  if (amount === null) return '—'
  return currency === 'CZK' || currency === 'EUR' ? formatMoney(Number(amount), currency as Currency) : `${amount} ${currency ?? ''}`.trim()
}

const dateLabel = (iso: string) =>
  new Intl.DateTimeFormat('cs-CZ', { day: 'numeric', month: 'numeric', year: 'numeric', timeZone: 'Europe/Prague' }).format(new Date(iso))

function ActionButton({ label, pendingLabel, variant = 'outline' }: { label: string; pendingLabel: string; variant?: 'primary' | 'outline' | 'danger' | 'quiet' }) {
  const { pending } = useFormStatus()
  return (
    <button type="submit" disabled={pending} aria-busy={pending} className={buttonClass(variant, 'sm')}>
      {pending ? pendingLabel : label}
    </button>
  )
}

function DiscrepancyActions({ row, accounts }: { row: DiscrepancyRow; accounts: AccountOption[] }) {
  const toast = useUndoToast()
  const [confirmingCancel, setConfirmingCancel] = useState(false)
  const done = (message: string) => (res: ActionResult) => {
    if (res.success) toast.show({ message })
    return res
  }
  const [applyState, applyAction] = useActionState(
    async (prev: ActionResult | null, fd: FormData) => done('Převzato z iDokladu, rozdíl je vyřešený.')(await applyDiscrepancy(row.id, prev, fd)), null)
  const [dismissState, dismissAction] = useActionState(
    async (prev: ActionResult | null, fd: FormData) => done('Rozdíl je označený jako vyřešený.')(await dismissDiscrepancy(row.id, prev, fd)), null)
  const [cancelState, cancelAction] = useActionState(
    async () => done('Záznam je zrušený a rozdíl vyřešený.')(await cancelRecordOfDiscrepancy(row.id)), null)

  const canApplyAmount = row.kind === 'amount_mismatch' && row.record_id !== null && row.idoklad_id !== null
  const canCreate = row.kind === 'invoice_without_record' && row.record_id === null && row.idoklad_id !== null
  const canCancel = row.kind === 'record_without_invoice' && row.record_id !== null
  const label = `${DISCREPANCY_KIND_LABEL[row.kind]} ${row.document_number ?? ''}`.trim()
  const error = applyState?.error ?? dismissState?.error ?? cancelState?.error

  return (
    <div className="mt-3 flex flex-col gap-3">
      <div className="flex flex-wrap items-end gap-2">
        {canApplyAmount && (
          <form action={applyAction} aria-label={`Převzít z iDokladu: ${label}`}>
            <ActionButton label="Převzít z iDokladu" pendingLabel="Přebírám…" variant="primary" />
          </form>
        )}
        {canCreate && (
          <form action={applyAction} aria-label={`Založit záznam z faktury: ${label}`} className="flex flex-wrap items-end gap-2">
            <div className="w-56">
              <FormField label="Firma, které faktura patří" error={applyState?.fieldErrors?.account_id}>
                <select name="account_id" required defaultValue={row.account_id ?? ''} className="w-full">
                  <option value="" disabled>Vyber firmu…</option>
                  {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
                </select>
              </FormField>
            </div>
            <ActionButton label="Založit záznam z faktury" pendingLabel="Zakládám…" variant="primary" />
          </form>
        )}
        {canCancel && (confirmingCancel ? (
          <form action={cancelAction} className="flex flex-wrap items-center gap-2" aria-label={`Zrušit záznam: ${label}`}>
            <span className="text-footnote text-muted">Zrušení nejde vrátit.</span>
            <ActionButton label="Ano, zrušit záznam" pendingLabel="Ruším…" variant="danger" />
            <button type="button" className={buttonClass('quiet', 'sm')} onClick={() => setConfirmingCancel(false)}>Nechat</button>
          </form>
        ) : (
          <button type="button" className={buttonClass('outline', 'sm')} onClick={() => setConfirmingCancel(true)} aria-label={`Zrušit záznam — ${label}`}>
            Zrušit záznam
          </button>
        ))}
        {row.account_id !== null && (
          <Link href={`/cockpit/clients/${row.account_id}`} className={buttonClass('quiet', 'sm')}>Otevřít firmu</Link>
        )}
      </div>
      <form action={dismissAction} className="flex flex-wrap items-end gap-2" aria-label={`Označit jako vyřešené: ${label}`}>
        <div className="w-64 max-w-full">
          <FormField label="Poznámka (nepovinná)">
            <input name="note" maxLength={500} placeholder="např. domluveno s klientem" className="w-full" />
          </FormField>
        </div>
        <ActionButton label="Označit jako vyřešené" pendingLabel="Ukládám…" variant="outline" />
      </form>
      {error && <p role="alert" className="m-0 text-callout text-neg">{error}</p>}
    </div>
  )
}

export function FinanceDiscrepancies({ rows, total, accounts }: { rows: DiscrepancyRow[]; total: number; accounts: AccountOption[] }) {
  return (
    <Card
      id="rozdily"
      title="Rozdíly k vyřešení"
      sub="Co se z iDokladu nepodařilo zapsat jednoznačně, nebo v čem se Cockpit a iDoklad liší. Nic se do iDokladu nezapisuje."
      badge={<span className="st fail"><span className="sr-only">Otevřených: </span>{total}</span>}
    >
      <ul className="m-0 list-none divide-y divide-[color:var(--c-line-2)] p-0">
        {rows.map((r) => (
          <li key={r.id} className="py-4 first:pt-0 last:pb-0">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <b className="text-headline">{DISCREPANCY_KIND_LABEL[r.kind]}</b>
              <span className="text-callout font-semibold text-ink">{r.document_number ?? (r.record_id ? `záznam č. ${r.record_id}` : '')}</span>
              {r.account_name && <span className="text-callout text-muted">{r.account_name}</span>}
            </div>
            <p className="m-0 mt-1 text-callout text-[color:#3A424E]">{r.reason}</p>
            {(r.idoklad_amount !== null || r.record_amount !== null) && (
              <p className="m-0 mt-1 flex flex-wrap gap-x-4 text-callout tabular-nums text-muted">
                <span>iDoklad: <b className="text-ink">{money(r.idoklad_amount, r.currency)}</b></span>
                <span>Cockpit: <b className="text-ink">{money(r.record_amount, r.currency)}</b></span>
              </p>
            )}
            <p className="m-0 mt-1 text-footnote text-muted">Nalezeno {dateLabel(r.first_seen_at)}</p>
            <DiscrepancyActions row={r} accounts={accounts} />
          </li>
        ))}
      </ul>
      {total > rows.length && (
        <p className="m-0 mt-4 text-callout text-muted">Zobrazeno {rows.length} nejstarších z {total}. Po vyřešení se načtou další.</p>
      )}
    </Card>
  )
}
