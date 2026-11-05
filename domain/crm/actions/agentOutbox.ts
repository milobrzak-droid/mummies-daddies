'use server'
// Uvolnění zprávy odchozí fronty agenta člověkem (balík P3, RPC
// agent_outbox_release z 0104): doptání nebo připomínka čekající na
// schválení, selhaná zpráva, nebo nejistá zpráva s výslovným potvrzením,
// že v Odeslané poště není. Nabídka se schvaluje jen v Ke schválení
// (žádost send_offer). Odešle ji až další běh úlohy agent-outbox.
//
// Oprávnění hlídá SQL (obchodní role, AAL2); tady jen přihlášení s AAL2
// a validace vstupu. Tlačítko v Cockpitu (stránka /cockpit/agent) dodá P5.
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { AUTH_ERROR_MESSAGE, tryRequireUser } from '@/lib/auth/requireUser'
import { createClient } from '@/lib/supabase/server'
import { type ActionResult, dbErrorMessage } from '@/lib/actionResult'

const releaseSchema = z.object({
  outboxId: z.coerce.number().int().positive(),
  confirmNotSent: z.preprocess((v) => v === true || v === 'true' || v === 'on', z.boolean()).default(false),
})

export async function releaseOutboxMessage(_prev: unknown, formData: FormData): Promise<ActionResult> {
  if (!await tryRequireUser({ aal2: true })) return { success: false, error: AUTH_ERROR_MESSAGE }
  const parsed = releaseSchema.safeParse(Object.fromEntries(formData.entries()))
  if (!parsed.success) return { success: false, error: 'Neplatná zpráva fronty.' }
  const s = await createClient()
  const { error } = await s.rpc('agent_outbox_release', { p_id: parsed.data.outboxId, p_confirm_not_sent: parsed.data.confirmNotSent })
  if (error) {
    // Hlášky z RPC (0104) jsou psané pro člověka a nenesou osobní údaje.
    if (error.code === '22023' || error.code === '42501' || error.code === 'P0002') return { success: false, error: error.message }
    return { success: false, error: dbErrorMessage('action.agentOutbox.release', error) }
  }
  revalidatePath('/cockpit/agent')
  return { success: true }
}
