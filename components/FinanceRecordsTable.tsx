// Tabulka finančních záznamů (docs/PROVOZ.md §13 Finance): částky
// vpravo s tabular-nums, v patičce součet. Součet je vždy po druhu a měně –
// přes druhy se nesčítá nikdy (potenciál + přijato není žádný obrat), proto má
// patička při „Vše“ jeden řádek za každý druh. Zrušené záznamy se nepočítají.
// Vzhled drží sdílenou tabulku (DataTable): karta, záhlaví Fira Mono, řádek 48 px.
import Link from 'next/link'
import type { ReactNode } from 'react'
import { CARD } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { formatDate } from '@/lib/format'
import { KindBadge, StatusPill } from '@/components/FinanceCards'
import { FinanceRecordActions } from '@/components/FinanceRecordForms'
import {
  CURRENCIES,
  effectiveDueOn,
  FINANCIAL_KINDS,
  FINANCIAL_KIND_LABEL,
  FINANCIAL_SOURCE_LABEL,
  FINANCIAL_STATUS_LABEL,
  formatMoney,
  monthLabel,
  monthOf,
  summarizeByKind,
  type FinancialKind,
  type FinancialRecordRow,
  type KindTotals,
} from '@/domain/finance/records'

type Row = FinancialRecordRow & { account_name: string | null }

const TH = 'eyebrow whitespace-nowrap px-4 py-3 font-medium first:pl-5 last:pr-5'
const TD = 'h-12 px-4 py-2.5 align-middle tabular-nums text-[color:#3A424E] last:pr-5'

/** Součet jednoho druhu po měnách: „360 000 Kč“, u návrhů „+ návrh 1 000 Kč“. */
function KindSum<K extends FinancialKind>({ totals, showDrafts }: { totals: KindTotals<K>; showDrafts: boolean }) {
  const parts = CURRENCIES.flatMap((c) => {
    const v = totals.byCurrency[c]
    return v && (v.confirmed > 0 || (showDrafts && v.draft > 0)) ? [{ c, v }] : []
  })
  if (parts.length === 0) return <span className="text-muted">—</span>
  return (
    <span className="flex flex-col items-end gap-0.5">
      {parts.map(({ c, v }) => (
        <span key={c} className="whitespace-nowrap">
          <b className="font-bold text-ink">{formatMoney(v.confirmed, c)}</b>
          {showDrafts && v.draft > 0 && <span className="text-footnote text-muted"> + návrh {formatMoney(v.draft, c)}</span>}
        </span>
      ))}
    </span>
  )
}

export function FinanceRecordsTable({
  rows,
  kind,
  showDrafts,
  accountingSystem,
  toolbar,
  emptyAction,
  overdue,
}: {
  rows: Row[]
  kind: FinancialKind | null
  showDrafts: boolean
  accountingSystem: string
  /** Přepínač druhu nad tabulkou. */
  toolbar?: ReactNode
  emptyAction?: { href: string; label: string }
  /** Nezaplacené faktury po splatnosti: id záznamu → dny po splatnosti (0090). */
  overdue?: ReadonlyMap<number, number>
}) {
  if (rows.length === 0) {
    return (
      <div className={CARD}>
        {toolbar && <div className="border-b border-[color:var(--c-line-2)] px-4 py-3">{toolbar}</div>}
        <EmptyState title="V tomto období žádné finanční záznamy." action={emptyAction} compact>
          Změň období ve filtru nebo přidej první záznam.
        </EmptyState>
      </div>
    )
  }
  const sums = summarizeByKind(rows)
  const kinds = kind ? [kind] : FINANCIAL_KINDS.filter((k) => CURRENCIES.some((c) => sums[k].byCurrency[c]))
  return (
    <div className={`${CARD} overflow-hidden`}>
      {toolbar && <div className="border-b border-[color:var(--c-line-2)] px-4 py-3">{toolbar}</div>}
      {/* Mobil (< md): záznamy jako řádky-karty pod sebou uvnitř jedné karty
          (žádná karta v kartě), součty pod nimi. Od md tabulka. */}
      <ul aria-label="Finanční záznamy" className="m-0 list-none p-0 md:hidden">
        {rows.map((r) => (
          <li key={r.id} className={`border-b border-[color:var(--c-line-2)] px-4 py-4 ${r.status === 'cancelled' ? 'text-muted' : ''}`}>
            <div className="flex items-start gap-3">
              <div className="min-w-0 flex-1">
                <Link href={`/cockpit/clients/${r.account_id}`} className="block break-words text-headline font-semibold text-ink">{r.account_name ?? `#${r.account_id}`}</Link>
                {r.note && <span className="block break-words text-footnote text-muted">{r.note}</span>}
              </div>
              <span className={`shrink-0 whitespace-nowrap text-right text-headline font-bold tabular-nums text-ink ${r.status === 'cancelled' ? 'line-through decoration-[color:var(--c-slate-2)]' : ''}`}>
                {formatMoney(Number(r.amount), r.currency)}
              </span>
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2">
              <KindBadge kind={r.kind} />
              <StatusPill status={r.status} label={FINANCIAL_STATUS_LABEL[r.status]} />
            </div>
            <dl className="m-0 mt-3 grid grid-cols-[minmax(0,7rem)_minmax(0,1fr)] items-baseline gap-x-3 gap-y-1.5 text-body">
              <dt className="eyebrow">Měsíc</dt>
              <dd className="m-0 text-[color:#3A424E]">{monthLabel(monthOf(r.period_month))}</dd>
              <dt className="eyebrow">Doklad</dt>
              <dd className="m-0 min-w-0 break-words text-[color:#3A424E]">
                {r.external_ref ?? '—'}
                <span className="text-footnote text-muted"> · {FINANCIAL_SOURCE_LABEL[r.source] ?? r.source}</span>
              </dd>
              {r.kind === 'invoiced' && effectiveDueOn(r) && (
                <>
                  <dt className="eyebrow">Splatnost</dt>
                  <dd className="m-0 tabular-nums text-[color:#3A424E]">
                    {overdue?.has(r.id) ? (
                      <span className="font-semibold text-neg">
                        {formatDate(effectiveDueOn(r))}
                        <span className="block text-footnote font-normal">po splatnosti o {overdue.get(r.id)} d</span>
                      </span>
                    ) : (
                      formatDate(effectiveDueOn(r))
                    )}
                  </dd>
                </>
              )}
            </dl>
            <div className="mt-3 [&>div]:items-start [&>div>div]:justify-start [&>div>form]:justify-start">
              <FinanceRecordActions record={r} accountingSystem={accountingSystem} />
            </div>
          </li>
        ))}
      </ul>
      <div className="bg-[color:var(--c-soft)] px-4 py-3 md:hidden">
        <dl aria-label="Součty" className="m-0">
          {kinds.map((k) => (
            <div key={k} className="flex items-start justify-between gap-3 py-1 tabular-nums">
              <dt className="eyebrow pt-0.5">Součet · {FINANCIAL_KIND_LABEL[k]}</dt>
              <dd className="m-0 text-right"><KindSum totals={sums[k]} showDrafts={showDrafts} /></dd>
            </div>
          ))}
        </dl>
        <p className="m-0 mt-1 text-footnote text-muted">Bez zrušených, každý druh zvlášť.</p>
      </div>
      <div role="region" aria-label="Finanční záznamy" tabIndex={0} className="hidden overflow-x-auto md:block">
        <table aria-label="Finanční záznamy" className="w-full text-body">
          <thead>
            <tr className="border-b border-border bg-[color:var(--c-soft)]">
              <th scope="col" className={`${TH} text-left`}>Firma</th>
              <th scope="col" className={`${TH} text-left`}>Druh</th>
              <th scope="col" className={`${TH} text-left`}>Měsíc</th>
              <th scope="col" className={`${TH} text-left`}>Stav</th>
              <th scope="col" className={`${TH} text-left`}>Doklad</th>
              <th scope="col" className={`${TH} text-left`}>Splatnost</th>
              <th scope="col" className={`${TH} text-right`}>Částka</th>
              <th scope="col" className={`${TH} text-right`}><span className="sr-only">Akce</span></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr
                key={r.id}
                className={`border-b border-[color:var(--c-line-2)] transition-colors duration-fast hover:bg-[color:var(--c-soft)] ${r.status === 'cancelled' ? 'text-muted' : ''}`}
              >
                <th scope="row" className="h-12 max-w-[260px] px-4 py-2.5 pl-5 text-left align-middle font-semibold text-ink">
                  <Link href={`/cockpit/clients/${r.account_id}`} className="block truncate">{r.account_name ?? `#${r.account_id}`}</Link>
                  {r.note && <span className="block truncate text-footnote font-normal text-muted" title={r.note}>{r.note}</span>}
                </th>
                <td className={TD}><KindBadge kind={r.kind} /></td>
                <td className={`${TD} whitespace-nowrap`}>{monthLabel(monthOf(r.period_month))}</td>
                <td className={TD}><StatusPill status={r.status} label={FINANCIAL_STATUS_LABEL[r.status]} /></td>
                <td className={TD}>
                  {r.external_ref ?? '—'}
                  <span className="block text-footnote text-muted">
                    {FINANCIAL_SOURCE_LABEL[r.source] ?? r.source}
                  </span>
                </td>
                <td className={`${TD} whitespace-nowrap`}>
                  {r.kind === 'invoiced' && effectiveDueOn(r) ? (
                    overdue?.has(r.id) ? (
                      <span className="font-semibold text-neg">
                        {formatDate(effectiveDueOn(r))}
                        <span className="block text-footnote font-normal">po splatnosti o {overdue.get(r.id)} d</span>
                      </span>
                    ) : (
                      formatDate(effectiveDueOn(r))
                    )
                  ) : (
                    <span className="text-muted">—</span>
                  )}
                </td>
                <td className={`${TD} whitespace-nowrap text-right font-bold text-ink ${r.status === 'cancelled' ? 'line-through decoration-[color:var(--c-slate-2)]' : ''}`}>
                  {formatMoney(Number(r.amount), r.currency)}
                </td>
                <td className={`${TD} text-right`}>
                  <FinanceRecordActions record={r} accountingSystem={accountingSystem} />
                </td>
              </tr>
            ))}
          </tbody>
          <tfoot className="bg-[color:var(--c-soft)]">
            {kinds.map((k, i) => (
              <tr key={k} className={i === 0 ? 'border-t border-border' : ''}>
                <th scope="row" colSpan={6} className="px-4 py-2.5 pl-5 text-left align-top">
                  <span className="eyebrow">Součet · {FINANCIAL_KIND_LABEL[k]}</span>
                  {i === 0 && <span className="ml-2 hidden text-footnote font-normal text-muted sm:inline">bez zrušených, každý druh zvlášť</span>}
                </th>
                <td className="px-4 py-2.5 text-right align-top tabular-nums">
                  <KindSum totals={sums[k]} showDrafts={showDrafts} />
                </td>
                <td aria-hidden="true" />
              </tr>
            ))}
          </tfoot>
        </table>
      </div>
    </div>
  )
}
