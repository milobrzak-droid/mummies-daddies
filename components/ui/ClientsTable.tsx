import Link from 'next/link'
import type { ReactNode } from 'react'
import { CARD } from '@/components/ui/Card'
import { TableCards } from '@/components/ui/TableCards'

export interface ClientsColumn<T> {
  header: string
  cell: (row: T) => ReactNode
  align?: 'left' | 'right'
  /** Sloupec se schová pod `lg` (drobnosti, které na tabletu nejsou potřeba). */
  wide?: boolean
  /** V kartovém režimu (`mobile="cards"`) sloupec na kartě vynechat. */
  hideOnCard?: boolean
}

// Tabulka s řádkem, který je celý odkazem (docs/PROVOZ.md §11 „Klik na
// název věci otevře její detail“, plán vlny 2: „řádek celý klikací“).
// Odkaz je jen jeden – název v první buňce – a jeho ::after se roztáhne přes
// celý řádek (`tr` je `relative`). Čtečka tak slyší jeden odkaz na řádek,
// klávesnice má jednu zastávku a myš může kliknout kamkoli. V řádku proto
// nesmí být další odkazy ani tlačítka.
// Vzhled stejný jako sdílená DataTable (karta, záhlaví Fira Mono, řádek 48 px).
// `mobile="cards"`: pod `md` karty pod sebou (celá karta je odkazem), od `md` tabulka.
export function ClientsTable<T>({ columns, rows, rowKey, label, mobile = 'scroll' }: {
  columns: ClientsColumn<T>[]
  rows: T[]
  rowKey: (row: T) => string | number
  label: string
  mobile?: 'scroll' | 'cards'
}) {
  const align = (c: ClientsColumn<T>) => (c.align === 'right' ? 'text-right' : 'text-left')
  const hide = (c: ClientsColumn<T>) => (c.wide ? 'hidden lg:table-cell' : '')
  const cards = mobile === 'cards'
  const table = (
    <div role="region" aria-label={label} tabIndex={0} className={`overflow-x-auto ${CARD} ${cards ? 'hidden md:block' : ''}`}>
      <table aria-label={label} className="w-full text-body">
        <thead>
          <tr className="border-b border-border bg-[color:var(--c-soft)]">
            {columns.map((c) => (
              <th key={c.header} scope="col" className={`eyebrow px-4 py-3 font-medium whitespace-nowrap first:pl-5 last:pr-5 ${align(c)} ${hide(c)}`}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={rowKey(row)}
              className="relative cursor-pointer border-b border-[color:var(--c-line-2)] last:border-0 transition-colors duration-fast hover:bg-[color:var(--c-soft)] focus-within:bg-[color:var(--c-soft)]"
            >
              {columns.map((c, ci) =>
                ci === 0 ? (
                  <th key={c.header} scope="row" className={`h-14 px-4 py-2.5 pl-5 align-middle font-normal ${align(c)}`}>
                    {c.cell(row)}
                  </th>
                ) : (
                  <td key={c.header} className={`h-14 px-4 py-2.5 tabular-nums align-middle text-[color:#3A424E] last:pr-5 ${align(c)} ${hide(c)}`}>
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
  return (
    <div>
      <TableCards label={label} columns={columns} rows={rows} rowKey={(r) => rowKey(r)} stretch className="md:hidden" />
      {table}
    </div>
  )
}

/** Odkaz, který roztáhne klikací plochu na celý nejbližší `relative` předek (řádek, karta). */
export function ClientsRowLink({ href, children, className = '' }: { href: string; children: ReactNode; className?: string }) {
  return (
    <Link
      href={href}
      className={`text-headline text-ink no-underline after:absolute after:inset-0 after:content-[''] hover:text-ink ${className}`}
    >
      {children}
    </Link>
  )
}
