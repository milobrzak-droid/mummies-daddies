import Link from 'next/link'
import { redirect } from 'next/navigation'
import { PageHeader } from '@/components/PageHeader'
import { SectionTabs, DEAL_TABS } from '@/components/SectionTabs'
import { CARD, CARD_PAD } from '@/components/ui/Card'
import { EmptyState } from '@/components/ui/EmptyState'
import { FeaturePending } from '@/components/ui/FeaturePending'
import { OutreachActions, SignalActions } from '@/components/OutboundActions'
import { canCurrentUserSeeSales } from '@/lib/queries/access'
import { formatDate } from '@/lib/format'
import { getSignalsPage, parseSignalFilter, SIGNAL_FILTERS, type SignalFilter } from '@/domain/outbound/queries'
import { OUTBOUND_SOURCE_LABELS } from '@/core/outbound/config'
import { QUALIFY_REASON_LABELS, type QualifyReason } from '@/core/outbound/qualify'
import { OUTREACH_REASON_LABELS, type OutreachReason } from '@/core/outbound/outreachPolicy'
import { SIGNAL_KIND_LABELS, SIGNAL_STATUS_LABELS } from '@/core/outbound/signal'

export const dynamic = 'force-dynamic'

const FILTER_LABELS: Record<SignalFilter, string> = {
  review: 'Ke kontrole', converted: 'Leady', new: 'Nové', dismissed: 'Odložené', blocked: 'Zablokované', failed: 'Chyby', all: 'Vše',
}

const CHANNEL_LABELS = { auto_email: 'E-mail (schválený pravidlem)', review_email: 'Koncept e-mailu', manual: 'Návrh pro osobní oslovení' } as const
const OUTREACH_STATUS_LABELS = {
  draft: 'Čeká na rozhodnutí', approved: 'Schváleno, čeká na odeslání', queued: 'Ve frontě', sent: 'Odesláno',
  skipped: 'Přeskočeno', rejected: 'Zamítnuto', done: 'Osloveno ručně',
} as const
const BASIS_LABELS = { existing_customer: 'stávající zákazník (§ 7 odst. 3)', consent: 'doložený souhlas', none: 'bez souhlasu — jen osobně' } as const

const STATUS_TONE: Record<string, string> = { converted: 'done', review: '', new: 'info', dismissed: 'info', blocked: 'fail', failed: 'fail' }

function reasonLabel(code: string): string {
  return QUALIFY_REASON_LABELS[code as QualifyReason] ?? OUTREACH_REASON_LABELS[code as OutreachReason] ?? code
}

// Signály outbound agenta (P7): co agent našel, jak to ohodnotil a co
// navrhuje. Novým firmám agent nic neposílá — připraví lead a návrh pro
// osobní oslovení. E-mail jen stávajícím zákazníkům a kontaktům se souhlasem.
export default async function SignalyPage({ searchParams }: { searchParams: Promise<{ stav?: string }> }) {
  if (!await canCurrentUserSeeSales()) redirect('/cockpit')
  const filter = parseSignalFilter((await searchParams).stav)
  const { migrationMissing, counts, items } = await getSignalsPage(filter)
  const agentOn = process.env.OUTBOUND_AGENT_ENABLED === 'true'
  const autosendOn = agentOn && process.env.OUTBOUND_AUTOSEND_ENABLED === 'true'

  return (
    <>
      <PageHeader
        title="Signály"
        eyebrow="Outbound agent"
        subtitle="Veřejné zakázky, akce, inzeráty a výročí klientů, které agent našel. Novým firmám nic neposílá — připraví lead a návrh osobního oslovení."
      />
      <SectionTabs tabs={DEAL_TABS} label="Obchody" />

      <p className="mb-4 text-callout text-muted" role="status">
        Agent je {agentOn ? 'zapnutý' : 'vypnutý'} · samostatné odeslání {autosendOn ? 'zapnuté (jen stávající zákazníci a kontakty se souhlasem)' : 'vypnuté — e-maily jen po schválení'}.
      </p>

      {migrationMissing ? (
        <FeaturePending card migration="0107">Pak se tu objeví signály outbound agenta.</FeaturePending>
      ) : (
        <>
          <nav aria-label="Stav signálů" className="mb-4 flex flex-wrap gap-2">
            {SIGNAL_FILTERS.map((f) => (
              <Link key={f} href={`/cockpit/signaly?stav=${f}`} className={`st no-underline ${f === filter ? 'done' : 'info'}`} aria-current={f === filter ? 'page' : undefined}>
                {FILTER_LABELS[f]}{f !== 'all' ? ` ${counts[f]}` : ''}
              </Link>
            ))}
          </nav>

          {items.length === 0 ? (
            <div className={CARD}>
              <EmptyState tone="calm" title="Tady teď nic není.">Agent zatím v tomto stavu žádný signál nemá.</EmptyState>
            </div>
          ) : (
            <ul aria-label="Signály" className="m-0 flex list-none flex-col gap-4 p-0">
              {items.map((s) => (
                <li key={s.id} className={`${CARD} ${CARD_PAD}`}>
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0 grow basis-64">
                      <small className="text-footnote text-muted">
                        {SIGNAL_KIND_LABELS[s.kind]} · {OUTBOUND_SOURCE_LABELS[s.source]} · nalezeno {formatDate(s.detectedAt)}
                        {s.signalDate ? ` · termín ${formatDate(s.signalDate)}` : ''}
                      </small>
                      <h2 className="m-0 mt-1 text-headline">
                        {s.url ? <a href={s.url} target="_blank" rel="noopener noreferrer nofollow">{s.title}</a> : s.title}
                      </h2>
                      {s.companyName && (
                        <p className="m-0 mt-1 text-callout">
                          {s.accountId ? <Link href={`/cockpit/clients/${s.accountId}`}>{s.companyName}</Link> : s.companyName}
                          {s.dealId && <> · obchod v CRM <span className="st info">Agent</span></>}
                        </p>
                      )}
                    </div>
                    <div className="flex flex-col items-end gap-1">
                      <span className={`st ${STATUS_TONE[s.status] ?? ''}`}>{SIGNAL_STATUS_LABELS[s.status]}</span>
                      {s.score != null && <small className="text-footnote text-muted tabular-nums">skóre {s.score}/100</small>}
                    </div>
                  </div>

                  {s.reasons.length > 0 && (
                    <p className="m-0 mt-2 text-footnote text-muted">Proč: {s.reasons.map(reasonLabel).join(' · ')}</p>
                  )}
                  {s.facts.length > 0 && (
                    <details className="mt-2">
                      <summary className="cursor-pointer text-footnote">Ověřená fakta ze zdroje ({s.facts.length})</summary>
                      <ul className="m-0 mt-1 pl-5 text-footnote">
                        {s.facts.map((f, i) => <li key={i}><strong>{f.key}</strong>: {f.value}</li>)}
                      </ul>
                    </details>
                  )}

                  <div className="mt-3"><SignalActions id={s.id} status={s.status} label={s.title} /></div>

                  {s.outreach.map((o) => (
                    <section key={o.id} aria-label="Oslovení" className="mt-4 rounded-card border border-border p-4">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <strong className="text-callout">{CHANNEL_LABELS[o.channel]}</strong>
                        <span className="st">{OUTREACH_STATUS_LABELS[o.status]}</span>
                      </div>
                      <p className="m-0 mt-1 text-footnote text-muted">
                        Právní titul: {BASIS_LABELS[o.basis]}{o.reasons.length ? ` · ${o.reasons.map(reasonLabel).join(' · ')}` : ''}
                      </p>
                      {o.subject && <p className="m-0 mt-2 text-callout"><strong>{o.subject}</strong></p>}
                      {o.body && <pre className="mt-1 whitespace-pre-wrap break-words font-sans text-footnote">{o.body}</pre>}
                      <div className="mt-2"><OutreachActions id={o.id} channel={o.channel} status={o.status} label={o.subject ?? s.title} /></div>
                    </section>
                  ))}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </>
  )
}
