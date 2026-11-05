'use server'
import { AUTH_ERROR_MESSAGE, requireUser, tryRequireUser } from '@/lib/auth/requireUser'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { subscriptionSchema, areEntityIds } from '@/lib/validation/schemas'
import { type ActionResult, dbErrorMessage } from '@/lib/actionResult'
import type { ZodError } from 'zod'
import { pragueToday } from '@/lib/pragueDate'
import { getCurrentMember, memberSeesSales } from '@/lib/queries/currentMember'

// Předplatné nese MRR — od 0058 (RESTRICTIVE sales_only) ho čte a zapisuje
// jen obchodní role. Kontrola tady dává srozumitelnou hlášku dřív, než by
// zápis tiše skončil na RLS (INSERT 42501, UPDATE 0 řádků).
const SALES_ACCESS_ERROR = 'Předplatné může upravovat jen člen s přístupem k obchodu.'
async function seesSales(): Promise<boolean> {
  return memberSeesSales((await getCurrentMember()).member)
}

function fieldErrorsOf(err: ZodError): Record<string, string> {
  const out: Record<string, string> = {}
  for (const i of err.issues) { const k = String(i.path[0] ?? '_'); if (!out[k]) out[k] = i.message }
  return out
}

// Deal (pokud je vybraný) musí patřit stejnému klientovi jako předplatné —
// jinak by cizí deal_id tiše přisoudil MRR jinému účtu, než ukazuje UI
// (stejná obava jako u contactBelongsToAccount v domain/crm/actions/deals.ts).
async function dealBelongsToAccount(
  s: Awaited<ReturnType<typeof createClient>>,
  dealId: number | null,
  accountId: number,
): Promise<boolean> {
  if (!dealId) return true
  const { data } = await s.from('deal').select('account_id').eq('id', dealId).maybeSingle()
  return data?.account_id === accountId
}

export async function createSubscription(accountId: number, _prev: unknown, formData: FormData): Promise<ActionResult> {
  if (!await tryRequireUser({ aal2: true })) return { success: false, error: AUTH_ERROR_MESSAGE }
  if (!areEntityIds(accountId)) return { success: false, error: 'Neplatné ID.' }
  const parsed = subscriptionSchema.safeParse({ ...Object.fromEntries(formData.entries()), account_id: accountId })
  if (!parsed.success) return { success: false, fieldErrors: fieldErrorsOf(parsed.error) }
  if (!await seesSales()) return { success: false, error: SALES_ACCESS_ERROR }
  const s = await createClient()
  if (!await dealBelongsToAccount(s, parsed.data.deal_id, accountId)) {
    return { success: false, fieldErrors: { deal_id: 'Obchod nepatří tomuto klientovi.' } }
  }
  const { error } = await s.from('subscription').insert(parsed.data)
  if (error) return { success: false, error: dbErrorMessage('action.subscriptions', error) }
  revalidatePath(`/cockpit/clients/${accountId}`)
  return { success: true }
}

// Úprava předplatného. Chyběla: špatně zadané MRR, počet licencí nebo datum
// obnovy nešlo opravit, riziko odchodu zvýšit a odchod klienta zaznamenat.
// Opakované příjmy tak neměly v aplikaci žádný životní cyklus — jen vznik.
export async function updateSubscription(
  accountId: number,
  subscriptionId: number,
  _prev: unknown,
  formData: FormData,
): Promise<ActionResult> {
  if (!await tryRequireUser({ aal2: true })) return { success: false, error: AUTH_ERROR_MESSAGE }
  if (!areEntityIds(accountId, subscriptionId)) return { success: false, error: 'Neplatné ID.' }
  const parsed = subscriptionSchema.safeParse({ ...Object.fromEntries(formData.entries()), account_id: accountId })
  if (!parsed.success) return { success: false, fieldErrors: fieldErrorsOf(parsed.error) }
  if (!await seesSales()) return { success: false, error: SALES_ACCESS_ERROR }
  const s = await createClient()
  if (!await dealBelongsToAccount(s, parsed.data.deal_id, accountId)) {
    return { success: false, fieldErrors: { deal_id: 'Obchod nepatří tomuto klientovi.' } }
  }
  const { error } = await s.from('subscription')
    .update(parsed.data)
    .eq('id', subscriptionId)
    .eq('account_id', accountId)
  if (error) return { success: false, error: dbErrorMessage('action.subscriptions', error) }
  revalidatePath(`/cockpit/clients/${accountId}`)
  return { success: true }
}

// Ukončení předplatného. Řádek se schválně nemaže: historie MRR je součást
// obchodního záznamu a smazáním by se zpětně změnily už vykázané měsíce.
// Ukončené předplatné se přestane počítat do běžícího MRR díky ended_on.
export async function endSubscription(accountId: number, subscriptionId: number): Promise<void> {
  await requireUser({ aal2: true })
  if (!areEntityIds(accountId, subscriptionId)) return
  if (!await seesSales()) throw new Error(SALES_ACCESS_ERROR)
  const s = await createClient()
  await s.from('subscription')
    .update({ ended_on: pragueToday() }) // DATE → pražský den
    .eq('id', subscriptionId)
    .eq('account_id', accountId)
  revalidatePath(`/cockpit/clients/${accountId}`)
}
