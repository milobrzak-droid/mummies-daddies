// Dodávky, obchody a milníky klienta pro obsahový vstup pošty. Čisté čtení přes
// předaného klienta (cron: servisní klíč; fronta: session obchodní role), proto
// je to samostatný soubor bez závislosti na serveru — importuje ho služba
// (mailContentService.ts) i dotazy pro fronta (queries/mailContent.ts).
import type { SupabaseClient } from '@supabase/supabase-js'
import { OPEN_DEAL_STAGE_KEYS, engagementKindLabel } from '@/lib/domain'
import type { MilestoneOption, TargetOption } from '@/domain/crm/mailContent'

export type AccountTargets = {
  accountName: string | null
  options: TargetOption[]
  /** Otevřené milníky podle id dodávky. */
  milestones: Record<number, MilestoneOption[]>
}

type Row = Record<string, unknown>
const num = (v: unknown): number => Number(v)
const strOrNull = (v: unknown): string | null => (typeof v === 'string' ? v : null)

/**
 * Otevřené dodávky (ne uzavřené) a obchody klienta bez dodávky. Název dodávky
 * je název obchodu, ze kterého vznikla, jinak druh. Čte přes předaného klienta
 * (cron: servisní klíč; fronta: session obchodní role).
 */
export async function loadMailTargets(db: Pick<SupabaseClient, 'from'>, accountId: number): Promise<AccountTargets> {
  const [account, engagements, deals] = await Promise.all([
    db.from('account').select('name').eq('id', accountId).maybeSingle(),
    db.from('engagement').select('id, deal_id, kind, phase').eq('account_id', accountId).neq('phase', 'uzavreno').order('id'),
    db.from('deal').select('id, title, stage').eq('account_id', accountId).order('id'),
  ])
  for (const r of [account, engagements, deals]) if (r.error) throw r.error
  const dealRows = (deals.data ?? []) as Row[]
  const titleOf = new Map(dealRows.map((d) => [num(d.id), strOrNull(d.title)]))
  const engRows = (engagements.data ?? []) as Row[]

  const options: TargetOption[] = engRows.map((e) => {
    const dealId = e.deal_id == null ? null : num(e.deal_id)
    const title = dealId != null ? titleOf.get(dealId) : null
    return { kind: 'engagement', id: num(e.id), label: title?.trim() || engagementKindLabel(strOrNull(e.kind)), dealId }
  })
  const withEngagement = new Set(options.map((o) => o.dealId).filter((d): d is number => d != null))
  const open = new Set<string>(OPEN_DEAL_STAGE_KEYS)
  for (const d of dealRows) {
    if (!open.has(String(d.stage)) || withEngagement.has(num(d.id))) continue
    const title = strOrNull(d.title)?.trim()
    if (title) options.push({ kind: 'deal', id: num(d.id), label: title, dealId: num(d.id) })
  }

  const milestones: Record<number, MilestoneOption[]> = {}
  const ids = engRows.map((e) => num(e.id))
  if (ids.length > 0) {
    const ms = await db.from('engagement_milestone').select('id, engagement_id, title, status, due_on').in('engagement_id', ids).order('id')
    if (ms.error) throw ms.error
    for (const m of (ms.data ?? []) as Row[]) {
      const list = (milestones[num(m.engagement_id)] ??= [])
      list.push({ id: num(m.id), title: String(m.title ?? ''), status: String(m.status ?? ''), dueOn: strOrNull(m.due_on) })
    }
  }
  return { accountName: strOrNull((account.data as Row | null)?.name) ?? null, options, milestones }
}

