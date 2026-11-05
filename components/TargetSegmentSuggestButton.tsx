'use client'
import { useActionState } from 'react'
import { SubmitButton } from '@/components/SubmitButton'
import { suggestTargetListItems } from '@/domain/crm/actions/targetLists'
import type { SuggestResult } from '@/domain/crm/targetSegments'

// „Navrhnout firmy podle segmentu" na detailu cílového seznamu. Výsledek
// (kolik přibylo, kolik zbývá nad limit) se ukáže pod tlačítkem — bez něj
// by po kliknutí nebylo poznat, jestli se něco stalo.
export function TargetSegmentSuggestButton({ listId }: { listId: number }) {
  const [state, formAction] = useActionState<SuggestResult | null>(async () => suggestTargetListItems(listId), null)
  return (
    <div className="space-y-2">
      <form action={formAction}>
        <SubmitButton variant="soft">Navrhnout firmy podle segmentu</SubmitButton>
      </form>
      {state?.error && <p role="alert" className="m-0 text-callout text-neg">{state.error}</p>}
      {state?.success && state.message && <p role="status" className="m-0 text-callout text-ink">{state.message}</p>}
    </div>
  )
}
