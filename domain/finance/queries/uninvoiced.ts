import { createClient } from '@/lib/supabase/server'
import { isMissingRelation } from '@/core/loopQueries'
import { logError } from '@/lib/log'

// Přijaté milníky (akceptace klientem), ke kterým ještě není podklad
// k fakturaci: milník ve stavu „přijato" nebo „uzavřeno" bez nezrušeného
// záznamu „Vyfakturováno" navázaného na milník. Jen čtení; stránka Finance
// tím ukazuje, co čeká na založení podkladu. Volat jen pro obchodní role
// (financial_record je v DB sales_only, stránka to hlídá).

export type UninvoicedMilestone = {
  id: number
  title: string
  engagement_id: number
  account_id: number
  account_name: string | null
  accepted_at: string | null
}

export type UninvoicedResult =
  | { state: 'ok'; milestones: UninvoicedMilestone[] }
  | { state: 'missing_migration' }
  | { state: 'error' }

type Joined<T> = T | T[] | null
const one = <T,>(v: Joined<T>): T | null => (Array.isArray(v) ? (v[0] ?? null) : v)

export async function listUninvoicedMilestones(): Promise<UninvoicedResult> {
  const s = await createClient()
  const [ms, inv] = await Promise.all([
    s
      .from('engagement_milestone')
      .select('id, title, engagement_id, accepted_at, engagement:engagement_id(account_id, account:account_id(name))')
      .in('status', ['prijato', 'uzavreno'])
      .order('accepted_at', { ascending: false, nullsFirst: false })
      .limit(500),
    s
      .from('financial_record')
      .select('milestone_id')
      .eq('kind', 'invoiced')
      .neq('status', 'cancelled')
      .not('milestone_id', 'is', null)
      .limit(5000),
  ])
  if (isMissingRelation(ms.error) || isMissingRelation(inv.error)) return { state: 'missing_migration' }
  const err = ms.error ?? inv.error
  if (err) {
    logError('query.uninvoicedMilestones', err)
    return { state: 'error' }
  }
  const invoiced = new Set(((inv.data ?? []) as { milestone_id: number | null }[]).map((r) => r.milestone_id))
  type Row = {
    id: number
    title: string
    engagement_id: number
    accepted_at: string | null
    engagement: Joined<{ account_id: number; account: Joined<{ name: string }> }>
  }
  const milestones = ((ms.data ?? []) as unknown as Row[])
    .filter((m) => !invoiced.has(m.id))
    .flatMap((m) => {
      const e = one(m.engagement)
      if (!e) return []
      return [
        {
          id: m.id,
          title: m.title,
          engagement_id: m.engagement_id,
          account_id: e.account_id,
          account_name: one(e.account)?.name ?? null,
          accepted_at: m.accepted_at,
        },
      ]
    })
  return { state: 'ok', milestones }
}
