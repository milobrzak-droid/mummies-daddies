import type { ReactNode } from 'react'
import { COMPANY } from '@/config'

const BRAND_LOGO = COMPANY.brand?.logo ?? '/logo.svg'
const BRAND_ALT = COMPANY.brand?.logoAlt ?? COMPANY.name

// Rámec přihlašovacích a MFA stránek (mimo přihlášenou aplikaci): logo nad
// velmi zaoblenou bílou kartou uprostřed světlého pozadí. Bez hooků, takže ho
// jde použít z serverových i klientských stránek. `as="form"` pro přihlášení.
// `wide`: širší sloupec pro delší obsah (schválení přístupu aplikace).
export function AuthShell({ children, wide = false }: { children: ReactNode; wide?: boolean }) {
  return (
    <main className="grid min-h-screen place-items-center px-4 py-10">
      <div className={`w-full ${wide ? 'max-w-md' : 'max-w-sm'}`}>
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={BRAND_LOGO} alt={BRAND_ALT} className="mx-auto mb-6 h-[26px] w-auto" />
        {children}
      </div>
    </main>
  )
}

export const AUTH_CARD = 'w-full rounded-card border border-border bg-surface p-7 shadow-card sm:p-8'

/** Kulatý číslovaný krok (návod k nastavení 2FA). */
export function AuthStep({ n, children }: { n: number; children: ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <span aria-hidden="true" className="inline-grid h-7 w-7 shrink-0 place-items-center rounded-full bg-[color:var(--c-navy)] text-footnote font-bold text-white">{n}</span>
      <div className="min-w-0 flex-1 pt-1 text-body text-muted">{children}</div>
    </div>
  )
}
