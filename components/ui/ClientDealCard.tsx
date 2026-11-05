import Link from 'next/link'
import { ProjectCard } from '@/components/ProjectCard'
import { CARD } from '@/components/ui/Card'
import { formatCzk, formatDate } from '@/lib/format'
import { DEAL_STAGES, dealKindLabel, dealStageLabel } from '@/lib/domain'
import { describeDue } from '@/domain/crm/clientOverview'
import type { DealWithChannel } from '@/lib/types'

const OPEN_KEYS: string[] = DEAL_STAGES.filter((s) => s.open).map((s) => s.key)

// Karta obchodu na detailu klienta: název, fáze jako pás dílků, částka
// a další krok. Všechno ostatní (marže, tým, poznámky, stav dodávky)
// zůstává v „Podrobnostech" — dosavadní karta obchodu se nemění.
export function ClientDealCard({
  deal: d, href, pdfUrl, today,
}: { deal: DealWithChannel; href: string; pdfUrl?: string; today: string }) {
  const idx = OPEN_KEYS.indexOf(d.stage)
  const total = OPEN_KEYS.length + 1 // otevřené fáze + „Vyhráno"
  const won = d.stage === 'vyhráno'
  const filled = won ? total : idx + 1
  const stageClass = won ? 'st done' : d.stage === 'prohráno' ? 'st fail' : idx >= 0 ? 'st info' : 'st'
  const kind = dealKindLabel(d.deal_kind ?? null)
  const nextText = d.next_step?.trim()

  return (
    <article className={`${CARD} flex flex-col gap-3 p-5`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <Link href={href} className="font-heading text-title2 font-bold text-ink">{d.title}</Link>
          {kind && <div className="mt-1 text-footnote text-muted">{kind}</div>}
        </div>
        <div className="shrink-0 font-heading text-title2 font-bold tabular-nums text-ink">
          {d.amount_one_time != null ? formatCzk(d.amount_one_time) : '—'}
        </div>
      </div>

      {filled > 0 && (
        <div
          role="img"
          aria-label={`Postup obchodu: fáze ${filled} z ${total}, ${dealStageLabel(d.stage)}`}
          className="flex gap-1"
        >
          {Array.from({ length: total }).map((_, i) => (
            <i
              key={i}
              className="block h-2.5 flex-1 rounded-full"
              style={{
                backgroundColor: i < filled - 1 || (won && i === filled - 1)
                  ? 'var(--c-navy)'
                  : i === filled - 1 ? 'var(--c-accent)' : 'var(--d-track)',
                backgroundImage: i < filled ? 'repeating-linear-gradient(90deg,rgba(255,255,255,.28) 0 2px,transparent 2px 5px)' : undefined,
              }}
            />
          ))}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className={stageClass}>{dealStageLabel(d.stage)}</span>
        {filled > 0 && !won && <span className="text-footnote text-muted">fáze {filled} z {total}</span>}
        {d.won_at ? (
          <span className="text-footnote text-muted">vyhráno {formatDate(d.won_at)}</span>
        ) : d.expected_close ? (
          <span className="text-footnote text-muted">termín {formatDate(d.expected_close)}</span>
        ) : null}
      </div>

      {nextText && (
        <p className="m-0 text-body text-[color:#3A424E]">
          <span className="eyebrow mr-2">Další krok</span>
          {nextText}
          {d.next_step_due && <span className="text-muted"> · {describeDue(d.next_step_due, today)} ({formatDate(d.next_step_due)})</span>}
        </p>
      )}
      {d.status_blocker && <p className="m-0 text-body text-neg">Brzdí: {d.status_blocker}</p>}

      <details className="mt-1">
        <summary className="flex min-h-[44px] cursor-pointer items-center text-callout font-semibold text-muted hover:text-ink">Podrobnosti</summary>
        <div className="mt-3">
          <ProjectCard deal={d} href={href} pdfUrl={pdfUrl} />
        </div>
      </details>
    </article>
  )
}
