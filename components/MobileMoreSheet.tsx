'use client'
import Link from 'next/link'
import { useEffect, useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { signOut } from '@/app/login/actions'
import { buttonClass } from '@/components/ui/Button'
import { useModal } from '@/components/ui/useModal'

// Panel „Další“ spodní lišty na mobilu (< md): sekce, které se do lišty
// nevešly (Finance, Tým a nastavení), hledání a účet (Nastavení, 2FA,
// odhlášení). Vyjíždí zdola jako list (bottom sheet) nad poloprůhledným
// pozadím. Je to modální dialog: fokus se přesune dovnitř a Tab nevyleze ven,
// Esc nebo klik na pozadí zavře a fokus se vrátí na tlačítko „Další“
// (components/ui/useModal.ts). Vykresluje se do body, protože lišta má
// backdrop-filter, a ten by „fixed“ vrstvu uvnitř uzavřel do sebe.

export interface MoreSheetItem {
  href: string
  label: string
  icon: ReactNode
  active: boolean
}

const ROW = 'flex min-h-[48px] w-full items-center gap-3 rounded-btn px-3 text-[15px] no-underline text-left'
const ROW_IDLE = 'text-[color:#3A424E] hover:bg-[color:var(--c-soft)] hover:text-ink'

export function MobileMoreSheet({
  open, onClose, id, name, items, accountLinks, onSearch,
}: {
  open: boolean
  onClose: () => void
  id: string
  name: string
  /** Sekce, které nejsou ve spodní liště (podle role). */
  items: MoreSheetItem[]
  accountLinks: { href: string; label: string; active: boolean }[]
  onSearch: () => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()
  useModal(open, ref, onClose)

  // Když se okno roztáhne na počítačovou šířku, lišta zmizí – zavřít i panel,
  // ať nezůstane zamčené posouvání stránky.
  useEffect(() => {
    if (!open || typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia('(min-width: 768px)')
    const onChange = () => { if (mq.matches) onClose() }
    mq.addEventListener?.('change', onChange)
    return () => mq.removeEventListener?.('change', onChange)
  }, [open, onClose])

  // Otevírá se až kliknutím, takže `document` už existuje (na serveru je zavřený).
  if (!open) return null
  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-end md:hidden">
      <div className="fade-in absolute inset-0 bg-[rgba(23,32,46,.32)]" aria-hidden="true" onMouseDown={onClose} />
      <div
        ref={ref}
        id={id}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="float-in relative max-h-[85vh] w-full overflow-y-auto rounded-t-card bg-surface px-3 pt-2 shadow-e3 pb-[max(1rem,env(safe-area-inset-bottom))]"
      >
        <div aria-hidden="true" className="mx-auto mb-1 h-1 w-10 rounded-full bg-[color:var(--c-line)]" />
        <div className="flex items-center gap-3 px-2 pb-2">
          <div className="min-w-0 flex-1">
            <h2 id={titleId} className="m-0 font-heading text-title2 font-bold">Další</h2>
            {name && <p className="m-0 truncate text-footnote text-muted">{name}</p>}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Zavřít"
            className="inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[color:#3A424E] hover:bg-[color:var(--c-soft)] hover:text-ink"
          >
            <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </div>

        {items.length > 0 && (
          <nav aria-label="Další sekce" className="border-t border-[color:var(--c-line-2)] py-2">
            <ul className="m-0 list-none p-0">
              {items.map((item) => (
                <li key={item.href}>
                  <Link
                    href={item.href}
                    onClick={onClose}
                    aria-current={item.active ? 'page' : undefined}
                    className={`${ROW} ${item.active ? 'bg-cta-bg font-semibold text-cta-fg' : ROW_IDLE}`}
                  >
                    {item.icon}
                    <span>{item.label}</span>
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        )}

        <div className="border-t border-[color:var(--c-line-2)] py-2">
          <button type="button" onClick={onSearch} aria-haspopup="dialog" className={`${ROW} ${ROW_IDLE}`}>
            <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
            <span>Hledat</span>
          </button>
        </div>

        <nav aria-label="Účet" className="border-t border-[color:var(--c-line-2)] py-2">
          <ul className="m-0 list-none p-0">
            {accountLinks.map((l) => (
              <li key={l.href}>
                <Link
                  href={l.href}
                  onClick={onClose}
                  aria-current={l.active ? 'page' : undefined}
                  className={`${ROW} ${l.active ? 'bg-[color:var(--c-soft)] font-semibold text-ink' : ROW_IDLE}`}
                >
                  {l.label}
                </Link>
              </li>
            ))}
          </ul>
          <form action={signOut} className="mt-2 px-1">
            <button type="submit" className={buttonClass('secondary', 'md', 'min-h-[48px] w-full text-[15px]')}>Odhlásit</button>
          </form>
        </nav>
      </div>
    </div>,
    document.body,
  )
}
