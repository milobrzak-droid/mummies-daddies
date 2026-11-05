'use client'
import { useActionState, useEffect, useRef, useState } from 'react'
import { FormField } from '@/components/FormField'
import { SubmitButton } from '@/components/SubmitButton'
import { createApiKey } from '@/lib/actions/apiKeys'
import { buttonClass } from '@/components/ui/Button'

export function ApiKeyForm() {
  const [state, formAction] = useActionState(createApiKey, null)
  const ref = useRef<HTMLFormElement>(null)
  const [copied, setCopied] = useState(false)
  const lastPlaintext = useRef<string | undefined>(undefined)

  useEffect(() => {
    if (state?.success) { ref.current?.reset() }
  }, [state])

  // Reset the "copied" flag whenever a new key is issued, without a setState-in-effect.
  if (state?.plaintext !== lastPlaintext.current) {
    lastPlaintext.current = state?.plaintext
    if (copied) setCopied(false)
  }

  return (
    <div className="space-y-3">
      <form ref={ref} action={formAction} className="flex flex-wrap items-end gap-3">
        <FormField label="Název klíče" error={state?.fieldErrors?.name}>
          <input name="name" placeholder="Claude Code" required className="w-full sm:w-64" />
        </FormField>
        <FormField label="Rozsah">
          <select name="scope" defaultValue="full" className="w-full sm:w-72">
            <option value="full">Plný — čtení i zápis přes API a MCP</option>
            <option value="intake">Jen zápisy schůzek (Wispr Flow)</option>
          </select>
        </FormField>
        <SubmitButton>Vytvořit klíč</SubmitButton>
      </form>
      {state?.error && <p role="alert" className="m-0 text-callout text-neg">{state.error}</p>}
      {state?.success && state.plaintext && (
        <div className="max-w-xl space-y-2 rounded-tile bg-[color:var(--c-pos-soft)] p-4 text-body">
          <p className="m-0 font-semibold">
            Klíč vytvořen — zkopíruj si ho teď, znovu se už nezobrazí:
          </p>
          <code className="block break-all rounded-btn bg-surface px-3 py-2 font-mono text-callout">
            {state.plaintext}
          </code>
          <button
            type="button"
            onClick={() => { navigator.clipboard.writeText(state.plaintext!); setCopied(true) }}
            className={buttonClass('secondary', 'sm')}
          >
            {copied ? 'Zkopírováno ✓' : 'Zkopírovat'}
          </button>
          <span role="status" className="sr-only">{copied ? 'Klíč je zkopírovaný do schránky.' : ''}</span>
        </div>
      )}
    </div>
  )
}
