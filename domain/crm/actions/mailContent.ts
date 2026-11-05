'use server'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { tryRequireUser, AUTH_ERROR_MESSAGE } from '@/lib/auth/requireUser'
import { canCurrentUserSeeSales } from '@/lib/queries/access'
import { assignQueuedMail, discardQueuedMail } from '@/domain/crm/mailContentService'

// Fronta „Pošta k zařazení" (/pripady?view=posta): ruční přiřazení zprávy ze
// složky „Cockpit" ke klientovi (a dodávce), nebo zahození. Obě akce zapisují
// přes servisní klíč (RLS obchází), proto si každá sama ověřuje přihlášení
// s AAL2 a obchodní roli. Výsledkem přiřazení je jen NÁVRH k potvrzení
// (Případy → Návrhy). Úryvek zprávy se do odpovědi ani do logu nedostane.

export type MailContentActionResult = { success: boolean; error?: string }

const rowId = z.coerce.number({ error: 'Neplatná zpráva.' }).int('Neplatná zpráva.').positive('Neplatná zpráva.')
const assignSchema = z.object({
  row_id: rowId,
  account_id: z.coerce.number({ error: 'Vyber klienta ze seznamu.' }).int('Vyber klienta ze seznamu.').positive('Vyber klienta ze seznamu.'),
  target: z.string().trim().max(40).optional(),
})
const discardSchema = z.object({ row_id: rowId })

function refresh() {
  revalidatePath('/cockpit/pripady')
  revalidatePath('/cockpit/nastaveni')
}

export async function assignMailContent(_prev: unknown, formData: FormData): Promise<MailContentActionResult> {
  const parsed = assignSchema.safeParse(Object.fromEntries(formData.entries()))
  if (!parsed.success) return { success: false, error: parsed.error.issues[0]?.message ?? 'Neplatný vstup.' }

  const user = await tryRequireUser({ aal2: true })
  if (!user) return { success: false, error: AUTH_ERROR_MESSAGE }
  if (!(await canCurrentUserSeeSales())) return { success: false, error: 'Nemáš oprávnění.' }

  const result = await assignQueuedMail({
    rowId: parsed.data.row_id,
    accountId: parsed.data.account_id,
    targetKey: parsed.data.target ?? null,
    userId: user.id,
  })
  if (!result.ok) return { success: false, error: result.error }
  refresh()
  return { success: true }
}

export async function discardMailContent(_prev: unknown, formData: FormData): Promise<MailContentActionResult> {
  const parsed = discardSchema.safeParse(Object.fromEntries(formData.entries()))
  if (!parsed.success) return { success: false, error: parsed.error.issues[0]?.message ?? 'Neplatný vstup.' }

  const user = await tryRequireUser({ aal2: true })
  if (!user) return { success: false, error: AUTH_ERROR_MESSAGE }
  if (!(await canCurrentUserSeeSales())) return { success: false, error: 'Nemáš oprávnění.' }

  const result = await discardQueuedMail({ rowId: parsed.data.row_id, userId: user.id })
  if (!result.ok) return { success: false, error: result.error }
  refresh()
  return { success: true }
}
