'use server'
// Rozhodnutí CSO nad signály a oslovením (P7) — RPC outbound_review (0107)
// ověří obchodní roli i AAL2 v databázi. Nic odsud neodesílá e-mail:
// schválený koncept zařadí do fronty až úloha outbound-agent.
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireUser } from '@/lib/auth/requireUser'
import { createClient } from '@/lib/supabase/server'
import { entityId } from '@/lib/validation/schemas'

const signalAction = z.enum(['create_lead', 'dismiss', 'reopen'])
const outreachAction = z.enum(['approve', 'reject', 'done', 'opt_out'])

export type ReviewResult = { ok: boolean; message: string }

const MESSAGES: Record<string, string> = {
  create_lead: 'Lead je v CRM.',
  dismiss: 'Signál je odložený.',
  reopen: 'Signál je znovu ke kontrole.',
  approve: 'Schváleno — e-mail odejde v nejbližším okně odesílání.',
  reject: 'Oslovení zamítnuto.',
  done: 'Zapsáno jako osloveno.',
  opt_out: 'Adresa je odhlášená, kontakt nesouhlasí s oslovením.',
}

async function call(target: 'signal' | 'outreach', id: number, action: string): Promise<ReviewResult> {
  await requireUser({ aal2: true })
  const s = await createClient()
  const { data, error } = await s.rpc('outbound_review', { p: { target, id, action } })
  revalidatePath('/cockpit/signaly')
  if (error) {
    if (/OS422/.test(error.message ?? '')) return { ok: false, message: 'Signál nemá firmu — založte klienta ručně.' }
    if (/OS409/.test(error.message ?? '')) return { ok: false, message: 'Signál je zablokovaný (vyloučená firma nebo nesouhlas s oslovením).' }
    return { ok: false, message: 'Akce se nepovedla. Zkuste to znovu.' }
  }
  const r = (data ?? {}) as { ok?: boolean; deal_id?: number }
  const ok = r.ok !== false
  return { ok, message: ok ? MESSAGES[action] : 'Stav se mezitím změnil — obnovte stránku.' }
}

export async function reviewSignal(id: number, action: string): Promise<ReviewResult> {
  if (!entityId.safeParse(id).success || !signalAction.safeParse(action).success) return { ok: false, message: 'Neplatná akce.' }
  return call('signal', id, action)
}

export async function reviewOutreach(id: number, action: string): Promise<ReviewResult> {
  if (!entityId.safeParse(id).success || !outreachAction.safeParse(action).success) return { ok: false, message: 'Neplatná akce.' }
  return call('outreach', id, action)
}
