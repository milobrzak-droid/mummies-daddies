import Link from 'next/link'
import { DataTable } from '@/components/DataTable'
import { Chip } from '@/components/Chip'
import { PRAGUE_TZ } from '@/lib/pragueDate'
import { segmentLabel, type AgentActivityRow, type AgentAttentionRow } from '@/domain/crm/agentKpi'

// Tabulka posledních rozhodnutí agenta a fronta, která chce člověka (P5).
// Záměrně bez těla e-mailu, předmětu, adres a jmen osob: klient je název
// firmy z CRM, dál segment, rozhodnutí, důvody, stav odeslání a odkaz na obchod.

const formatter = new Intl.DateTimeFormat('cs-CZ', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: PRAGUE_TZ })

const DECISION_TONE: Record<string, string> = {
  send_offer: 'pos', ask_info: 'info', escalate: 'warn', not_inquiry: 'neutral', pending: 'neutral',
}
const SEND_TONE: Record<string, string> = {
  sent: 'pos', queued: 'info', claimed: 'info', failed: 'neg', needs_attention: 'neg', blocked: 'warn',
}

export function AgentActivityTable({ rows }: { rows: readonly AgentActivityRow[] }) {
  return (
    <DataTable mobile="cards" label="Poslední rozhodnutí agenta"
      rows={[...rows]}
      empty="Za období agent nic nerozhodoval."
      emptyHint="Poptávky z e-mailu a webu se tu ukážou, jakmile je agent zpracuje."
      columns={[
        { header: 'Přijato', cell: (r) => <time dateTime={r.receivedAt} className="whitespace-nowrap">{formatter.format(new Date(r.receivedAt))}</time> },
        { header: 'Zdroj', cell: (r) => (r.source === 'web' ? 'Web' : 'E-mail') },
        { header: 'Klient', cell: (r) => r.client ?? <span className="text-muted">nespárováno</span> },
        { header: 'Segment', cell: (r) => segmentLabel(r.segment) },
        { header: 'Rozhodnutí', cell: (r) => <Chip dot tone={DECISION_TONE[r.decision] ?? 'neutral'}>{r.decisionLabel}</Chip> },
        { header: 'Důvody', cell: (r) => (r.reasons.length > 0 ? r.reasons.join(', ') : <span className="text-muted">—</span>) },
        { header: 'Odeslání', cell: (r) => (r.sendStatus ? <Chip dot tone={SEND_TONE[r.sendStatus] ?? 'neutral'}>{r.sendLabel}</Chip> : <span className="text-muted">{r.sendLabel}</span>) },
        { header: 'Obchod', cell: (r) => (r.dealHref ? <Link href={r.dealHref}>Otevřít</Link> : <span className="text-muted">—</span>) },
      ]}
    />
  )
}

export function AgentAttentionTable({ rows }: { rows: readonly AgentAttentionRow[] }) {
  return (
    <DataTable mobile="cards" label="Zprávy, které čekají na člověka"
      rows={[...rows]}
      empty="Ve frontě nic nečeká na člověka."
      columns={[
        { header: 'Zpráva', cell: (r) => `${r.kindLabel} č. ${r.id}` },
        { header: 'Stav', cell: (r) => <Chip dot tone={SEND_TONE[r.status] ?? 'neutral'}>{r.statusLabel}</Chip> },
        { header: 'Důvod zastavení', cell: (r) => r.stopReason ?? <span className="text-muted">—</span> },
        { header: 'Den', cell: (r) => (r.day ? new Date(`${r.day}T12:00:00`).toLocaleDateString('cs-CZ') : '—') },
        { header: 'Obchod', cell: (r) => (r.dealHref ? <Link href={r.dealHref}>Otevřít</Link> : <span className="text-muted">—</span>) },
      ]}
    />
  )
}
