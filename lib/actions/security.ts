'use server'
import { AUTH_ERROR_MESSAGE, tryRequireUser } from '@/lib/auth/requireUser'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { type ActionResult, dbErrorMessage } from '@/lib/actionResult'
import { displayNameSchema } from '@/lib/validation/schemas'
import type { ZodError } from 'zod'

function fieldErrorsOf(err: ZodError): Record<string, string> {
  const out: Record<string, string> = {}
  for (const i of err.issues) {
    const k = String(i.path[0] ?? '_')
    if (!out[k]) out[k] = i.message
  }
  return out
}

// Vlastní zobrazované jméno — každý si ho může nastavit sám na /nastaveni
// (na rozdíl od jmen ostatních, které mění jen admin na /tym).
export async function updateMyDisplayName(_prev: unknown, formData: FormData): Promise<ActionResult> {
  const user = await tryRequireUser({ aal2: true, allowExternal: true })
  if (!user) return { success: false, error: AUTH_ERROR_MESSAGE }

  const parsed = displayNameSchema.safeParse(Object.fromEntries(formData.entries()))
  if (!parsed.success) return { success: false, fieldErrors: fieldErrorsOf(parsed.error) }

  // Admin klient: uživatelská session nemá na team_member žádné oprávnění
  // k zápisu (RLS politika team_self byla odstraněna, viz migrace 0069 —
  // seděla by na ní i libovolná jiná změna než vlastního full_name). id je
  // vlastní tryRequireUser, ne z formuláře, takže je bezpečné ho tu použít.
  const admin = createAdminClient()
  const { error } = await admin.from('team_member').update({ full_name: parsed.data.full_name }).eq('id', user.id)
  if (error) return { success: false, error: dbErrorMessage('action.security', error) }
  revalidatePath('/cockpit/nastaveni')
  revalidatePath('/cockpit')
  return { success: true }
}

// Lets a logged-in user set their own password. The user types it — the app
// never generates or stores it in plaintext beyond handing it to Supabase Auth.
export async function updateMyPassword(_prev: unknown, formData: FormData): Promise<ActionResult> {
  if (!await tryRequireUser({ aal2: true, allowExternal: true })) return { success: false, error: AUTH_ERROR_MESSAGE }
  const password = String(formData.get('password') ?? '')
  const confirm = String(formData.get('confirm') ?? '')
  if (password.length < 8) return { success: false, error: 'Heslo musí mít aspoň 8 znaků.' }
  if (password !== confirm) return { success: false, error: 'Hesla se neshodují.' }
  const s = await createClient()
  const { error } = await s.auth.updateUser({ password })
  if (error) return { success: false, error: dbErrorMessage('action.security', error) }
  revalidatePath('/cockpit/nastaveni')
  return { success: true }
}
