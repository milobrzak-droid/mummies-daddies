import Link from 'next/link'
import type { ReactNode } from 'react'
import type { SalesActivityLike } from '@/domain/crm/sales'
import { CARD } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'

// Lineární ikony 24 × 24, tah 2 (docs/PROVOZ.md §7) místo znaků ☎ ✉.
const svg = (path: ReactNode) => (
  <svg aria-hidden="true" focusable="false" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">{path}</svg>
)
const ICON: Record<string, ReactNode> = {
  call: svg(<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8.1 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2z" />),
  email: svg(<><rect x="3" y="5" width="18" height="14" rx="3" /><path d="m3 8 9 6 9-6" /></>),
  meeting: svg(<><rect x="3" y="5" width="18" height="16" rx="3" /><path d="M8 3v4M16 3v4M3 10h18" /></>),
  note: svg(<><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M9 13h6M9 17h4" /></>),
  other: svg(<circle cx="12" cy="12" r="3" />),
}
const KIND: Record<string, string> = {
  call: 'Telefonát', email: 'E-mail', meeting: 'Schůzka', note: 'Poznámka', other: 'Aktivita',
}
const OUTCOME: Record<string, string> = {
  completed: 'Dokončeno', no_answer: 'Bez odpovědi', follow_up: 'Navázat', cancelled: 'Zrušeno',
  planned: 'Naplánováno',
}
// Stavová pilulka s tečkou (.st): zelená hotovo, modrá naplánováno / navázat,
// červená zrušeno, žlutá čeká (bez odpovědi). Celé názvy tříd kvůli Tailwindu.
const OUTCOME_CLASS: Record<string, string> = {
  completed: 'st done', no_answer: 'st', follow_up: 'st info', cancelled: 'st fail', planned: 'st info',
}
// Barva kroužku = druh aktivity (pastelová dlaždice), ne dekorace.
const DOT: Record<string, string> = {
  call: 'bg-[var(--p-peach)]', email: 'bg-[var(--p-sky)]', meeting: 'bg-[var(--p-lav)]',
  note: 'bg-[var(--p-sun)]', other: 'bg-[var(--c-soft)]',
}

const formatter = new Intl.DateTimeFormat('cs-CZ', {
  day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
})

// Časová osa historie vztahu: kroužek podle druhu, svislá čára mezi záznamy,
// stav (výsledek) jako pilulka. Vlastnosti a data beze změny.
export function ActivityTimeline({ activities, showAccount = true }:
  { activities: SalesActivityLike[]; showAccount?: boolean }) {
  if (activities.length === 0) {
    return (
      <div className={CARD}>
        <EmptyState compact title="Zatím žádná zaznamenaná aktivita.">Zapsané hovory, e-maily a schůzky se ukážou tady.</EmptyState>
      </div>
    )
  }
  return (
    <ol className={`${CARD} m-0 list-none p-5 sm:p-6`}>
      {activities.map((activity, i) => (
        <li key={activity.id} className={`relative flex gap-3 ${i < activities.length - 1 ? 'pb-6' : ''}`}>
          {i < activities.length - 1 && (
            <span className="absolute left-[17px] top-[38px] bottom-0 w-0.5 bg-[var(--c-line)]" aria-hidden />
          )}
          <span
            className={`w-9 h-9 shrink-0 rounded-full flex items-center justify-center text-ink ${DOT[activity.kind] ?? DOT.other}`}
            aria-hidden
          >
            {ICON[activity.kind] ?? ICON.other}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-start justify-between gap-x-4 gap-y-1 flex-wrap">
              <div className="min-w-0 text-headline text-ink [overflow-wrap:anywhere]">{activity.subject}</div>
              <time dateTime={activity.occurred_at} className="text-footnote text-muted whitespace-nowrap tabular-nums">{formatter.format(new Date(activity.occurred_at))}</time>
            </div>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 mt-1.5">
              <span className="text-footnote text-muted">
                {KIND[activity.kind] ?? activity.kind}
                {activity.author ? ` · ${activity.author.full_name}` : ''}
              </span>
              <span className={OUTCOME_CLASS[activity.outcome] ?? 'st'}>{OUTCOME[activity.outcome] ?? activity.outcome}</span>
            </div>
            {showAccount && activity.account && (
              <Link href={`/cockpit/clients/${activity.account.id}`} className="inline-block text-xs mt-2 text-ink underline decoration-[color:var(--c-accent)] underline-offset-2">
                {activity.account.name}
              </Link>
            )}
            {activity.deal && <span className="text-xs text-muted">{showAccount && activity.account ? ' · ' : ''}{activity.deal.title}</span>}
            {activity.contact && <span className="text-xs text-muted"> · {activity.contact.full_name}</span>}
            {activity.body && <p className="text-body text-[color:#3A424E] whitespace-pre-line mt-2 mb-0">{activity.body}</p>}
            {activity.follow_up_on && (
              <div className="inline-flex mt-2 rounded-full bg-[color:var(--c-warn-soft)] text-[color:var(--c-warn)] px-2.5 py-1 text-xs font-medium">
                Navázat {new Date(`${activity.follow_up_on}T12:00:00`).toLocaleDateString('cs-CZ')}
              </div>
            )}
          </div>
        </li>
      ))}
    </ol>
  )
}
