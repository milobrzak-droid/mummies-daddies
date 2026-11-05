// Časová osa pracovního případu: založení, kroky, rozhodnutí, žádosti
// o schválení a výsledek jejich provedení (0084). Jen prezentace nad
// událostmi z core/caseTimeline.ts; nejnovější nahoře. Bez vlastní karty –
// obal dává stránka (Card „Časová osa“ v detailu případu).
import type { TimelineEvent, TimelineTone } from '@/core/caseTimeline'
import { PRAGUE_TZ } from '@/lib/pragueDate'

const DOT: Record<TimelineTone, string> = {
  done: 'var(--d-green)',
  wait: 'var(--d-amber)',
  fail: 'var(--d-red)',
  info: 'var(--d-blue)',
  idle: 'var(--c-slate-2)',
}

const fmt = (iso: string) =>
  new Date(iso).toLocaleString('cs-CZ', {
    day: 'numeric', month: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: PRAGUE_TZ,
  })

export function CaseTimeline({ events }: { events: readonly TimelineEvent[] }) {
  if (events.length === 0) return null
  return (
    <ol className="m-0 list-none p-0" aria-label="Časová osa případu">
      {events.map((e, i) => (
        <li key={e.key} className="relative flex gap-3.5 pb-4 last:pb-0">
          {i < events.length - 1 && (
            <span aria-hidden="true" className="absolute left-[5px] top-4 bottom-0 w-px bg-[color:var(--c-line)]" />
          )}
          <span aria-hidden="true" className="mt-1.5 h-[11px] w-[11px] flex-none rounded-full" style={{ background: DOT[e.tone] }} />
          <div className="min-w-0 flex-1">
            <b className="block text-headline">{e.title}</b>
            {e.detail && <span className="mt-0.5 block text-callout text-muted">{e.detail}</span>}
            <small className="mt-0.5 block text-footnote text-muted tabular-nums">{fmt(e.at)}</small>
          </div>
        </li>
      ))}
    </ol>
  )
}
