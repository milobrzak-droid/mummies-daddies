'use client'
import { useActionState } from 'react'
import { SubmitButton } from '@/components/SubmitButton'
import type { CalendarCheckResult } from '@/domain/crm/meetingCalendar'

// „Zkontrolovat změny v Outlooku": ruční spuštění kontroly naplánovaných
// schůzek (jinak běží denně). Výsledek je vidět hned pod tlačítkem — věta
// o tom, co se posunulo, zrušilo a jaké úkoly vznikly.
export function CalendarCheckButton({ action }: { action: () => Promise<CalendarCheckResult> }) {
  const [state, formAction] = useActionState<CalendarCheckResult | null>(async () => action(), null)
  return (
    <div className="flex flex-col items-start gap-1.5">
      <form action={formAction}>
        <SubmitButton variant="soft">Zkontrolovat změny v Outlooku</SubmitButton>
      </form>
      {state && !state.ok && <p role="alert" className="m-0 text-[13px] text-neg">{state.error}</p>}
      {state?.ok && <p role="status" className="m-0 max-w-xl text-[13px] text-muted">{state.summary}</p>}
    </div>
  )
}
