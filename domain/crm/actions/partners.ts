'use server'
import { AUTH_ERROR_MESSAGE, tryRequireUser } from '@/lib/auth/requireUser'
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { createClient } from '@/lib/supabase/server'
import { partnerSchema, partnerRegistrationSchema, areEntityIds } from '@/lib/validation/schemas'
import { type ActionResult, dbErrorMessage } from '@/lib/actionResult'
import type { ZodError } from 'zod'

function fe(err: ZodError): Record<string, string> {
  const o: Record<string, string> = {}
  for (const i of err.issues) {
    const k = String(i.path[0] ?? '_')
    if (!o[k]) o[k] = i.message
  }
  return o
}

// Checkboxes share name="roles" → read them all (formData.entries() would drop dupes).
function parsePartner(formData: FormData) {
  const raw = { ...Object.fromEntries(formData.entries()), roles: formData.getAll('roles') }
  const p = partnerSchema.safeParse(raw)
  if (!p.success) return { ok: false as const, error: p.error }
  // is_referrer zůstává v sync s rolemi (legacy sloupec).
  return { ok: true as const, row: { ...p.data, is_referrer: p.data.roles.includes('referrer') } }
}

export async function createPartner(_prev: unknown, formData: FormData): Promise<ActionResult> {
  if (!await tryRequireUser({ aal2: true })) return { success: false, error: AUTH_ERROR_MESSAGE }
  const p = parsePartner(formData)
  if (!p.ok) return { success: false, fieldErrors: fe(p.error) }
  const s = await createClient()
  const { error } = await s.from('partner').insert(p.row)
  if (error) return { success: false, error: dbErrorMessage('action.partners', error) }
  revalidatePath('/cockpit/partners')
  redirect('/cockpit/partners')
}

export async function updatePartner(id: number, _prev: unknown, formData: FormData): Promise<ActionResult> {
  if (!await tryRequireUser({ aal2: true })) return { success: false, error: AUTH_ERROR_MESSAGE }
  if (!areEntityIds(id)) return { success: false, error: 'Neplatné ID.' }
  const p = parsePartner(formData)
  if (!p.ok) return { success: false, fieldErrors: fe(p.error) }
  const s = await createClient()
  const { error } = await s.from('partner').update(p.row).eq('id', id)
  if (error) return { success: false, error: dbErrorMessage('action.partners', error) }
  revalidatePath('/cockpit/partners')
  redirect('/cockpit/partners')
}

export async function addRegistration(partnerId: number, _prev: unknown, formData: FormData): Promise<ActionResult> {
  if (!await tryRequireUser({ aal2: true })) return { success: false, error: AUTH_ERROR_MESSAGE }
  if (!areEntityIds(partnerId)) return { success: false, error: 'Neplatné ID.' }
  const p = partnerRegistrationSchema.safeParse({ ...Object.fromEntries(formData.entries()), partner_id: partnerId })
  if (!p.success) return { success: false, fieldErrors: fe(p.error) }
  const s = await createClient()
  const { error } = await s.from('partner_registration').insert(p.data)
  if (error) return { success: false, error: dbErrorMessage('action.partners', error) }
  revalidatePath('/cockpit/partners')
  return { success: true }
}
