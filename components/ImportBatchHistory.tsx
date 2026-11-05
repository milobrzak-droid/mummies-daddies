'use client'
import { useRouter } from 'next/navigation'
import { useState } from 'react'
import { Chip } from '@/components/Chip'
import { Button } from '@/components/ui/Button'
import { revertImportBatch } from '@/domain/crm/actions/bulkImport'
import { REVERT_REASON_LABEL } from '@/domain/crm/bulkImport'
import type { ImportBatchSummary } from '@/domain/crm/queries/importBatches'
import { formatDate } from '@/lib/format'

// Historie dávek importu s tlačítkem „Vrátit import“. Vrácení smaže jen záznamy,
// které vytvořila daná dávka, a jen tam, kde od importu nevznikla lidská práce.
// Nevratná akce, proto dvoustupňové potvrzení přímo v řádku.

const STATUS: Record<ImportBatchSummary['status'], { label: string; tone: string }> = {
  open: { label: 'Zapsáno', tone: 'pos' },
  partial: { label: 'Vráceno částečně', tone: 'warn' },
  reverted: { label: 'Vráceno', tone: 'neutral' },
}

export function ImportBatchHistory({ batches }: { batches: ImportBatchSummary[] }) {
  const router = useRouter()
  const [asking, setAsking] = useState<number | null>(null)
  const [busy, setBusy] = useState<number | null>(null)
  const [messages, setMessages] = useState<Record<number, { text: string; ok: boolean; kept?: string[] }>>({})

  async function revert(id: number) {
    setBusy(id)
    let res: Awaited<ReturnType<typeof revertImportBatch>>
    try {
      res = await revertImportBatch(id)
    } catch {
      res = { ok: false, error: 'Spojení selhalo. Zkontroluj stav dávky a zkus to znovu.' }
    }
    setBusy(null)
    setAsking(null)
    if (res.ok) {
      setMessages((m) => ({
        ...m,
        [id]: {
          ok: true, text: res.message,
          kept: [...new Set(res.result.deals_kept.map((k) => REVERT_REASON_LABEL[k.reason] ?? k.reason))],
        },
      }))
      router.refresh()
    } else {
      setMessages((m) => ({ ...m, [id]: { ok: false, text: res.error } }))
    }
  }

  return (
    <ul className="m-0 list-none divide-y divide-[color:var(--c-line-2)] p-0">
      {batches.map((b) => {
        const st = STATUS[b.status]
        const msg = messages[b.id]
        const canRevert = b.status !== 'reverted' && b.deals > 0
        return (
          <li key={b.id} className="flex flex-wrap items-start justify-between gap-x-6 gap-y-2 py-3">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <b className="text-ink">{b.kind === 'csv' ? 'Tabulka' : 'PDF nabídky'}</b>
                <Chip tone={st.tone} dot>{st.label}</Chip>
              </div>
              <div className="text-footnote text-muted">
                {formatDate(b.createdAt)}{b.createdByName ? ` · ${b.createdByName}` : ''}
                {b.label ? ` · ${b.label}` : ''}
              </div>
              <div className="text-footnote text-muted">
                Zakázek v dávce: {b.deals}{b.accountsCreated > 0 ? ` · nových klientů: ${b.accountsCreated}` : ''}
              </div>
              {msg && (
                <div role={msg.ok ? 'status' : 'alert'} className={`mt-1 text-footnote ${msg.ok ? 'text-ink' : 'text-neg'}`}>
                  {msg.text}
                  {msg.kept && msg.kept.length > 0 && <span className="block text-muted">Ponecháno, protože: {msg.kept.join('; ')}.</span>}
                </div>
              )}
            </div>
            {canRevert && (
              <div className="flex items-center gap-2">
                {asking === b.id ? (
                  <>
                    <span className="text-callout text-ink">Smaže zakázky z této dávky, kde se nic nezměnilo.</span>
                    <Button variant="danger" size="sm" disabled={busy === b.id} onClick={() => revert(b.id)}>
                      {busy === b.id ? 'Vracím…' : 'Ano, vrátit import'}
                    </Button>
                    <Button variant="quiet" size="sm" disabled={busy === b.id} onClick={() => setAsking(null)}>Ne</Button>
                  </>
                ) : (
                  <Button variant="outline" size="sm" onClick={() => setAsking(b.id)} aria-label={`Vrátit import ze dne ${formatDate(b.createdAt)}`}>
                    Vrátit import
                  </Button>
                )}
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}
