'use server'
import { AUTH_ERROR_MESSAGE, tryRequireUser } from '@/lib/auth/requireUser'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { dealPartnerSchema, areEntityIds } from '@/lib/validation/schemas'
import { type ActionResult, dbErrorMessage } from '@/lib/actionResult'
import type { ZodError } from 'zod'
function fe(err: ZodError){const o:Record<string,string>={};for(const i of err.issues){const k=String(i.path[0]??'_');if(!o[k])o[k]=i.message}return o}
export async function addDealPartner(accountId: number, dealId: number, _prev: unknown, formData: FormData): Promise<ActionResult> {
  if (!await tryRequireUser({ aal2: true })) return { success: false, error: AUTH_ERROR_MESSAGE }
  if (!areEntityIds(accountId, dealId)) return { success: false, error: 'Neplatné ID.' }
  const p = dealPartnerSchema.safeParse({ ...Object.fromEntries(formData.entries()), deal_id: dealId })
  if (!p.success) return { success: false, fieldErrors: fe(p.error) }
  const s = await createClient()
  const { error } = await s.from('deal_partner').insert(p.data)
  if (error) return { success: false, error: dbErrorMessage('action.deal-partners', error) }
  revalidatePath(`/cockpit/clients/${accountId}`); return { success: true }
}
