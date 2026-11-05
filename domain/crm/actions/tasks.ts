'use server'
import { AUTH_ERROR_MESSAGE, requireUser, tryRequireUser } from '@/lib/auth/requireUser'
import { revalidatePath } from 'next/cache'
import { createClient } from '@/lib/supabase/server'
import { taskSchema, taskStatus, taskDueOn, areEntityIds } from '@/lib/validation/schemas'
import { type ActionResult, dbErrorMessage } from '@/lib/actionResult'
import type { ZodError } from 'zod'
import { recordAudit, type AuditActor } from '@/core/audit'
import { dbAuditActive } from '@/core/auditDb'
import { auditRowPayload } from '@/core/auditCoverage'
import { taskDeletedAuditBefore } from '@/domain/crm/auditPayload'
import { judgeSingleRowDelete } from '@/domain/crm/deleteVerdict'
import { logError } from '@/lib/log'

function fieldErrorsOf(err: ZodError): Record<string, string> {
  const out: Record<string, string> = {}
  for (const i of err.issues) { const k = String(i.path[0] ?? '_'); if (!out[k]) out[k] = i.message }
  return out
}

export async function createTask(_prev: unknown, formData: FormData): Promise<ActionResult> {
  if (!await tryRequireUser({ aal2: true })) return { success: false, error: AUTH_ERROR_MESSAGE }
  const parsed = taskSchema.safeParse(Object.fromEntries(formData.entries()))
  if (!parsed.success) return { success: false, fieldErrors: fieldErrorsOf(parsed.error) }
  const s = await createClient()
  const { data: { user } } = await s.auth.getUser()
  const row = { ...parsed.data }
  if (row.deal_id) {
    const { data: deal } = await s.from('deal').select('account_id').eq('id', row.deal_id).maybeSingle()
    if (!deal) return { success: false, fieldErrors: { deal_id: 'Obchod nebyl nalezen.' } }
    if (row.account_id && row.account_id !== deal.account_id) {
      return { success: false, fieldErrors: { deal_id: 'Obchod nepatří vybranému klientovi.' } }
    }
    row.account_id = deal.account_id
  }
  const { error } = await s.from('task').insert({ ...row, created_by: user?.id ?? null })
  if (error) return { success: false, error: dbErrorMessage('action.tasks', error) }
  revalidatePath('/cockpit/tasks')
  // Úkol se teď zakládá i ze stránky klienta / dealu (ne jen z /tasks), takže
  // revalidujeme i ty — jinak by nový úkol po přesměrování zpět nebyl vidět.
  if (row.account_id) revalidatePath(`/cockpit/clients/${row.account_id}`)
  if (row.deal_id && row.account_id) revalidatePath(`/cockpit/clients/${row.account_id}/deals/${row.deal_id}/edit`)
  return { success: true }
}

export async function updateTaskStatus(taskId: number, status: string): Promise<void> {
  await requireUser({ aal2: true })
  if (!areEntityIds(taskId)) return
  const parsed = taskStatus.safeParse(status)
  if (!parsed.success) return
  const s = await createClient()
  const { error } = await s.from('task').update({ status: parsed.data }).eq('id', taskId)
  if (error) throw error
  revalidatePath('/cockpit/tasks')
}

const TASK_DUE_NOT_FOUND = 'Úkol nebyl nalezen nebo k němu nemáš přístup.'

/**
 * Posun termínu úkolu (Dnes → Po termínu: Zítra / Příští týden, karta úkolu
 * na tabuli: datum). Stejná pravidla jako ostatní akce úkolů: AAL2, platné
 * id a datum, oprávnění drží RLS úkolu (člen týmu + AAL2) — update, který
 * neprojde RLS, vrátí 0 řádků a akce to řekne, místo aby tvrdila úspěch.
 * `null` termín smaže (Zpět u úkolu, který termín neměl). Audit: po 0064
 * zapisuje změnu DB trigger (task.updated, due_on s hodnotou); do té doby
 * appka stejným tvarem (auditRowPayload), nikdy obojí.
 */
export async function updateTaskDueOn(taskId: number, dueOn: string | null): Promise<ActionResult> {
  const user = await tryRequireUser({ aal2: true })
  if (!user) return { success: false, error: AUTH_ERROR_MESSAGE }
  if (!areEntityIds(taskId)) return { success: false, error: 'Neplatné ID.' }
  const parsed = taskDueOn.safeParse(dueOn)
  if (!parsed.success) return { success: false, error: 'Doplň platný termín.' }
  const s = await createClient()
  const { data: before, error: readError } = await s.from('task')
    .select('id, due_on, account_id, deal_id')
    .eq('id', taskId)
    .maybeSingle()
  if (readError) return { success: false, error: dbErrorMessage('action.tasks', readError) }
  if (!before) return { success: false, error: TASK_DUE_NOT_FOUND }
  const { data: updated, error } = await s.from('task')
    .update({ due_on: parsed.data })
    .eq('id', taskId)
    .select('id')
  if (error) return { success: false, error: dbErrorMessage('action.tasks', error) }
  if (!updated || updated.length === 0) return { success: false, error: TASK_DUE_NOT_FOUND }

  if ((before.due_on ?? null) !== parsed.data && !(await dbAuditActive())) {
    const audit = auditRowPayload('task', 'UPDATE', { id: taskId, due_on: before.due_on ?? null }, { id: taskId, due_on: parsed.data })
    if (audit) {
      try {
        await recordAudit('task', taskId, audit.action, audit.before, audit.after, { type: 'user', id: user.id })
      } catch {
        // recordAudit sám loguje; změna termínu už proběhla a audit ji nesmí strhnout
      }
    }
  }
  revalidatePath('/cockpit/tasks')
  revalidatePath('/cockpit')
  if (before.account_id) revalidatePath(`/cockpit/clients/${before.account_id}`)
  return { success: true }
}

export async function deleteTask(taskId: number): Promise<void> {
  await requireUser({ aal2: true })
  if (!areEntityIds(taskId)) return
  const s = await createClient()
  // Úkol se čte PŘED smazáním, aby měl audit záznam co uložit do `before`.
  // Název se do auditu neukládá (volný text, často se jménem) — jen stav a řešitel.
  // Pokud řádek už neexistuje (souběžné smazání odjinud), audit se vynechá.
  const { data: existing } = await s.from('task')
    .select('title, status, assignee_id')
    .eq('id', taskId)
    .maybeSingle()
  // Smazání se musí potvrdit (právě jeden řádek), než se zapíše audit —
  // DELETE zamítnutý přes RLS/AAL1 nevrací chybu, jen 0 řádků (stejně jako
  // u deleteContact v domain/crm/actions/contacts.ts).
  const { data: deleted, error } = await s.from('task').delete().eq('id', taskId).select('id')
  if (error) throw error
  revalidatePath('/cockpit/tasks')
  const verdict = judgeSingleRowDelete(error, deleted)
  if (!verdict.ok) {
    logError('task.delete', new Error(verdict.reason), { taskId, reason: verdict.reason })
    return
  }

  // Po migraci 0064 zapisuje smazání úkolu DB trigger (task.deleted, bez
  // názvu a popisu); appka jen do té doby, nikdy obojí.
  if (existing && !(await dbAuditActive())) {
    const { data: { user } } = await s.auth.getUser()
    const actor: AuditActor = { type: 'user', id: user?.id ?? null }
    // recordAudit sám o sobě nevyhazuje (loguje a degraduje), ale čekáme na
    // něj v try/catch jako pojistku — smazání je hotové a selhání auditu
    // ho nesmí strhnout s sebou.
    try {
      await recordAudit('task', taskId, 'task.deleted', taskDeletedAuditBefore(existing), null, actor)
    } catch {
      // úmyslně tiché — recordAudit už zalogoval, tady se jen jistíme
    }
  }
}
