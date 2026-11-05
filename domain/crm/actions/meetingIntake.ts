'use server'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { tryRequireUser, AUTH_ERROR_MESSAGE } from '@/lib/auth/requireUser'
import { canCurrentUserSeeSales } from '@/lib/queries/access'
import { assignQueuedNote, discardQueuedNote } from '@/domain/crm/meetingIntakeService'

// Fronta „Nespárované zápisy" (/schuzky/nesparovane): ruční přiřazení zápisu
// z diktátu ke klientovi, nebo zahození. Obě akce zapisují přes servisní klíč
// (RLS obchází), proto si každá sama ověřuje přihlášení s AAL2 a obchodní roli.
// Text zápisu se do odpovědi ani do logu nedostane.

export type MeetingNoteActionResult = { success: boolean; error?: string }

const noteId = z.coerce.number().int().positive('Neplatný zápis.')
const assignSchema = z.object({
  note_id: noteId,
  account_id: z.coerce.number().int().positive('Vyber klienta ze seznamu.'),
})
const discardSchema = z.object({ note_id: noteId })

function refresh() {
  revalidatePath('/cockpit/schuzky/nesparovane')
  revalidatePath('/cockpit/schuzky')
  revalidatePath('/cockpit/nastaveni')
}

export async function assignMeetingNote(_prev: unknown, formData: FormData): Promise<MeetingNoteActionResult> {
  const parsed = assignSchema.safeParse(Object.fromEntries(formData.entries()))
  if (!parsed.success) return { success: false, error: parsed.error.issues[0]?.message ?? 'Neplatný vstup.' }

  const user = await tryRequireUser({ aal2: true })
  if (!user) return { success: false, error: AUTH_ERROR_MESSAGE }
  if (!(await canCurrentUserSeeSales())) return { success: false, error: 'Nemáš oprávnění.' }

  const result = await assignQueuedNote({
    noteId: parsed.data.note_id,
    accountId: parsed.data.account_id,
    userId: user.id,
  })
  if (!result.ok) return { success: false, error: result.error }
  refresh()
  return { success: true }
}

export async function discardMeetingNote(_prev: unknown, formData: FormData): Promise<MeetingNoteActionResult> {
  const parsed = discardSchema.safeParse(Object.fromEntries(formData.entries()))
  if (!parsed.success) return { success: false, error: parsed.error.issues[0]?.message ?? 'Neplatný vstup.' }

  const user = await tryRequireUser({ aal2: true })
  if (!user) return { success: false, error: AUTH_ERROR_MESSAGE }
  if (!(await canCurrentUserSeeSales())) return { success: false, error: 'Nemáš oprávnění.' }

  const result = await discardQueuedNote({ noteId: parsed.data.note_id, userId: user.id })
  if (!result.ok) return { success: false, error: result.error }
  refresh()
  return { success: true }
}
