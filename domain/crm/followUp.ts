// Kdo má poslat follow-up a komu se to připomíná.
//
// Čistá funkce nad daty — rozhodování o eskalaci je přesně to místo, kde
// se nesmí spoléhat na to, že „to nějak vyjde". Když se splete, buď někoho
// obtěžuje zbytečně, nebo mlčí, když má křičet.

import { daysBetweenPragueDays, pragueDayOf, pragueToday } from '@/lib/pragueDate'

export type FollowUpDeal = {
  id: number
  title: string
  account_name: string | null
  owner_id: string | null
  next_step: string | null
  next_step_due: string | null   // YYYY-MM-DD
  last_activity_at: string | null
  follow_up_nudged_on: string | null
  follow_up_escalated_on: string | null
}

export type Nudge = {
  deal_id: number
  title: string
  account_name: string | null
  due: string
  days_overdue: number
  /** komu to jde: vlastník obchodu, nebo jeho nadřízený */
  level: 'owner' | 'manager'
}

const isDay = (s: string) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s))

/** Po kolika dnech po termínu se eskaluje nadřízenému. */
export const ESCALATE_AFTER_DAYS = 3

export function dueFollowUps(deals: FollowUpDeal[], today: Date): Nudge[] {
  // „Dnes" a termíny jsou kalendářní dny v Praze, ne v UTC.
  const todayStr = pragueToday(today)
  const out: Nudge[] = []

  for (const d of deals) {
    if (!d.next_step_due) continue
    const due = d.next_step_due
    if (!isDay(due) || due > todayStr) continue

    // Aktivita po termínu znamená, že follow-up proběhl — mlčíme.
    if (d.last_activity_at && pragueDayOf(d.last_activity_at) >= due) continue

    const daysOverdue = daysBetweenPragueDays(due, todayStr)
    const escalate = daysOverdue >= ESCALATE_AFTER_DAYS

    // Neposílat totéž dvakrát za den. Eskalace se posílá i tehdy, když už
    // vlastník upozornění dostal — je to jiný adresát a jiná zpráva.
    const alreadySent = escalate ? d.follow_up_escalated_on === todayStr : d.follow_up_nudged_on === todayStr
    if (alreadySent) continue

    out.push({
      deal_id: d.id,
      title: d.title,
      account_name: d.account_name,
      due: d.next_step_due,
      days_overdue: daysOverdue,
      level: escalate ? 'manager' : 'owner',
    })
  }
  return out.sort((a, b) => b.days_overdue - a.days_overdue)
}
