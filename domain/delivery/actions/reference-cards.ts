'use server'
import { AUTH_ERROR_MESSAGE, tryRequireUser } from '@/lib/auth/requireUser'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { referenceCardSchema, areEntityIds } from '@/lib/validation/schemas'
import { type ActionResult, dbErrorMessage } from '@/lib/actionResult'
import type { ZodError } from 'zod'
function fe(err: ZodError){const o:Record<string,string>={};for(const i of err.issues){const k=String(i.path[0]??'_');if(!o[k])o[k]=i.message}return o}
export async function createReferenceCard(accountId: number, engagementId: number, _prev: unknown, formData: FormData): Promise<ActionResult> {
  if (!await tryRequireUser({ aal2: true })) return { success: false, error: AUTH_ERROR_MESSAGE }
  if (!areEntityIds(accountId, engagementId)) return { success: false, error: 'Neplatné ID.' }
  const p = referenceCardSchema.safeParse({ ...Object.fromEntries(formData.entries()), account_id: accountId, engagement_id: engagementId })
  if (!p.success) return { success: false, fieldErrors: fe(p.error) }
  const s = await createClient()
  // Nová karta je vždy neschválená: souhlas se dokládá zvlášť
  // (recordReferenceConsent, CHECK reference_card_consent_check v 0061).
  const { error } = await s.from('reference_card').insert({ ...p.data, approved_public: false })
  if (error) return { success: false, error: dbErrorMessage('action.reference-cards', error) }
  revalidatePath(`/cockpit/clients/${accountId}`); return { success: true }
}
