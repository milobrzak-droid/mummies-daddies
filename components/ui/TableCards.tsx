import type { ReactNode } from 'react'
import { CARD } from '@/components/ui/Card'

export interface CardColumn<T> {
  header: string
  cell: (row: T) => ReactNode
  /** Na kartě (mobil) sloupec vynechat – drobnost, která je jinde v kartě. */
  hideOnCard?: boolean
}

/**
 * Kartový seznam místo tabulky pro úzký displej (< md), vzor seznam klientů
 * na mobilu: jedna karta = jeden řádek, první sloupec je nadpis karty, ostatní
 * dvojice „popisek – hodnota“ v `<dl>`, takže čtečka u hodnoty řekne, co je.
 * Sloupec s prázdným záhlavím (akce) jde pod seznam hodnot bez popisku.
 * `stretch`: karta je `relative`, aby odkaz v nadpisu (ClientsRowLink) mohl
 * roztáhnout klikací plochu na celou kartu.
 */
export function TableCards<T>({ columns, rows, rowKey, label, stretch = false, className = '' }: {
  columns: CardColumn<T>[]
  rows: T[]
  rowKey: (row: T, index: number) => string | number
  label: string
  stretch?: boolean
  className?: string
}) {
  const [first, ...rest] = columns
  const pairs = rest.filter((c) => !c.hideOnCard && c.header.trim() !== '')
  const bare = rest.filter((c) => !c.hideOnCard && c.header.trim() === '')
  return (
    <ul aria-label={label} className={`m-0 list-none space-y-3 p-0 ${className}`}>
      {rows.map((row, i) => (
        <li
          key={rowKey(row, i)}
          className={`${CARD} p-4 ${stretch ? 'relative transition-colors duration-fast hover:bg-[color:var(--c-soft)] focus-within:bg-[color:var(--c-soft)]' : ''}`}
        >
          {first && <div className="min-w-0 break-words text-headline font-semibold text-ink">{first.cell(row)}</div>}
          {pairs.length > 0 && (
            <dl className="m-0 mt-3 grid grid-cols-[minmax(0,8.5rem)_minmax(0,1fr)] items-baseline gap-x-3 gap-y-2 text-body">
              {pairs.map((c) => (
                <div key={c.header} className="contents">
                  <dt className="eyebrow break-words">{c.header}</dt>
                  <dd className="m-0 min-w-0 break-words tabular-nums text-[color:#3A424E]">{c.cell(row)}</dd>
                </div>
              ))}
            </dl>
          )}
          {bare.map((c, ci) => (
            <div key={ci} className="mt-3 flex flex-wrap items-center gap-2">{c.cell(row)}</div>
          ))}
        </li>
      ))}
    </ul>
  )
}
