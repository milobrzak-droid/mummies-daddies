'use server'
// Server Action: rozhodnutí člověka o návrhu pracovního případu
// (case_proposal, migrace 0067; kapitola 11 — „příchozí e-mail vytvoří
// doložený návrh pracovního případu a člověk ho schválí").
//
// Tým nemá na case_proposal zápis (RLS SELECT-only). Přijetí i zamítnutí
// jde přes SECURITY DEFINER RPC, které razítkují aktéra z auth.uid()
// a vynucují AAL2 (loop_actor). Přijetí atomicky založí případ, kroky
// a doložené rozhodnutí; tady se k tomu jen zapíše audit s původem:
// evidence návrhu + stav údaje 'human_confirmed' (člověk potvrdil návrh AI).
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { AUTH_ERROR_MESSAGE, tryRequireUser } from '@/lib/auth/requireUser'
import { createClient } from '@/lib/supabase/server'
import { type ActionResult, dbErrorMessage } from '@/lib/actionResult'
import { recordAudit } from '@/core/audit'
import { loopGuardErrorMessage } from '@/core/loopQueries'
import { loopRpcErrorMessage } from '@/core/workCaseFlow'
import {
  PROPOSAL_ALREADY_DECIDED_MESSAGE,
  decideProposalSchema,
  proposalErrorMessage,
} from '@/core/agents/caseProposal'

type DbErr = { code?: string | null; message?: string | null } | null

const fail = (error: string): ActionResult => ({ success: false, error })

function errorResult(scope: string, err: DbErr): ActionResult {
  return fail(proposalErrorMessage(err) ?? loopGuardErrorMessage(err) ?? loopRpcErrorMessage(err) ?? dbErrorMessage(scope, err))
}

export async function decideCaseProposal(_prev: unknown, formData: FormData): Promise<ActionResult> {
  const user = await tryRequireUser({ aal2: true })
  if (!user) return fail(AUTH_ERROR_MESSAGE)
  const parsed = decideProposalSchema.safeParse(Object.fromEntries(formData.entries()))
  if (!parsed.success) return fail('Neplatný požadavek. Obnovte stránku.')
  const { proposal_id, accept, note } = parsed.data
  const s = await createClient()

  // Stav a doklad návrhu: srozumitelná hláška dřív než RPC a evidence pro audit.
  const { data, error } = await s
    .from('case_proposal')
    .select('id, status, evidence_id')
    .eq('id', proposal_id)
    .maybeSingle()
  if (error) return errorResult('action.caseProposal.load', error)
  const proposal = data as { status: string; evidence_id: number | null } | null
  if (!proposal) return fail('Návrh nebyl nalezen.')
  if (proposal.status !== 'pending') return fail(PROPOSAL_ALREADY_DECIDED_MESSAGE)
  const actor = { type: 'user' as const, id: user.id }

  if (accept === '1') {
    const { data: created, error: rpcErr } = await s.rpc('accept_case_proposal', { p_proposal_id: proposal_id })
    if (rpcErr) return errorResult('action.caseProposal.accept', rpcErr)
    const caseId = Number(created)
    if (!Number.isInteger(caseId) || caseId <= 0) return fail('Případ se nepodařilo založit. Obnovte stránku.')
    await recordAudit(
      'work_case',
      caseId,
      'case_proposal.accepted',
      { proposal_id, status: 'pending' },
      { proposal_id, status: 'accepted', work_case_id: caseId },
      actor,
      { evidenceId: proposal.evidence_id, infoState: 'human_confirmed' },
    )
    revalidatePath('/cockpit/pripady')
    revalidatePath('/cockpit/rozhodnuti')
    redirect(`/cockpit/pripady/${caseId}`)
  }

  const { error: rejectErr } = await s.rpc('reject_case_proposal', { p_proposal_id: proposal_id, p_note: note })
  if (rejectErr) return errorResult('action.caseProposal.reject', rejectErr)
  // Poznámku audit nenese (může obsahovat osobní údaje); zůstává u návrhu.
  await recordAudit(
    'case_proposal',
    proposal_id,
    'case_proposal.rejected',
    { status: 'pending' },
    { status: 'rejected', with_note: note !== null },
    actor,
    { evidenceId: proposal.evidence_id },
  )
  revalidatePath('/cockpit/pripady')
  return { success: true }
}
