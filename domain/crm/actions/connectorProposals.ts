'use server'
import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { tryRequireUser, AUTH_ERROR_MESSAGE } from '@/lib/auth/requireUser'
import { getCurrentMember } from '@/lib/queries/currentMember'
import { APPROVER_REQUIRED, PROPOSAL_TEXT_LIMITS, blocksBulkApprove, canApproveConnectorProposals } from '@/domain/crm/connectorProposals'
import {
  approveConnectorBatch, approveConnectorProposal, approveEditsSchema, rejectConnectorProposal,
} from '@/domain/crm/connectorProposalService'

// Schválení návrhů zakázek z konektoru (Claude) na /rozhodnuti. Zápis jde přes
// servisní klíč (RLS obchází), proto každá akce sama ověří přihlášení s 2FA
// a roli vedení/admin s přístupem k obchodu (canApproveConnectorProposals).
// Hodnoty z formuláře projdou schématem; návrh (klient, zdroj) se čte
// z databáze, ne z prohlížeče.

export type ConnectorActionState =
  | { ok: true; message: string; accountId?: number; dealId?: number; warnings?: string[] }
  | { ok: false; error: string }
  | null

async function approver(): Promise<{ id: string } | { error: string }> {
  const user = await tryRequireUser({ aal2: true })
  if (!user) return { error: AUTH_ERROR_MESSAGE }
  const { member } = await getCurrentMember()
  if (!canApproveConnectorProposals(member)) return { error: APPROVER_REQUIRED }
  return { id: user.id }
}

function refresh() {
  revalidatePath('/cockpit/rozhodnuti')
  revalidatePath('/cockpit')
  revalidatePath('/cockpit/pipeline')
  revalidatePath('/cockpit/clients')
}

export async function approveConnectorProposalAction(_prev: unknown, formData: FormData): Promise<ConnectorActionState> {
  const who = await approver()
  if ('error' in who) return { ok: false, error: who.error }
  const raw = Object.fromEntries(formData.entries())
  // Klient vybraný v našeptávači má přednost před kandidáty.
  if (typeof raw.account_pick === 'string' && /^[1-9]\d{0,17}$/.test(raw.account_pick)) raw.account_choice = `id:${raw.account_pick}`
  const parsed = approveEditsSchema.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    return { ok: false, error: `${issue?.path.join('.') ? `${issue.path.join('.')}: ` : ''}${issue?.message ?? 'Neplatný vstup.'}` }
  }
  const res = await approveConnectorProposal(parsed.data, who.id)
  if (!res.ok) return { ok: false, error: res.error }
  refresh()
  const d = res.data
  const message = d.outcome === 'created'
    ? `Založeno: ${d.title}`
    : d.outcome === 'updated' ? `Obchod aktualizován: ${d.title}` : 'Návrh už byl schválený dřív — nic nového nevzniklo.'
  return { ok: true, message, accountId: d.accountId, dealId: d.dealId, warnings: d.warnings }
}

const rejectSchema = z.object({
  row_id: z.coerce.number().int().positive(),
  note: z.string().trim().max(PROPOSAL_TEXT_LIMITS.reason, `Důvod může mít nejvýš ${PROPOSAL_TEXT_LIMITS.reason} znaků.`).optional(),
})

export async function rejectConnectorProposalAction(_prev: unknown, formData: FormData): Promise<ConnectorActionState> {
  const who = await approver()
  if ('error' in who) return { ok: false, error: who.error }
  const parsed = rejectSchema.safeParse(Object.fromEntries(formData.entries()))
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? 'Neplatný vstup.' }
  const res = await rejectConnectorProposal(parsed.data.row_id, parsed.data.note || null, who.id)
  if (!res.ok) return { ok: false, error: res.error }
  refresh()
  return { ok: true, message: res.data.reasonSaved || !parsed.data.note ? 'Zamítnuto.' : 'Zamítnuto (důvod se uloží až po migraci 0101).' }
}

const batchSchema = z.object({ batch_id: z.string().trim().min(1).max(64) })

export async function approveConnectorBatchAction(_prev: unknown, formData: FormData): Promise<ConnectorActionState> {
  const who = await approver()
  if ('error' in who) return { ok: false, error: who.error }
  const parsed = batchSchema.safeParse(Object.fromEntries(formData.entries()))
  if (!parsed.success) return { ok: false, error: 'Neplatná dávka.' }
  const res = await approveConnectorBatch(parsed.data.batch_id, who.id, blocksBulkApprove)
  if (!res.ok) return { ok: false, error: res.error }
  refresh()
  const { approved, skipped, failed } = res.data
  return {
    ok: true,
    message: `Schváleno ${approved}.${skipped ? ` S varováním čeká ${skipped} — projdi je po jednom.` : ''}${failed ? ` Nepovedlo se ${failed}.` : ''}`,
  }
}
