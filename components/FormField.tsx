import { ReactNode } from 'react'

// Formulářové pole (docs/PROVOZ.md §2, §9): popisek je vždy vidět nad
// polem (nikdy jen placeholder), pod polem nápověda a chyba.
// `hint` je pro pole, kde popisek sám nestačí — třeba kvalitativní brány
// dodávky, kde „účastníci hlavně pracovali" bez vysvětlení nikomu nic neřekne.
// `checkbox`: zaškrtávací pole — políčko a popisek vedle sebe v jedné řadě
// (bez něj je popisek nad polem jako u textových vstupů).
// Vzhled vstupu (výška 40 px, rámeček ≥ 3 : 1, fokus) je globální v globals.css.
export function FormField({
  label, error, hint, children, checkbox = false,
}: { label: string; error?: string; hint?: string; children: ReactNode; checkbox?: boolean }) {
  return (
    <div className="space-y-1.5">
      {checkbox ? (
        <label className="flex min-h-[44px] items-center gap-2.5 py-1 text-body font-semibold text-ink md:min-h-0 [&_input]:h-[18px] [&_input]:w-[18px] [&_input]:shrink-0 [&_input]:accent-[color:var(--c-navy)]">
          {children}
          <span>{label}</span>
        </label>
      ) : (
        <label className="block space-y-1.5 text-callout font-semibold text-[color:#39414D] [&_input:not([type=checkbox]):not([type=radio])]:font-normal [&_input:not([type=checkbox]):not([type=radio])]:text-body [&_select]:font-normal [&_select]:text-body [&_textarea]:font-normal [&_textarea]:text-body">
          <span className="block">{label}</span>
          {children}
        </label>
      )}
      {hint && <span className="block text-footnote text-muted">{hint}</span>}
      {error && (
        <span role="alert" className="flex items-start gap-1.5 text-callout text-neg">
          <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="mt-px shrink-0"><circle cx="12" cy="12" r="9" /><path d="M12 8v5M12 16h.01" /></svg>
          {error}
        </span>
      )}
    </div>
  )
}
