'use server'
// „Připomenout klientovi" u milníku, který čeká na klienta (hlídání čekání).
//
// Založí ÚKOL s hotovým návrhem e-mailu v popisu. Nic se klientovi
// neodesílá: e-mail (externí závazek) zůstává na člověku, který návrh přečte,
// upraví a pošle sám (kap. 8 cílové architektury: žádné automatické
// odesílání externích zpráv). Akce jde přes uživatelského klienta (RLS + AAL2)
// a nesahá na admin klienta.
//
// Milník a jeho čekání se znovu načtou ze serveru (getWaitingItems) — z
// formuláře se nevěří ničemu kromě dvou id. Idempotence: otevřený úkol se
// stejným názvem u téže dodávky se nezakládá podruhé.
import { revalidatePath } from 'next/cache'
import { AUTH_ERROR_MESSAGE, tryRequireUser } from '@/lib/auth/requireUser'
import { createClient } from '@/lib/supabase/server'
import { areEntityIds } from '@/lib/validation/schemas'
import { type ActionResult, dbErrorMessage } from '@/lib/actionResult'
import { pragueToday } from '@/lib/pragueDate'
import { getWaitingItems } from '@/domain/delivery/queries/waiting'
import {
  reminderDraft,
  reminderTaskDescription,
  reminderTaskTitle,
} from '@/domain/delivery/waiting'

export type ReminderResult = ActionResult & { note?: string }

export async function createReminderTask(engagementId: number, milestoneId: number): Promise<ReminderResult> {
  const user = await tryRequireUser({ aal2: true })
  if (!user) return { success: false, error: AUTH_ERROR_MESSAGE }
  if (!areEntityIds(engagementId, milestoneId)) return { success: false, error: 'Neplatný milník.' }

  const loaded = await getWaitingItems({ engagementId })
  if (loaded.state === 'missing_migration') return { success: false, error: 'Milníky ještě nejsou dostupné — čekají na migraci 0042.' }
  if (loaded.state === 'error') return { success: false, error: 'Nepodařilo se načíst milník. Zkuste to prosím znovu.' }

  // Milník musí patřit k dodávce z požadavku (dotaz je zúžený, tohle je pojistka).
  const item = loaded.items.find((i) => i.milestoneId === milestoneId && i.engagementId === engagementId)
  if (!item) {
    return { success: false, error: 'Tenhle milník už na klienta nečeká. Obnov stránku.' }
  }
  if (item.reminderOpen) {
    return { success: true, note: 'Úkol s připomínkou už existuje. Najdeš ho v Úkolech.' }
  }

  const draft = reminderDraft(item)
  const s = await createClient()
  const { error } = await s.from('task').insert({
    title: reminderTaskTitle(item.title),
    description: reminderTaskDescription(draft, item),
    status: 'todo',
    priority: item.signals.includes('overdue') ? 'high' : 'normal',
    // Odpovídá ten, kdo milník vlastní; bez vlastníka ten, kdo klikl.
    assignee_id: item.ownerId ?? user.id,
    due_on: pragueToday(),
    account_id: item.accountId,
    engagement_id: item.engagementId,
    created_by: user.id,
  })
  if (error) return { success: false, error: dbErrorMessage('action.waiting.reminder', error) }

  revalidatePath('/cockpit')
  revalidatePath('/cockpit/tasks')
  revalidatePath(`/cockpit/clients/${item.accountId}/engagements/${item.engagementId}/edit`)
  return { success: true, note: 'Úkol s návrhem e-mailu je založený. Najdeš ho v Úkolech.' }
}
