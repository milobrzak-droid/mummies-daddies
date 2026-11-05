'use server'
// Server Actions schválení napojeného na akci (Loop Core, migrace 0084).
//
// Tým na approval_request nezapisuje (RLS SELECT-only, 0039). Typovaná žádost,
// odložení i zopakování provedení jdou výhradně přes SECURITY DEFINER RPC
// (request_action_approval, snooze_approval, retry_approval_execution), které
// razítkují aktéra z auth.uid() a samy ověří cíl, parametry a pravomoc. Tady se
// jen čte vstup, dává srozumitelná věta předem a překládají chyby. Provedení
// po schválení dělá databáze ve stejné transakci jako rozhodnutí
// (decide_approval → approval_execute), žádný kód tady.
import { revalidatePath } from 'next/cache'
import type { ZodError } from 'zod'
import { AUTH_ERROR_MESSAGE, tryRequireUser } from '@/lib/auth/requireUser'
import { createClient } from '@/lib/supabase/server'
import { type ActionResult, dbErrorMessage } from '@/lib/actionResult'
import { pragueToday } from '@/lib/pragueDate'
import { isMissingColumn, isMissingRelation, loopGuardErrorMessage } from '@/core/loopQueries'
import { MIGRATION_PENDING_MESSAGE, loopRpcErrorMessage, pragueDayEnd } from '@/core/workCaseFlow'
import { isCaseStatus, isTerminalCase } from '@/core/workCase'
import { APPROVAL_ACTION_PENDING_MESSAGE, approvalActionErrorMessage, snoozeUntil } from '@/core/approvalActions'
import { requestNextStepSchema, retryExecutionSchema, snoozeApprovalSchema } from '@/core/workCaseSchemas'

type DbErr = { code?: string | null; message?: string | null } | null

const fail = (error: string): ActionResult => ({ success: false, error })

function fieldErrorsOf(err: ZodError): Record<string, string> {
  const out: Record<string, string> = {}
  for (const i of err.issues) {
    const k = String(i.path[0] ?? '_')
    if (!out[k]) out[k] = i.message
  }
  return out
}

function errorResult(scope: string, err: DbErr): ActionResult {
  if (isMissingRelation(err)) return fail(MIGRATION_PENDING_MESSAGE)
  return fail(
    approvalActionErrorMessage(err) ?? loopGuardErrorMessage(err) ?? loopRpcErrorMessage(err) ?? dbErrorMessage(scope, err),
  )
}

function revalidateApprovals(caseId: number | null) {
  revalidatePath('/cockpit/rozhodnuti')
  if (caseId) revalidatePath(`/cockpit/pripady/${caseId}`)
}

/** „Navrhnout další krok ke schválení" z detailu případu (confirm_next_step). */
export async function requestNextStepApproval(_prev: unknown, formData: FormData): Promise<ActionResult> {
  if (!await tryRequireUser({ aal2: true })) return fail(AUTH_ERROR_MESSAGE)
  const parsed = requestNextStepSchema.safeParse(Object.fromEntries(formData.entries()))
  if (!parsed.success) return { success: false, fieldErrors: fieldErrorsOf(parsed.error) }
  const { case_id, title, assignee_id, due_on, decision_id, expires_on } = parsed.data
  if (due_on < pragueToday()) return { success: false, fieldErrors: { due_on: 'Termín nesmí být v minulosti.' } }

  const s = await createClient()
  const { data, error } = await s.from('work_case').select('id, status').eq('id', case_id).maybeSingle()
  if (error) return errorResult('action.approval.nextStep.case', error)
  const row = data as { status: string } | null
  if (!row) return fail('Případ nebyl nalezen.')
  if (isCaseStatus(row.status) && isTerminalCase(row.status)) return fail('Případ je uzavřený, další krok už se nenavrhuje.')

  const expiresAt = expires_on ? pragueDayEnd(expires_on) : null
  const { error: rpcErr } = await s.rpc('request_action_approval', {
    p_action_type: 'confirm_next_step',
    p_target_id: case_id,
    p_params: { title, assignee_id, due_on, decision_id },
    p_expires_at: expiresAt ? expiresAt.toISOString() : null,
  })
  if (rpcErr) return errorResult('action.approval.nextStep', rpcErr)
  revalidateApprovals(case_id)
  return { success: true }
}

/** „Odložit do…" / „Vrátit" — uloží se na žádost, vidí to všichni. */
export async function snoozeApprovalRequest(_prev: unknown, formData: FormData): Promise<ActionResult> {
  if (!await tryRequireUser({ aal2: true })) return fail(AUTH_ERROR_MESSAGE)
  const parsed = snoozeApprovalSchema.safeParse(Object.fromEntries(formData.entries()))
  if (!parsed.success) return fail('Neplatný požadavek. Obnovte stránku.')
  const { request_id, choice } = parsed.data
  const s = await createClient()
  const { data, error } = await s
    .from('approval_request')
    .select('id, case_id, status, expires_at, snoozed_until')
    .eq('id', request_id)
    .maybeSingle()
  if (isMissingColumn(error)) return fail(APPROVAL_ACTION_PENDING_MESSAGE)
  if (error) return errorResult('action.approval.snooze.load', error)
  const req = data as { case_id: number | null; status: string; expires_at: string | null } | null
  if (!req) return fail('Požadavek nebyl nalezen.')
  if (req.status !== 'pending') return fail('O požadavku už bylo rozhodnuto.')
  const until = snoozeUntil(choice, new Date(), req.expires_at)
  if (choice !== 'vratit' && until === null) return fail('Žádost brzy vyprší, odložit už nejde. Rozhodni o ní.')
  const { error: rpcErr } = await s.rpc('snooze_approval', {
    p_request_id: request_id,
    p_until: until ? until.toISOString() : null,
  })
  if (rpcErr) return errorResult('action.approval.snooze', rpcErr)
  revalidateApprovals(req.case_id)
  return { success: true }
}

/** Zopakovat neúspěšné provedení (jen stav „Provedení selhalo"). */
export async function retryApprovalExecution(_prev: unknown, formData: FormData): Promise<ActionResult> {
  if (!await tryRequireUser({ aal2: true })) return fail(AUTH_ERROR_MESSAGE)
  const parsed = retryExecutionSchema.safeParse(Object.fromEntries(formData.entries()))
  if (!parsed.success) return fail('Neplatný požadavek. Obnovte stránku.')
  const { request_id } = parsed.data
  const s = await createClient()
  const { data, error } = await s.rpc('retry_approval_execution', { p_request_id: request_id })
  if (error) return errorResult('action.approval.retry', error)
  const { data: req } = await s.from('approval_request').select('case_id').eq('id', request_id).maybeSingle()
  revalidateApprovals((req as { case_id: number | null } | null)?.case_id ?? null)
  if (data === 'failed') return fail('Provedení se ani teď nepovedlo. Zkusí se znovu při denní kontrole.')
  return { success: true }
}
