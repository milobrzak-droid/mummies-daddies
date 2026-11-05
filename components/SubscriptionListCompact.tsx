import Link from 'next/link'
import { Chip } from '@/components/Chip'
import { formatCzk, formatDate } from '@/lib/format'
import type { ChurnRisk, Subscription } from '@/lib/types'

const CHURN_LABEL: Record<ChurnRisk, string> = { low: 'Nízké riziko', medium: 'Střední riziko', high: 'Vysoké riziko' }
const CHURN_TONE: Record<ChurnRisk, string> = { low: 'pos', medium: 'warn', high: 'neg' }

// Lokální YYYY-MM-DD (ne UTC) — stejný důvod jako u termínů úkolů v
// TaskListCompact: porovnáváme kalendářní dny, ne časové pásmo.
function today(): string {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
function daysUntil(dateStr: string, t: string): number {
  const a = new Date(`${t}T00:00:00`)
  const b = new Date(`${dateStr}T00:00:00`)
  return Math.round((b.getTime() - a.getTime()) / 86400000)
}

export function SubscriptionListCompact({
  subscriptions, accountId, emptyText = 'Žádná předplatná.',
}: { subscriptions: Subscription[]; accountId: number; emptyText?: string }) {
  const t = today()

  if (subscriptions.length === 0) {
    return <div className="bg-surface rounded-card border border-border shadow-card px-5 py-8 text-muted text-sm">{emptyText}</div>
  }

  return (
    <div className="space-y-2">
      {subscriptions.map((sub) => {
        const ended = sub.ended_on != null
        // U ukončeného nemá smysl hlásit blížící se obnovu — už se neobnoví.
        const days = !ended && sub.renewal_date ? daysUntil(sub.renewal_date, t) : null
        // Obnova do 60 dní — včetně už proběhlé bez rozhodnutí (days < 0) —
        // je věc k řešení teď, ne jen datum vedle ostatních.
        const renewalUrgent = days !== null && days <= 60
        const licenceWord = sub.seats >= 1 && sub.seats <= 4 ? 'licence' : 'licencí'
        return (
          <div key={sub.id} className={`bg-surface border border-border rounded-card shadow-card p-4 sm:px-6 flex flex-wrap items-center gap-3${ended ? ' opacity-60' : ''}`}>
            <div className="flex-1 min-w-[160px]">
              <div className="font-heading text-[15px] leading-tight">{sub.product}</div>
              <div className="text-xs text-muted mt-1">{sub.seats} {licenceWord} · {formatCzk(sub.mrr)} / měsíc</div>
            </div>
            {ended
              ? <Chip tone="neutral">Ukončeno {formatDate(sub.ended_on)}</Chip>
              : <Chip tone={CHURN_TONE[sub.churn_risk]}>{CHURN_LABEL[sub.churn_risk]}</Chip>}
            {sub.health_score !== null && <Chip tone="neutral">Zdraví {sub.health_score}</Chip>}
            {sub.is_ms_subsidized && <Chip tone="blue">MS dotace</Chip>}
            {sub.renewal_date ? (
              renewalUrgent
                ? (
                  <Chip tone="neg">
                    {days! < 0 ? 'Po termínu obnovy' : days === 0 ? 'Obnova dnes' : `Obnova za ${days} dní`} · {formatDate(sub.renewal_date)}
                  </Chip>
                )
                : <span className="text-xs text-muted whitespace-nowrap">Obnova {formatDate(sub.renewal_date)}</span>
            ) : (
              <span className="text-xs text-muted">Bez termínu obnovy</span>
            )}
            <Link href={`/cockpit/clients/${accountId}/predplatne/${sub.id}/edit`} className="pill-tab min-h-[44px] no-underline">
              Upravit
            </Link>
          </div>
        )
      })}
    </div>
  )
}
