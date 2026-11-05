import type { ReactNode } from 'react'
import type { HandoffKey } from '@/domain/delivery/milestone'

// Kontrolní seznam předání jako tmavě tyrkysová karta s vnořenými pilulkami:
// hotové položky zeleně, chybějící bíle (pozor), kdo a kdy předal nahoře.
// Sdílí ho přehled dodávky i záložka Předání.

export type HandoffChecklistItem = { key: HandoffKey; label: string; ok: boolean; hint: string }

export function HandoffChecklistCard({
  items, completedLabel, footer, action, showHints = false,
}: {
  items: HandoffChecklistItem[]
  /** „Předáno do realizace 2026-09-01 · Viktor" — jen když už předáno. */
  completedLabel?: string | null
  /** Odkaz / tlačítko pod seznamem. */
  action?: ReactNode
  footer?: ReactNode
  /** U chybějících položek ukázat, kde je doplnit. */
  showHints?: boolean
}) {
  const done = items.filter((i) => i.ok).length
  const total = items.length
  return (
    <section className="card-deep p-5 flex flex-col gap-3" aria-label="Předání do realizace">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 className="font-heading text-title2 font-bold m-0 mr-auto !text-white">Předání</h2>
        <span className="rounded-full px-3 py-1 text-xs font-bold bg-white/15 text-white">{done} z {total} hotovo</span>
      </div>
      <p className="text-[13px] text-white/85 m-0">
        {completedLabel ?? (done === total ? 'Balíček je úplný, dodávku lze předat do realizace.' : `Chybí ${total - done} z ${total} položek balíčku.`)}
      </p>
      <ul className="list-none p-0 m-0 flex flex-col gap-1.5">
        {items.map((i) => (
          <li key={i.key} className={`in-pill ${i.ok ? 'g' : 'w'} !py-2 items-center`}>
            <span className="flex items-center gap-2 min-w-0">
              {i.ok && (
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M5 12.5l4.5 4.5L19 7.5" />
                </svg>
              )}
              <span>
                {i.label}
                {!i.ok && showHints && <span className="block text-xs font-normal text-[color:#39414D]">{i.hint}</span>}
              </span>
            </span>
            <span className="text-[12.5px] font-semibold whitespace-nowrap text-right">
              {i.ok ? 'vyplněno' : 'chybí'}
              <span className="sr-only">{i.ok ? '' : `. ${i.hint}`}</span>
            </span>
          </li>
        ))}
      </ul>
      {footer}
      {action}
    </section>
  )
}
