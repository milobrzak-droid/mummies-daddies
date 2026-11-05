'use client'
import { useActionState } from 'react'
import { SubmitButton } from '@/components/SubmitButton'
import type { ActionResult } from '@/lib/actionResult'

// Vlastní komponenta jen kvůli tomu, aby byl výsledek vidět. Dřív byl
// formulář inline server action, jejíž návratovou hodnotu nikdo nečetl —
// takže když se do kalendáře nezapsalo nic, stránka se jen překreslila
// a uživatel zůstal v přesvědčení, že termíny má.
//
// `note` = vlastní věta o výsledku (u obchodních rolí i o kontrole
// naplánovaných schůzek podle Outlooku); bez ní obecné „Úkoly jsou v kalendáři."
export function SyncTasksButton({
  action,
  label = 'Synchronizovat úkoly',
}: {
  action: () => Promise<ActionResult & { note?: string }>
  label?: string
}) {
  const [state, formAction] = useActionState<(ActionResult & { note?: string }) | null>(async () => action(), null)
  return (
    <div className="space-y-2">
      <form action={formAction}>
        <SubmitButton variant="soft">{label}</SubmitButton>
      </form>
      {state?.error && <p role="alert" className="text-neg text-sm m-0">{state.error}</p>}
      {state?.success && <p role="status" className="text-sm text-muted m-0">{state.note ?? 'Úkoly jsou v kalendáři.'}</p>}
    </div>
  )
}
