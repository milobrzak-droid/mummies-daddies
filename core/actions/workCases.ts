'use server'
// Server Actions pracovních případů (Loop Core, 0039).
//
// work_case a case_step tým zapisuje přímo (RLS FOR ALL + AAL2). Rozhodnutí
// a schvalování jdou VÝHRADNĚ přes SECURITY DEFINER RPC (request_approval,
// decide_approval, record_decision, resolve_decision), které razítkují
// aktéra z auth.uid(). Přechody stavů hlídají čisté funkce z core/workCase.ts
// a core/authority.ts ještě před zápisem; update navíc podmiňujeme původním
// stavem (.eq('status', from)), aby souběžná změna nepřepsala cizí krok.
//
// Kontrolu role (canActorApprove přes nodeRoleFor) děláme tady před voláním
// RPC kvůli srozumitelné hlášce; od migrace 0053 ji autoritativně vynucuje
// i decide_approval v SQL (42501 mapuje loopRpcErrorMessage). requested_level posíláme z authority_policy, ale
// server ho smí zvýšit — autoritativní je DB.
//
// Od migrace 0057 DB hlídá i přechody stavů, uzavření případu, změnu
// vlastníka/uzlu a autora (triggery, SQLSTATE LP001–LP007 → mapuje
// loopGuardErrorMessage). Schvalování rozhoduje podle uzlu zmrazeného
// v approval_request.node. Autora (created_by) doplní DB z auth.uid(),
// neposíláme ho. Mazat případ smí jen vedení a auditní stopa (rozhodnutí,
// schválení) mazání blokuje — kompenzace nepovedeného založení proto
// případ ruší (cancelled), nemaže.
import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import type { ZodError } from 'zod'
import { AUTH_ERROR_MESSAGE, tryRequireUser } from '@/lib/auth/requireUser'
import { createClient } from '@/lib/supabase/server'
import { type ActionResult, dbErrorMessage } from '@/lib/actionResult'
import { approvalNodeOf, isMissingColumn, isMissingRelation, loopGuardErrorMessage } from '@/core/loopQueries'
import { canCurrentUserSeeSales } from '@/lib/queries/access'
import { seesByznys } from '@/lib/domain'
import { approvalActionErrorMessage } from '@/core/approvalActions'
import {
  canCloseCase,
  caseCloseIssues,
  canTransitionCase,
  canTransitionStep,
  isCaseStatus,
  isStepStatus,
  isTerminalCase,
} from '@/core/workCase'
import {
  decideApproval,
  isApprovalStatus,
  isLevel,
  nodeRoleFor,
  requiredLevel,
  type AuthorityPolicy,
  type LoopNodeRow,
} from '@/core/authority'
import {
  MIGRATION_PENDING_MESSAGE,
  actorOf,
  caseStatusLabel,
  defaultLeadOwner,
  findTemplate,
  loopRpcErrorMessage,
  nextStepPosition,
  parseOptions,
  pragueDayEnd,
  stepStatusLabel,
  templateStepRows,
} from '@/core/workCaseFlow'
import {
  addStepSchema,
  caseStatusSchema,
  createCaseSchema,
  decideApprovalSchema,
  recordDecisionSchema,
  requestApprovalSchema,
  resolveDecisionSchema,
  stepStatusSchema,
} from '@/core/workCaseSchemas'
import { readActiveMember } from '@/lib/auth/activeMember'

type DbErr = { code?: string | null; message?: string | null } | null

function fieldErrorsOf(err: ZodError): Record<string, string> {
  const out: Record<string, string> = {}
  for (const i of err.issues) {
    const k = String(i.path[0] ?? '_')
    if (!out[k]) out[k] = i.message
  }
  return out
}

const fail = (error: string): ActionResult => ({ success: false, error })

// Chyba čtení/zápisu: chybějící migrace → klidná hláška, známá chyba RPC →
// česká věta, jinak zalogovat a obecná hláška (bez názvů tabulek).
function errorResult(scope: string, err: DbErr, context: 'approval' | 'decision' = 'approval'): ActionResult {
  if (isMissingRelation(err)) return fail(MIGRATION_PENDING_MESSAGE)
  return fail(
    loopGuardErrorMessage(err) ?? approvalActionErrorMessage(err) ?? loopRpcErrorMessage(err, context) ?? dbErrorMessage(scope, err),
  )
}

function revalidateCase(caseId: number) {
  revalidatePath('/cockpit/pripady')
  revalidatePath(`/cockpit/pripady/${caseId}`)
  revalidatePath('/cockpit/rozhodnuti')
}

const formObject = (fd: FormData) => Object.fromEntries(fd.entries())

// Případ pro zápis do jeho kroků/rozhodnutí: musí existovat a nesmí být konečný.
async function loadOpenCase(s: Awaited<ReturnType<typeof createClient>>, caseId: number):
  Promise<{ ok: true; status: string; node: string } | { ok: false; result: ActionResult }> {
  const { data, error } = await s.from('work_case').select('id, status, node').eq('id', caseId).maybeSingle()
  if (error) return { ok: false, result: errorResult('action.workCase.load', error) }
  const row = data as { status: string; node: string } | null
  if (!row) return { ok: false, result: fail('Případ nebyl nalezen.') }
  if (isCaseStatus(row.status) && isTerminalCase(row.status)) {
    return { ok: false, result: fail(`Případ je uzavřený (${caseStatusLabel(row.status)}), už se nemění.`) }
  }
  return { ok: true, status: row.status, node: row.node }
}

export async function createWorkCase(_prev: unknown, formData: FormData): Promise<ActionResult> {
  const user = await tryRequireUser({ aal2: true })
  if (!user) return fail(AUTH_ERROR_MESSAGE)
  const parsed = createCaseSchema.safeParse(formObject(formData))
  if (!parsed.success) return { success: false, fieldErrors: fieldErrorsOf(parsed.error) }
  const input = parsed.data
  const template = findTemplate(input.template)
  if (input.template && !template) return { success: false, fieldErrors: { template: 'Neznámá šablona.' } }

  const s = await createClient()

  // Obchod je obchodní údaj: připojit ho smí jen ten, kdo vidí Byznys.
  if (input.deal_id && !(await canCurrentUserSeeSales())) {
    return { success: false, fieldErrors: { deal_id: 'Obchod k případu může připojit jen člen s přístupem k obchodu.' } }
  }

  // Obchod určuje klienta: bez klienta se doplní, s jiným klientem je to chyba.
  // Sem se s deal_id dostane jen obchodní role (brána výše), která na deal
  // vidí i po 0058 — proto přímé čtení, ne deal_public. Ostatní role případ
  // zakládají bez obchodu; název navázaného obchodu uvidí v detailu přes
  // deal_public (getWorkCase).
  let accountId = input.account_id
  if (input.deal_id) {
    const { data: deal, error } = await s.from('deal').select('account_id').eq('id', input.deal_id).maybeSingle()
    if (error) return errorResult('action.workCase.deal', error)
    if (!deal) return { success: false, fieldErrors: { deal_id: 'Obchod nebyl nalezen.' } }
    const dealAccount = (deal as { account_id: number }).account_id
    if (accountId && accountId !== dealAccount) {
      return { success: false, fieldErrors: { deal_id: 'Obchod nepatří vybranému klientovi.' } }
    }
    accountId = dealAccount
  }

  // Výchozí vlastník = vlastník uzlu (loop_node).
  let leadOwner = input.lead_owner_id
  if (!leadOwner) {
    const { data: nodes, error } = await s.from('loop_node').select('node, owner_id, deputy_id').eq('node', input.node)
    if (error) return errorResult('action.workCase.node', error)
    leadOwner = defaultLeadOwner(input.node, null, (nodes ?? []) as LoopNodeRow[])
  }

  const { data: created, error: insErr } = await s
    .from('work_case')
    .insert({
      title: input.title,
      node: input.node,
      status: 'open',
      account_id: accountId,
      deal_id: input.deal_id,
      lead_owner_id: leadOwner,
      // created_by doplní DB (DEFAULT loop_actor() + trigger, 0057).
    })
    .select('id')
    .single()
  if (insErr || !created) return errorResult('action.workCase.create', insErr)
  const caseId = (created as { id: number }).id

  if (template) {
    const rollback = async (scope: string, err: DbErr): Promise<ActionResult> => {
      // Kompenzace: případ bez kroků šablony by byl polovičatý. Mazat smí
      // jen vedení a rozhodnutí mazání blokují (0057), proto se případ
      // zruší — open → cancelled je povolený přechod a stopa zůstane.
      await s.from('work_case').update({ status: 'cancelled' }).eq('id', caseId).eq('status', 'open')
      return errorResult(scope, err)
    }
    const { error: stepErr } = await s.from('case_step').insert(templateStepRows(template, caseId))
    if (stepErr) return rollback('action.workCase.templateSteps', stepErr)
    for (const d of template.decisions) {
      const { error: decErr } = await s.rpc('record_decision', {
        p_case_id: caseId,
        p_question: d.question,
        p_options: [...d.options],
      })
      if (decErr) return rollback('action.workCase.templateDecision', decErr)
    }
  }

  revalidateCase(caseId)
  redirect(`/cockpit/pripady/${caseId}`)
}

export async function addCaseStep(_prev: unknown, formData: FormData): Promise<ActionResult> {
  if (!await tryRequireUser({ aal2: true })) return fail(AUTH_ERROR_MESSAGE)
  const parsed = addStepSchema.safeParse(formObject(formData))
  if (!parsed.success) return { success: false, fieldErrors: fieldErrorsOf(parsed.error) }
  const { case_id, title } = parsed.data
  const s = await createClient()
  const c = await loadOpenCase(s, case_id)
  if (!c.ok) return c.result
  const { data: steps, error: readErr } = await s.from('case_step').select('position').eq('case_id', case_id)
  if (readErr) return errorResult('action.workCase.steps', readErr)
  const position = nextStepPosition((steps ?? []) as { position: number }[])
  const { error } = await s.from('case_step').insert({ case_id, title, position, status: 'todo' })
  if (error) return errorResult('action.workCase.addStep', error)
  revalidateCase(case_id)
  return { success: true }
}

export async function changeStepStatus(_prev: unknown, formData: FormData): Promise<ActionResult> {
  if (!await tryRequireUser({ aal2: true })) return fail(AUTH_ERROR_MESSAGE)
  const parsed = stepStatusSchema.safeParse(formObject(formData))
  if (!parsed.success) return fail('Neplatný požadavek. Obnovte stránku.')
  const { step_id, to } = parsed.data
  const s = await createClient()
  const { data, error } = await s.from('case_step').select('id, case_id, status').eq('id', step_id).maybeSingle()
  if (error) return errorResult('action.workCase.step', error)
  const step = data as { case_id: number; status: string } | null
  if (!step) return fail('Krok nebyl nalezen.')
  const c = await loadOpenCase(s, step.case_id)
  if (!c.ok) return c.result
  if (!isStepStatus(step.status) || !canTransitionStep(step.status, to)) {
    return fail(`Krok nejde převést ze stavu „${stepStatusLabel(step.status)}" na „${stepStatusLabel(to)}".`)
  }
  const { data: updated, error: upErr } = await s
    .from('case_step')
    .update({ status: to })
    .eq('id', step_id)
    .eq('status', step.status)
    .select('id')
  if (upErr) return errorResult('action.workCase.stepStatus', upErr)
  if (!Array.isArray(updated) || updated.length !== 1) return fail('Krok mezitím změnil někdo jiný. Obnovte stránku.')
  revalidateCase(step.case_id)
  return { success: true }
}

export async function changeCaseStatus(_prev: unknown, formData: FormData): Promise<ActionResult> {
  if (!await tryRequireUser({ aal2: true })) return fail(AUTH_ERROR_MESSAGE)
  const parsed = caseStatusSchema.safeParse(formObject(formData))
  if (!parsed.success) return fail('Neplatný požadavek. Obnovte stránku.')
  const { case_id, to } = parsed.data
  const s = await createClient()
  const { data, error } = await s.from('work_case').select('id, status').eq('id', case_id).maybeSingle()
  if (error) return errorResult('action.workCase.case', error)
  const row = data as { status: string } | null
  if (!row) return fail('Případ nebyl nalezen.')
  if (!isCaseStatus(row.status)) return fail('Případ má neznámý stav.')
  const from = row.status

  if (to === 'done') {
    const { data: steps, error: stepsErr } = await s.from('case_step').select('status').eq('case_id', case_id)
    if (stepsErr) return errorResult('action.workCase.closeSteps', stepsErr)
    const list = ((steps ?? []) as { status: string }[]).filter((x) => isStepStatus(x.status)) as {
      status: Parameters<typeof canCloseCase>[1][number]['status']
    }[]
    if (!canCloseCase(from, list)) {
      return fail(`Případ zatím nejde uzavřít: ${caseCloseIssues(from, list).join(', ')}.`)
    }
  } else if (!canTransitionCase(from, to)) {
    return fail(`Případ nejde převést ze stavu „${caseStatusLabel(from)}" na „${caseStatusLabel(to)}".`)
  }

  const { data: updated, error: upErr } = await s
    .from('work_case')
    .update({ status: to })
    .eq('id', case_id)
    .eq('status', from)
    .select('id')
  if (upErr) return errorResult('action.workCase.caseStatus', upErr)
  if (!Array.isArray(updated) || updated.length !== 1) return fail('Případ mezitím změnil někdo jiný. Obnovte stránku.')
  revalidateCase(case_id)
  return { success: true }
}

export async function requestCaseApproval(_prev: unknown, formData: FormData): Promise<ActionResult> {
  if (!await tryRequireUser({ aal2: true })) return fail(AUTH_ERROR_MESSAGE)
  const parsed = requestApprovalSchema.safeParse(formObject(formData))
  if (!parsed.success) return { success: false, fieldErrors: fieldErrorsOf(parsed.error) }
  const { case_id, action_kind, expires_on } = parsed.data
  const s = await createClient()
  const c = await loadOpenCase(s, case_id)
  if (!c.ok) return c.result

  // Úroveň určuje authority_policy (data), ne formulář.
  const { data: policies, error: polErr } = await s
    .from('authority_policy')
    .select('action_kind, level, active')
    .eq('action_kind', action_kind)
    .eq('active', true)
  if (polErr) return errorResult('action.workCase.policy', polErr)
  const level = requiredLevel((policies ?? []) as AuthorityPolicy[], action_kind)
  if (level === 'L1') return fail(`Činnost ${action_kind} má úroveň L1 — schválení není potřeba.`)

  const expiresAt = expires_on ? pragueDayEnd(expires_on) : null
  const { error } = await s.rpc('request_approval', {
    p_action_kind: action_kind,
    p_requested_level: level,
    p_case_id: case_id,
    p_expires_at: expiresAt ? expiresAt.toISOString() : null,
  })
  if (error) return errorResult('action.workCase.requestApproval', error)
  revalidateCase(case_id)
  return { success: true }
}

export async function recordCaseDecision(_prev: unknown, formData: FormData): Promise<ActionResult> {
  if (!await tryRequireUser({ aal2: true })) return fail(AUTH_ERROR_MESSAGE)
  const parsed = recordDecisionSchema.safeParse(formObject(formData))
  if (!parsed.success) return { success: false, fieldErrors: fieldErrorsOf(parsed.error) }
  const { case_id, question } = parsed.data
  const options = parseOptions(parsed.data.options)
  if (options.length === 1) return { success: false, fieldErrors: { options: 'Zadejte aspoň dvě možnosti, nebo žádnou.' } }
  const s = await createClient()
  const c = await loadOpenCase(s, case_id)
  if (!c.ok) return c.result
  const { error } = await s.rpc('record_decision', { p_case_id: case_id, p_question: question, p_options: options })
  if (error) return errorResult('action.workCase.recordDecision', error, 'decision')
  revalidateCase(case_id)
  return { success: true }
}

export async function resolveCaseDecision(_prev: unknown, formData: FormData): Promise<ActionResult> {
  if (!await tryRequireUser({ aal2: true })) return fail(AUTH_ERROR_MESSAGE)
  const parsed = resolveDecisionSchema.safeParse(formObject(formData))
  if (!parsed.success) return { success: false, fieldErrors: fieldErrorsOf(parsed.error) }
  const { decision_id, chosen } = parsed.data
  const s = await createClient()
  const { data, error } = await s
    .from('decision')
    .select('id, case_id, options, decided_at')
    .eq('id', decision_id)
    .maybeSingle()
  if (error) return errorResult('action.workCase.decision', error)
  const d = data as { case_id: number; options: unknown; decided_at: string | null } | null
  if (!d) return fail('Rozhodnutí nebylo nalezeno.')
  if (d.decided_at) return fail('Rozhodnutí už je rozhodnuté.')
  const options = Array.isArray(d.options) ? d.options.filter((o): o is string => typeof o === 'string') : []
  if (options.length > 0 && !options.includes(chosen)) return fail('Vyberte jednu z nabízených možností.')
  const { error: rpcErr } = await s.rpc('resolve_decision', { p_decision_id: decision_id, p_chosen: chosen })
  if (rpcErr) return errorResult('action.workCase.resolveDecision', rpcErr, 'decision')
  revalidateCase(d.case_id)
  return { success: true }
}

export async function decideApprovalRequest(_prev: unknown, formData: FormData): Promise<ActionResult> {
  const user = await tryRequireUser({ aal2: true })
  if (!user) return fail(AUTH_ERROR_MESSAGE)
  const parsed = decideApprovalSchema.safeParse(formObject(formData))
  if (!parsed.success) return fail('Neplatný požadavek. Obnovte stránku.')
  const { request_id, approve, note } = parsed.data
  const s = await createClient()

  // node = snímek uzlu z žádosti (0057), action_type = druh akce (0084);
  // před migrací sloupec chybí → dotaz bez něj.
  const loadRequest = (cols: string) =>
    s.from('approval_request')
      .select(`id, case_id,${cols} status, requested_level, requested_by, expires_at, work_case(node)`)
      .eq('id', request_id)
      .maybeSingle()
  const [reqFull, nodesRes, memberRes] = await Promise.all([
    loadRequest(' node, action_type,'),
    s.from('loop_node').select('node, owner_id, deputy_id'),
    readActiveMember<{ role?: string | null }>(s, user.id, 'role'),
  ])
  let reqRes = reqFull
  if (isMissingColumn(reqRes.error)) reqRes = await loadRequest(' node,')
  if (isMissingColumn(reqRes.error)) reqRes = await loadRequest('')
  const readErr = reqRes.error ?? nodesRes.error ?? memberRes.error
  if (readErr) return errorResult('action.approval.load', readErr)
  type Row = {
    case_id: number | null
    node?: string | null
    action_type?: string | null
    status: string
    requested_level: string
    requested_by: string
    expires_at: string | null
    work_case: { node: string } | { node: string }[] | null
  }
  const req = reqRes.data as Row | null
  if (!req) return fail('Požadavek nebyl nalezen.')
  if (!isApprovalStatus(req.status) || !isLevel(req.requested_level)) return fail('Požadavek má neplatná data.')
  const wc = Array.isArray(req.work_case) ? req.work_case[0] : req.work_case
  const teamRole = memberRes.row?.role ?? null
  // Uzel jako v SQL: snímek z žádosti. Bez uzlu (bez případu) rozhoduje
  // jen vedení — ostatní nedostanou žádnou roli (stejně jako
  // loop_approver_role_for_node).
  const node = approvalNodeOf(req, wc?.node)
  const role = node
    ? nodeRoleFor({ id: user.id, teamRole }, node, (nodesRes.data ?? []) as LoopNodeRow[])
    : teamRole === 'vedeni' ? 'vedeni' : 'none'

  // Tatáž pravidla jako decide_approval v DB včetně kontroly role (SQL od 0053).
  const outcome = decideApproval(
    {
      status: req.status,
      requested_level: req.requested_level,
      requested_by: req.requested_by,
      expires_at: req.expires_at ? new Date(req.expires_at) : null,
    },
    approve === '1' ? 'approved' : 'rejected',
    { id: actorOf(user.id), role },
    new Date(),
  )
  if (!outcome.ok) {
    if (req.status !== 'pending') return fail('O požadavku už bylo rozhodnuto.')
    if (req.requested_by === actorOf(user.id)) return fail('Vlastní požadavek nemůžete schválit ani zamítnout (čtyři oči).')
    return fail(`Na schválení úrovně ${req.requested_level} nemáte v tomto uzlu pravomoc.`)
  }
  if (outcome.status === 'expired') return fail('Požadavek vypršel, už o něm nejde rozhodnout.')
  // 0084: nabídku vidí jen obchodní role, jen ta ji schvaluje k odeslání (SQL to hlídá taky).
  if (req.action_type === 'send_offer' && !seesByznys(teamRole)) {
    return fail('Odeslání nabídky schvaluje jen člen s přístupem k obchodu.')
  }

  // Po rozhodnutí typované žádosti databáze ve stejné transakci provede další
  // krok (approval_execute, 0084): krok a úkol, schválení verze k odeslání
  // nebo návrat vlastníkovi. Výsledek je v approval_execution.
  const { error } = await s.rpc('decide_approval', {
    p_request_id: request_id,
    p_approve: approve === '1',
    p_note: note,
  })
  if (error) return errorResult('action.approval.decide', error)
  revalidatePath('/cockpit/rozhodnuti')
  if (req.case_id) revalidatePath(`/cockpit/pripady/${req.case_id}`)
  if (req.action_type) {
    revalidatePath('/cockpit/tasks')
    revalidatePath('/cockpit')
    if (req.action_type === 'send_offer') revalidatePath('/cockpit/clients/[id]/deals/[dealId]', 'page')
  }
  return { success: true }
}
