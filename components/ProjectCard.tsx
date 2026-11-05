import Link from 'next/link'
import { Avatar } from '@/components/Avatar'
import { ArrowRightIcon, CheckIcon, ChevronRightIcon, WarnIcon } from '@/components/ui/Icons'
import { formatCzk, formatDate } from '@/lib/format'
import { pillarLabel, pillarSub, phasesFor, phaseIndex, teamLabel, dealMargin } from '@/lib/domain'
import type { DealWithChannel } from '@/lib/types'
import { EXTERNAL_LINK_REL } from '@/core/untrusted'

// Projekt jako karta: pilíř + realizační tým, fázová časová osa, peníze, stav dodávky.
export function ProjectCard({ deal: d, href, account, pdfUrl }:
  { deal: DealWithChannel; href?: string; account?: { id: number; name: string } | null; pdfUrl?: string }) {
  const phases = phasesFor(d.pillar)
  const cur = phaseIndex(d.pillar, d.phase)
  const margin = dealMargin(d.amount_one_time, d.cogs_one_time)

  return (
    <div className="bg-surface shadow-card rounded-card p-5 space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          {account && (
            <Link href={`/cockpit/clients/${account.id}`} className="text-xs text-muted hover:text-accent-text">{account.name}</Link>
          )}
          <div className="font-heading font-bold text-base leading-tight">
            {href ? <Link href={href}>{d.title}</Link> : d.title}
          </div>
          <div className="text-xs text-muted mt-1">
            {pillarLabel(d.pillar)}{pillarSub(d.pillar) ? ` · ${pillarSub(d.pillar)}` : ''}
            {d.delivery_team ? ` · ${teamLabel(d.delivery_team)}` : ''}
            {d.channel ? ` · přes ${d.channel.name}` : ''}
          </div>
        </div>
        <div className="text-right shrink-0">
          <div className="font-heading font-bold tabular-nums text-ink">
            {d.amount_one_time != null ? formatCzk(d.amount_one_time) : '—'}
          </div>
          {d.currency === 'EUR' && d.amount_one_time_original != null && (
            <div className="text-xs text-muted">
              {Number(d.amount_one_time_original).toLocaleString('cs-CZ')} € · kurz {d.fx_rate != null ? Number(d.fx_rate).toFixed(3) : '—'}
            </div>
          )}
          <div className="text-xs mt-0.5">
            {margin
              ? <span className={margin.czk >= 0 ? 'text-pos' : 'text-neg'}>Marže {formatCzk(margin.czk)} · {margin.pct} %</span>
              : <span className="text-muted">Marže — doplň náklady</span>}
          </div>
          {d.estimate_md ? <div className="text-xs text-muted">{d.estimate_md} MD</div> : null}
          {d.won_at ? (
            <div className="text-xs text-muted">vyhráno {formatDate(d.won_at)}</div>
          ) : d.expected_close ? (
            <div className="text-xs text-muted">termín {formatDate(d.expected_close)}</div>
          ) : null}
        </div>
      </div>

      {phases.length > 0 && (
        <div className="flex items-center flex-wrap gap-y-1">
          {phases.map((f, i) => {
            const done = cur >= 0 && i < cur
            const current = i === cur
            return (
              <span key={f.key} className="flex items-center">
                <span
                  className={`text-xs px-2.5 py-0.5 rounded-full border whitespace-nowrap ${
                    current
                      ? 'font-bold'
                      : done
                        ? 'text-muted line-through border-transparent'
                        : 'text-muted border-transparent'
                  }`}
                  style={current ? {
                    background: 'var(--p-blue)',
                    color: 'var(--c-ink)',
                    borderColor: 'var(--d-blue)',
                  } : undefined}
                >
                  {f.label}
                </span>
                {i < phases.length - 1 && <ChevronRightIcon size={12} className="mx-0.5 shrink-0 text-[color:var(--c-slate)]" />}
              </span>
            )
          })}
        </div>
      )}

      {d.note && <p className="text-sm text-muted leading-snug">{d.note}</p>}

      {(d.status_done || d.status_next || d.status_blocker) && (
        <div className="space-y-1.5 text-sm">
          {d.status_done && <div className="flex gap-2"><CheckIcon className="mt-0.5 shrink-0 text-pos" /><span className="sr-only">Hotovo:</span><span className="text-ink-2">{d.status_done}</span></div>}
          {d.status_next && <div className="flex gap-2"><ArrowRightIcon className="mt-0.5 shrink-0 text-ink" /><span className="sr-only">Další krok:</span><span className="text-ink-2">{d.status_next}</span></div>}
          {d.status_blocker && <div className="flex gap-2"><WarnIcon className="mt-0.5 shrink-0 text-neg" /><span className="sr-only">Blokuje:</span><span className="text-neg">{d.status_blocker}</span></div>}
        </div>
      )}

      {d.dev_team && d.dev_team.length > 0 && (
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {d.dev_team.map((dev) => (
            <span key={dev} className="inline-flex items-center gap-1.5 text-xs text-muted">
              <Avatar name={dev} size={20} />{dev}
            </span>
          ))}
        </div>
      )}

      {pdfUrl && (
        <a href={pdfUrl} target="_blank" rel={EXTERNAL_LINK_REL} className="text-xs underline text-muted">
          Zobrazit původní nabídku
        </a>
      )}
    </div>
  )
}
