import type { ReactNode } from 'react'
import { buttonClass } from '@/components/ui/Button'

// Společný vzhled chybových a „nenalezeno“ obrazovek: velmi zaoblená karta,
// velký nadpis, jedna hlavní akce a cesta dál. Bez hooků a bez importu next/link, aby
// šla použít i v chybové hranici. Nadpis <h1> si dodá volající jako první dítě
// (test/page-headings hlídá, že ho nevykresluje sdílená komponenta).
export function StatusPanel({
  eyebrow, children, actions, tone = 'neutral', alert = false,
}: {
  eyebrow: string
  children?: ReactNode
  actions?: ReactNode
  tone?: 'neutral' | 'error'
  alert?: boolean
}) {
  return (
    <div
      role={alert ? 'alert' : undefined}
      className="w-full max-w-md rounded-card border border-border bg-surface p-7 shadow-card sm:p-8"
    >
      <span
        aria-hidden="true"
        className={`mb-5 inline-grid h-12 w-12 place-items-center rounded-full ${tone === 'error' ? 'bg-[color:var(--c-neg-soft)] text-neg' : 'bg-[color:var(--c-soft)] text-[color:var(--c-slate)]'}`}
      >
        {tone === 'error' ? (
          <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 8v5M12 17h.01" /><circle cx="12" cy="12" r="9" /></svg>
        ) : (
          <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
        )}
      </span>
      <p className="eyebrow mb-1.5">{eyebrow}</p>
      {children}
      {actions && <div className="mt-6 flex flex-wrap items-center gap-3">{actions}</div>}
    </div>
  )
}

/** Třídy nadpisu a textu, které volající použije uvnitř StatusPanel. */
export const STATUS_TITLE = 'm-0 font-heading text-title1 font-bold'
export const STATUS_BODY = 'mt-3 space-y-3 text-body text-muted'
export const STATUS_PRIMARY = buttonClass('primary')
export const STATUS_SECONDARY = buttonClass('outline')
