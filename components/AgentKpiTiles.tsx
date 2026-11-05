import { CARD } from '@/components/ui/Card'
import { formatDuration, type AgentKpi } from '@/domain/crm/agentKpi'

// Dlaždice KPI agenta (P5): velké číslo, popisek a jedna věta kontextu.
// Žádný graf — každá dlaždice je jedno číslo (dataviz: hero number), barva
// jen u pruhu podílu automaticky vyřízených (jedna řada, jeden odstín).

type Tile = { label: string; value: string; note: string; bar?: number | null }

function plural(n: number, one: string, few: string, many: string): string {
  if (n === 1) return one
  if (n >= 2 && n <= 4) return few
  return many
}

const pctText = (v: number | null) => (v == null ? '—' : `${v.toLocaleString('cs-CZ')} %`)

export function agentTiles(kpi: AgentKpi): Tile[] {
  const { inquiries, escalations, outbox, firstResponse, offerSpeed, autoShare, outcome } = kpi
  return [
    {
      label: 'Poptávky',
      value: String(inquiries.real),
      note: `${inquiries.email} z e-mailu · ${inquiries.web} z webu${inquiries.received > inquiries.real ? ` · ${inquiries.received - inquiries.real} mimo poptávky` : ''}`,
    },
    {
      label: 'Eskalace na obchod',
      value: String(escalations.total),
      note: escalations.byReason[0] ? `nejčastěji: ${escalations.byReason[0].label}` : 'agent nic nepředal člověku',
    },
    {
      label: 'Vyřízeno automaticky',
      value: pctText(autoShare.pct),
      note: `${autoShare.auto} z ${autoShare.total} ${plural(autoShare.total, 'poptávky', 'poptávek', 'poptávek')} bez zásahu člověka`,
      bar: autoShare.pct,
    },
    {
      label: 'První reakce (medián)',
      value: formatDuration(firstResponse.medianMinutes),
      note: `p90 ${formatDuration(firstResponse.p90Minutes)} · ${firstResponse.waiting} bez reakce`,
    },
    {
      label: 'Nabídka odeslána za',
      value: formatDuration(offerSpeed.medianMinutes),
      note: `medián · p90 ${formatDuration(offerSpeed.p90Minutes)} · ${offerSpeed.waiting} čeká na nabídku`,
    },
    {
      label: 'Odeslané zprávy',
      value: String(outbox.sent),
      note: `${outbox.queued} ve frontě · ${outbox.blocked} zablokováno · ${outbox.failed} selhalo`,
    },
    {
      label: 'Úspěšnost',
      value: pctText(outcome.winRatePct),
      note: `${outcome.won} ${plural(outcome.won, 'vyhraný', 'vyhrané', 'vyhraných')} · ${outcome.lost} ${plural(outcome.lost, 'prohraný', 'prohrané', 'prohraných')}`,
    },
  ]
}

export function AgentKpiTiles({ kpi }: { kpi: AgentKpi }) {
  const tiles = agentTiles(kpi)
  return (
    <section aria-label="Agent v číslech" className={`${CARD} mb-6 overflow-hidden`}>
      <dl className="m-0 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map((t) => (
          <div key={t.label} className="-ml-px -mt-px border-l border-t border-[color:var(--c-line-2)] p-5">
            <dt className="eyebrow">{t.label}</dt>
            <dd className="m-0 mt-2 big-num whitespace-nowrap text-[32px] text-ink tabular-nums">{t.value}</dd>
            {t.bar != null && (
              <dd className="m-0 mt-2">
                <div role="img" aria-label={`${t.label}: ${pctText(t.bar)}`} className="bar thin turquoise">
                  <i style={{ width: `${Math.max(0, Math.min(100, t.bar))}%` }} />
                </div>
              </dd>
            )}
            <dd className="m-0 mt-1 text-footnote text-muted">{t.note}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}
