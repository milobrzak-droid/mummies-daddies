// Čtení pro stránku Cockpitu /cockpit/signaly (P7). Klient s RLS: čte jen
// obchodní role s AAL2 (0107). Bez migrace 0107 vrací prázdný stav s
// příznakem, aby stránka řekla, že databáze čeká na migraci.
import { createClient } from '@/lib/supabase/server'
import { factsFromRow, SIGNAL_STATUSES, type SignalKind, type SignalStatus, type VerifiedFact } from '@/core/outbound/signal'
import type { OutboundSource } from '@/core/outbound/config'

export interface SignalListItem {
  id: number
  source: OutboundSource
  kind: SignalKind
  status: SignalStatus
  title: string
  url: string | null
  companyName: string | null
  score: number | null
  reasons: string[]
  detectedAt: string
  signalDate: string | null
  accountId: number | null
  dealId: number | null
  facts: VerifiedFact[]
  outreach: OutreachListItem[]
}

export interface OutreachListItem {
  id: number
  channel: 'auto_email' | 'review_email' | 'manual'
  status: 'draft' | 'approved' | 'queued' | 'sent' | 'skipped' | 'rejected' | 'done'
  basis: 'existing_customer' | 'consent' | 'none'
  reasons: string[]
  subject: string | null
  body: string | null
}

export interface SignalsPage {
  migrationMissing: boolean
  counts: Record<SignalStatus, number>
  items: SignalListItem[]
}

export const SIGNAL_FILTERS = ['review', 'converted', 'new', 'dismissed', 'blocked', 'failed', 'all'] as const
export type SignalFilter = (typeof SIGNAL_FILTERS)[number]

export function parseSignalFilter(raw: string | string[] | undefined): SignalFilter {
  const v = Array.isArray(raw) ? raw[0] : raw
  return (SIGNAL_FILTERS as readonly string[]).includes(v ?? '') ? (v as SignalFilter) : 'review'
}

const isMissing = (code: string | null | undefined) => code === '42P01' || code === 'PGRST205'

export async function getSignalsPage(filter: SignalFilter): Promise<SignalsPage> {
  const s = await createClient()
  const counts = Object.fromEntries(SIGNAL_STATUSES.map((k) => [k, 0])) as Record<SignalStatus, number>
  const all = await s.from('outbound_signal').select('status').limit(5000)
  if (all.error) {
    if (isMissing(all.error.code)) return { migrationMissing: true, counts, items: [] }
    throw new Error(`outbound_signal: ${all.error.code}`)
  }
  for (const r of (all.data ?? []) as { status: SignalStatus }[]) counts[r.status] = (counts[r.status] ?? 0) + 1

  let q = s.from('outbound_signal')
    .select('id, source, kind, status, title, url, company_name, score, reason_codes, detected_at, signal_date, account_id, deal_id, facts')
    .order('detected_at', { ascending: false }).limit(100)
  if (filter !== 'all') q = q.eq('status', filter)
  const { data, error } = await q
  if (error) throw new Error(`outbound_signal: ${error.code}`)
  const rows = (data ?? []) as Record<string, unknown>[]
  const ids = rows.map((r) => r.id as number)
  const outreach = ids.length
    ? ((await s.from('outbound_outreach').select('id, signal_id, channel, status, basis, reason_codes, subject, body')
      .in('signal_id', ids).order('created_at', { ascending: false })).data ?? []) as Record<string, unknown>[]
    : []

  return {
    migrationMissing: false,
    counts,
    items: rows.map((r) => ({
      id: r.id as number,
      source: r.source as OutboundSource,
      kind: r.kind as SignalKind,
      status: r.status as SignalStatus,
      title: r.title as string,
      url: (r.url as string | null) ?? null,
      companyName: (r.company_name as string | null) ?? null,
      score: (r.score as number | null) ?? null,
      reasons: (r.reason_codes as string[] | null) ?? [],
      detectedAt: r.detected_at as string,
      signalDate: (r.signal_date as string | null) ?? null,
      accountId: (r.account_id as number | null) ?? null,
      dealId: (r.deal_id as number | null) ?? null,
      facts: factsFromRow(r.facts),
      outreach: outreach.filter((o) => o.signal_id === r.id).map((o) => ({
        id: o.id as number,
        channel: o.channel as OutreachListItem['channel'],
        status: o.status as OutreachListItem['status'],
        basis: o.basis as OutreachListItem['basis'],
        reasons: (o.reason_codes as string[] | null) ?? [],
        subject: (o.subject as string | null) ?? null,
        body: (o.body as string | null) ?? null,
      })),
    })),
  }
}
