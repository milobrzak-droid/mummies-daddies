'use server'
import { AUTH_ERROR_MESSAGE, tryRequireUser } from '@/lib/auth/requireUser'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { engagementSchema, areEntityIds } from '@/lib/validation/schemas'
import { type ActionResult, dbErrorMessage } from '@/lib/actionResult'
import type { ZodError } from 'zod'

function fieldErrorsOf(err: ZodError): Record<string, string> {
  const out: Record<string, string> = {}
  for (const i of err.issues) { const k = String(i.path[0] ?? '_'); if (!out[k]) out[k] = i.message }
  return out
}
export async function createEngagement(accountId: number, _prev: unknown, formData: FormData): Promise<ActionResult> {
  if (!await tryRequireUser({ aal2: true })) return { success: false, error: AUTH_ERROR_MESSAGE }
  if (!areEntityIds(accountId)) return { success: false, error: 'Neplatné ID.' }
  const parsed = engagementSchema.safeParse({ ...Object.fromEntries(formData.entries()), account_id: accountId })
  if (!parsed.success) return { success: false, fieldErrors: fieldErrorsOf(parsed.error) }
  const s = await createClient()
  const { error } = await s.from('engagement').insert(parsed.data)
  if (error) return { success: false, error: dbErrorMessage('action.engagements', error) }
  revalidatePath(`/cockpit/clients/${accountId}`)
  redirect(`/cockpit/clients/${accountId}?view=project`)
}
export async function updateEngagement(accountId: number, engagementId: number, _prev: unknown, formData: FormData): Promise<ActionResult> {
  if (!await tryRequireUser({ aal2: true })) return { success: false, error: AUTH_ERROR_MESSAGE }
  if (!areEntityIds(accountId, engagementId)) return { success: false, error: 'Neplatné ID.' }
  const parsed = engagementSchema.safeParse({ ...Object.fromEntries(formData.entries()), account_id: accountId })
  if (!parsed.success) return { success: false, fieldErrors: fieldErrorsOf(parsed.error) }
  // Formulář dodávky odkaz na obchod nenese (vazbu nastavuje předání a od 0080
  // i automatické založení po vyhrání obchodu). Schéma ale chybějící pole
  // převádí na null, takže by každé uložení formuláře vazbu smazalo — a u
  // automaticky založené dodávky by obchod pak vypadal „bez dodávky".
  const { deal_id: dealFromForm, ...withoutDeal } = parsed.data
  const patch = formData.has('deal_id') ? { ...withoutDeal, deal_id: dealFromForm } : withoutDeal
  const s = await createClient()
  const { error } = await s.from('engagement').update(patch).eq('id', engagementId)
  if (error) return { success: false, error: dbErrorMessage('action.engagements', error) }
  revalidatePath(`/cockpit/clients/${accountId}`)
  redirect(`/cockpit/clients/${accountId}?view=project`)
}
