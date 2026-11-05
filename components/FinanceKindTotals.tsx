// Součet jednoho druhu peněz po měnách (potvrzeno + návrhy zvlášť).
// Nikdy nezobrazuje součet přes druhy — každý druh má vlastní blok.
import {
  CURRENCIES,
  FINANCIAL_KINDS,
  FINANCIAL_KIND_LABEL,
  formatMoney,
  type FinancialKind,
  type KindTotals,
} from '@/domain/finance/records'

export function KindAmounts<K extends FinancialKind>({ totals, showDrafts = true }: { totals: KindTotals<K>; showDrafts?: boolean }) {
  const rows = CURRENCIES.flatMap((c) => {
    const v = totals.byCurrency[c]
    return v && (v.confirmed > 0 || (showDrafts && v.draft > 0)) ? [{ c, v }] : []
  })
  if (rows.length === 0) return <span className="text-muted">—</span>
  return (
    <span className="flex flex-col gap-0.5 tabular-nums">
      {rows.map(({ c, v }) => (
        <span key={c}>
          <span className="text-ink font-medium">{formatMoney(v.confirmed, c)}</span>
          {showDrafts && v.draft > 0 && (
            <span className="text-footnote text-muted"> + návrh {formatMoney(v.draft, c)}</span>
          )}
        </span>
      ))}
    </span>
  )
}

/** Kompaktní souhrn firmy: čtyři oddělené druhy, žádné „celkem". */
export function FinanceKindSummary({ summary }: { summary: { readonly [K in FinancialKind]: KindTotals<K> } }) {
  return (
    <dl className="grid grid-cols-2 lg:grid-cols-4 gap-3 m-0">
      {FINANCIAL_KINDS.map((k) => (
        <div key={k} className="rounded-tile border border-border bg-surface px-4 py-3">
          <dt className="eyebrow">{FINANCIAL_KIND_LABEL[k]}</dt>
          <dd className="m-0 mt-1 text-body">
            <KindAmounts totals={summary[k]} />
          </dd>
        </div>
      ))}
    </dl>
  )
}
