'use server'
import { requireUser } from '@/lib/auth/requireUser'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { addDaysToPragueDay, pragueToday } from '@/lib/pragueDate'
import { entityId, outreachSnoozeDays } from '@/lib/validation/schemas'

// Prosté přepínače stavu, ne validovaný formulář — stejná konvence jako
// deleteContact v domain/crm/actions/contacts.ts: void návrat, žádný ActionResult.

// Vyřadí firmu z fronty na daný počet dní (typicky "řeší se jinde" nebo
// "ozvat se později"). snooze_until je datum, ne interval — dueForOutreach
// (domain/crm/outreach.ts) ho porovnává přímo s dnešním dnem.
export async function snoozeOutreach(accountId: number, days: number): Promise<void> {
  await requireUser({ aal2: true })
  // Neplatné id nebo počet dní (mimo 1–365) se tiše zahodí — stejně jako jiné
  // přepínače stavu s void návratem, bez dotazu do DB.
  if (!entityId.safeParse(accountId).success || !outreachSnoozeDays.safeParse(days).success) return
  const s = await createClient()
  const untilStr = addDaysToPragueDay(pragueToday(), days)
  await s.from('account').update({ snooze_until: untilStr }).eq('id', accountId)
  revalidatePath('/cockpit/oslovovani')
}

// Označí, že se dnes firma řešila — dueForOutreach ji tím vyřadí jen do
// konce DNEŠNÍHO dne (nudged_on === today), ne natrvalo. Zítra se znovu
// objeví, pokud mezitím nepřibude odchozí zpráva. Je to schválně stejně
// slabé jako domain/crm/outreach.ts to má otestované, ne nový, silnější mechanismus.
export async function markOutreachNudged(accountId: number): Promise<void> {
  await requireUser({ aal2: true })
  if (!entityId.safeParse(accountId).success) return
  const s = await createClient()
  const today = pragueToday()
  await s.from('account').update({ nudged_on: today }).eq('id', accountId)
  revalidatePath('/cockpit/oslovovani')
}
