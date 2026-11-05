import { ReactNode } from 'react'
import { CARD } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { TableCards } from '@/components/ui/TableCards'

export interface Column<T> {
  header: string
  cell: (row: T) => ReactNode
  /** Čísla a částky zarovnej vpravo (`tabular-nums` je na všech buňkách). */
  align?: 'left' | 'right'
  /** V kartovém režimu (`mobile="cards"`) sloupec na kartě vynechat. */
  hideOnCard?: boolean
}

/**
 * Tabulka se sémantikou pro čtečky obrazovky:
 * - `label` je povinný, pojmenuje tabulku (`aria-label`) i posuvný obal,
 *   aby šel obal na úzkém displeji posouvat i klávesnicí (tabIndex=0);
 * - záhlaví sloupců mají `scope="col"`, první buňka řádku je `th scope="row"`,
 *   takže čtečka u každé hodnoty řekne, ke kterému záznamu patří.
 * Vzhled (docs/PROVOZ.md §5): karta, záhlaví sloupců Fira Mono na jemné
 * výplni, řádek aspoň 48 px, najetí zvýrazní celý řádek. Prázdná tabulka ukáže
 * prázdný stav (s akcí, pokud ji volající dá), ne prázdnou mřížku.
 * `mobile="cards"`: pod `md` místo tabulky kartový seznam (TableCards) –
 * první sloupec je nadpis karty, ostatní dvojice popisek–hodnota. Tabulka
 * zůstává od `md` výš. Výchozí `scroll` = tabulka se na úzkém displeji posouvá.
 */
export function DataTable<T>({ columns, rows, empty = 'Žádná data.', emptyHint, emptyAction, label, mobile = 'scroll' }:
  {
    columns: Column<T>[]
    rows: T[]
    empty?: string
    /** Jedna věta pod prázdným stavem: co se tu objeví. */
    emptyHint?: string
    /** Cesta dál z prázdného stavu, např. { href: '/cockpit/clients/new', label: 'Založit klienta' }. */
    emptyAction?: { href: string; label: string }
    label: string
    /** Jak tabulku ukázat pod `md`: posuvná tabulka, nebo karty pod sebou. */
    mobile?: 'scroll' | 'cards'
  }) {
  if (rows.length === 0) {
    return (
      <div className={CARD}>
        <EmptyState title={empty} action={emptyAction} compact>{emptyHint}</EmptyState>
      </div>
    )
  }
  const align = (c: Column<T>) => (c.align === 'right' ? 'text-right' : 'text-left')
  const cards = mobile === 'cards'
  const table = (
    <div
      role="region"
      aria-label={label}
      tabIndex={0}
      className={`overflow-x-auto ${CARD} ${cards ? 'hidden md:block' : ''}`}
    >
      <table aria-label={label} className="w-full text-body">
        <thead>
          <tr className="border-b border-border bg-[color:var(--c-soft)]">
            {columns.map((c) => (
              <th
                key={c.header}
                scope="col"
                className={`eyebrow px-4 py-3 font-medium whitespace-nowrap first:pl-5 last:pr-5 ${align(c)}`}
              >
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i} className="border-b border-[color:var(--c-line-2)] last:border-0 transition-colors duration-fast hover:bg-[color:var(--c-soft)]">
              {columns.map((c, ci) =>
                ci === 0 ? (
                  <th key={c.header} scope="row" className={`h-12 px-4 py-2.5 pl-5 tabular-nums align-middle font-semibold text-ink ${align(c)}`}>
                    {c.cell(row)}
                  </th>
                ) : (
                  <td key={c.header} className={`h-12 px-4 py-2.5 tabular-nums align-middle text-[color:#3A424E] last:pr-5 ${align(c)}`}>
                    {c.cell(row)}
                  </td>
                ),
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
  if (!cards) return table
  // Jeden obal, ať rodič se `space-y-*` nedá skryté sestře okraj navíc.
  return (
    <div>
      <TableCards label={label} columns={columns} rows={rows} rowKey={(_, i) => i} className="md:hidden" />
      {table}
    </div>
  )
}
