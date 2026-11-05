import { createAdminClient } from '@/lib/supabase/admin'
import { OPEN_DEAL_STAGE_FILTER } from '@/domain/crm/sales'
import { dueFollowUps, type FollowUpDeal, type Nudge } from '@/domain/crm/followUp'
import { pragueToday } from '@/lib/pragueDate'

// Komu se má připomínat chybějící follow-up. Adresáti se dohledávají až
// tady — logika „komu a kdy" je čistá funkce v domain/crm/followUp.ts.
export type NudgeWithRecipient = Nudge & {
  recipient_email: string | null
  recipient_name: string | null
  owner_name: string | null
}

export async function getDueFollowUps(today = new Date()): Promise<NudgeWithRecipient[]> {
  const admin = createAdminClient()

  const [{ data: dealRows, error: dealErr }, { data: members, error: memberErr }] = await Promise.all([
    admin.from('deal').select(
      'id, title, owner_id, next_step, next_step_due, last_activity_at,'
      + ' follow_up_nudged_on, follow_up_escalated_on, account:account(name)',
    ).not('next_step_due', 'is', null).in('stage', OPEN_DEAL_STAGE_FILTER),
    admin.from('team_member').select('id, full_name, email, manager_id'),
  ])

  // Bez tohohle se výpadek databáze tvářil jako „nic není po termínu":
  // supabase-js nehází výjimku, jen vrátí data: null. Hlídač pak odpověděl
  // 200 s prázdným seznamem a volající neměl jak poznat rozdíl mezi
  // „opravdu nic" a „nepodařilo se to zjistit".
  if (dealErr) throw new Error(`Načtení obchodů selhalo: ${dealErr.message}`)
  if (memberErr) throw new Error(`Načtení týmu selhalo: ${memberErr.message}`)

  const byId = new Map((members ?? []).map((m) => [m.id, m]))
  // PostgREST embed rozbíjí odvození typu, proto ruční tvar řádku.
  type Row = Omit<FollowUpDeal, 'account_name'> & { account: { name?: string } | null }
  const deals: FollowUpDeal[] = ((dealRows ?? []) as unknown as Row[]).map((d) => ({
    id: d.id,
    title: d.title,
    account_name: d.account?.name ?? null,
    owner_id: d.owner_id,
    next_step: d.next_step,
    next_step_due: d.next_step_due,
    last_activity_at: d.last_activity_at,
    follow_up_nudged_on: d.follow_up_nudged_on,
    follow_up_escalated_on: d.follow_up_escalated_on,
  }))

  const ownerOf = new Map(deals.map((d) => [d.id, d.owner_id]))

  return dueFollowUps(deals, today).map((n) => {
    const owner = ownerOf.get(n.deal_id) ? byId.get(ownerOf.get(n.deal_id)!) : undefined
    // Eskalace jde na nadřízeného vlastníka; když ho nemá, zůstává u něj —
    // radši připomenout znovu jemu než to poslat někam náhodně.
    const target = n.level === 'manager' && owner?.manager_id ? byId.get(owner.manager_id) : owner
    return {
      ...n,
      recipient_email: target?.email ?? null,
      recipient_name: target?.full_name ?? null,
      owner_name: owner?.full_name ?? null,
    }
  })
}

// Označí, že se dnes upozorňovalo — volá se až po skutečném odeslání, aby
// se při selhání doručení nezapomnělo připomenout znovu.
export async function markNudged(ids: { deal_id: number; level: 'owner' | 'manager' }[]): Promise<number> {
  if (!ids.length) return 0
  const admin = createAdminClient()
  const today = pragueToday()
  let n = 0
  for (const { deal_id, level } of ids) {
    const patch = level === 'manager'
      ? { follow_up_escalated_on: today }
      : { follow_up_nudged_on: today }
    const { error } = await admin.from('deal').update(patch).eq('id', deal_id)
    if (!error) n++
  }
  return n
}
