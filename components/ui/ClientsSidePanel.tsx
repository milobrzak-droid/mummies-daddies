'use client'
import Link from 'next/link'
import { useCallback, useId, useRef, type ReactNode } from 'react'
import { useRouter } from 'next/navigation'
import { useModal } from '@/components/ui/useModal'

// Boční panel pro úpravu na místě (docs/PROVOZ.md §11 „Přímá
// manipulace a úpravy na místě“, plán vlny 2 „Úprava kontaktu a firmy na
// místě“). Otevřenost řídí URL (?upravit=firma, ?kontakt=12): panel vykreslí
// server, odkaz na něj jde sdílet, zpět v prohlížeči ho zavře a po uložení,
// které přesměruje na čistou adresu detailu, zmizí sám.
// Modální chování (fokus dovnitř, Tab v kruhu, Esc, zámek stránky, návrat
// fokusu) je sdílené přes useModal. Na mobilu panel zabere celou šířku.
export function ClientsSidePanel({ title, description, closeHref, children }: {
  title: string
  description?: ReactNode
  /** Kam se panel zavře (stejná stránka bez parametru panelu). */
  closeHref: string
  children: ReactNode
}) {
  const router = useRouter()
  const ref = useRef<HTMLDivElement>(null)
  const headingId = useId()
  const close = useCallback(() => router.replace(closeHref, { scroll: false }), [router, closeHref])
  useModal(true, ref, close)

  return (
    <div className="fixed inset-0 z-[70] flex justify-end">
      <div className="fade-in absolute inset-0 bg-[rgba(23,32,46,.38)]" aria-hidden="true" onMouseDown={close} />
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={headingId}
        className="float-in relative flex h-full w-full max-w-[600px] flex-col bg-surface shadow-e3 sm:rounded-l-card"
      >
        <div className="flex items-start gap-3 border-b border-border px-5 py-4 sm:px-6">
          <div className="min-w-0 flex-1">
            <h2 id={headingId} className="m-0 font-heading text-title2 font-bold">{title}</h2>
            {description && <p className="m-0 mt-1 text-callout text-muted">{description}</p>}
          </div>
          <Link
            href={closeHref}
            scroll={false}
            replace
            aria-label="Zavřít panel"
            className="-mr-2 inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-[color:var(--c-slate)] no-underline hover:bg-[color:var(--c-soft)] hover:text-ink"
          >
            <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M6 6l12 12M18 6 6 18" /></svg>
          </Link>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5 sm:px-6">{children}</div>
      </div>
    </div>
  )
}
