'use client'
import { useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useModal } from '@/components/ui/useModal'
import { buttonClass } from '@/components/ui/Button'

// Boční panel Financí (docs/PROVOZ.md §11 „Přímá manipulace“): přidání
// a úprava finančního záznamu bez opuštění tabulky. Plovoucí vrstva (stín 3),
// na mobilu přes celou šířku. Fokus, Esc, zámek stránky a návrat fokusu řeší
// sdílený useModal. Vykresluje se do body, ať ho neořízne rodič s overflow.
export function FinancePanel({
  open,
  onClose,
  title,
  sub,
  children,
}: {
  open: boolean
  onClose: () => void
  title: string
  sub?: ReactNode
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  const titleId = useId()
  useModal(open, ref, onClose)
  // Otevírá se až kliknutím, takže `document` už existuje (na serveru je zavřený).
  if (!open) return null
  return createPortal(
    <div className="fixed inset-0 z-[70] flex justify-end">
      <div className="fade-in absolute inset-0 bg-[rgba(23,32,46,.32)]" aria-hidden="true" onMouseDown={onClose} />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="float-in relative flex h-full w-full max-w-[480px] flex-col overflow-y-auto bg-surface shadow-e3 sm:rounded-l-card"
      >
        <div className="sticky top-0 z-10 flex items-start gap-3 border-b border-border bg-surface px-5 py-4 sm:px-6">
          <div className="min-w-0 flex-1 pt-1.5">
            <h2 id={titleId} className="m-0 font-heading text-title2 font-bold">{title}</h2>
            {sub && <p className="m-0 mt-0.5 text-callout text-muted">{sub}</p>}
          </div>
          <button type="button" onClick={onClose} aria-label="Zavřít panel" className={buttonClass('quiet', 'md', '!h-11 !w-11 !px-0')}>
            <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </button>
        </div>
        <div className="px-5 py-5 sm:px-6">{children}</div>
      </div>
    </div>,
    document.body,
  )
}
