'use client'
import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import { useRouter } from 'next/navigation'
import { buttonClass } from '@/components/ui/Button'

// Tlačítko „Doplnit automaticky (dávka 40)" na /clients/doplnit-ico (jen
// admin). Výsledek dávky se ukáže hned pod ním — přiřazeno / nejednoznačné /
// nenalezeno / chyby — ať je vidět, co automat udělal, a ne jen že se
// stránka překreslila.

export type AresEnrichButtonResult = { ok: true; summary: string } | { ok: false; error: string }

function RunButton() {
  const { pending } = useFormStatus()
  return (
    <button
      type="submit"
      disabled={pending}
      aria-busy={pending}
      className={buttonClass('primary')}
    >
      {pending ? 'Ověřuji v ARESu…' : 'Doplnit automaticky (dávka 40)'}
    </button>
  )
}

export function AresEnrichButton({ action }: { action: () => Promise<AresEnrichButtonResult> }) {
  const router = useRouter()
  const [state, formAction] = useActionState<AresEnrichButtonResult | null>(async () => {
    const result = await action()
    // Seznam se obnoví až samostatným požadavkem — ne v rámci akce, která
    // má svůj časový rozpočet na dávku (viz actions.ts).
    if (result.ok) router.refresh()
    return result
  }, null)
  return (
    <div className="flex flex-col gap-2">
      <form action={formAction}>
        <RunButton />
      </form>
      <p className="text-footnote text-muted m-0 max-w-md">
        Přiřadí IČO jen při přesné shodě jména a nikdy číslo, které už má jiný klient. Ostatní zůstanou
        níž k ručnímu výběru. Doplní jen prázdné sídlo, NACE a datum vzniku.
      </p>
      {state && !state.ok && <p role="alert" className="text-neg text-sm m-0">{state.error}</p>}
      {state?.ok && <p role="status" className="text-callout text-ink m-0 rounded-btn bg-[color:var(--c-pos-soft)] px-4 py-3">{state.summary}</p>}
    </div>
  )
}
