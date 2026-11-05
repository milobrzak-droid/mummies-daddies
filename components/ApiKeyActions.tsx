'use client'
import { useActionState, useState } from 'react'
import { SubmitButton } from '@/components/SubmitButton'
import { buttonClass } from '@/components/ui/Button'
import { revokeApiKey } from '@/lib/actions/apiKeys'

// Zrušení klíče je nevratné (nástroj, který ho používá, přestane fungovat),
// proto se nejdřív potvrzuje a potvrzení říká, co přesně se stane.
export function ApiKeyActions({ id, revoked, name }: { id: number; revoked: boolean; name?: string }) {
  const [state, formAction] = useActionState(revokeApiKey.bind(null, id), null)
  const [confirming, setConfirming] = useState(false)
  // Zrušený klíč už nejde vrátit; stav ukazuje pilulka „Zrušen“ na stránce.
  if (revoked) return null
  const label = name ? `Zrušit klíč ${name}` : 'Zrušit klíč'
  return (
    <div className="flex flex-col items-start gap-2">
      {confirming ? (
        <form action={formAction} className="flex flex-wrap items-center gap-2 rounded-tile bg-[color:var(--c-neg-soft)] p-3">
          <span className="min-w-0 basis-56 flex-1 text-callout text-ink">
            Nástroj s tímhle klíčem přestane fungovat hned. Vrátit to nejde, jen vytvořit nový klíč.
          </span>
          <SubmitButton variant="danger" size="sm" pendingLabel="Ruším…" aria-label={`Ano, zrušit — ${label}`}>Ano, zrušit</SubmitButton>
          <button type="button" className={buttonClass('quiet', 'sm')} onClick={() => setConfirming(false)}>Nechat</button>
        </form>
      ) : (
        <button type="button" className={buttonClass('danger', 'sm')} aria-label={label} onClick={() => setConfirming(true)}>
          Zrušit
        </button>
      )}
      {state?.error && <p role="alert" className="m-0 text-callout text-neg">{state.error}</p>}
    </div>
  )
}
