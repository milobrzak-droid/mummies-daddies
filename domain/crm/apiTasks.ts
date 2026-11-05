import { z } from 'zod'
import { createAdminClient } from '@/lib/supabase/admin'
import { createAuditedAdminClient } from '@/core/auditDb'
import { dbErrorMessage } from '@/lib/actionResult'
import { taskStatus } from '@/lib/validation/schemas'
import type { WriteResult } from '@/domain/crm/apiWrite'

// Změna stavu úkolu přes API/MCP (update_task_status). Jen stav (todo,
// in_progress, blocked, done) — název, termín ani řešitele tudy měnit nejde
// a nic se nemaže. Agent smí měnit jen úkoly vlastníka klíče: přidělené jemu,
// nebo které sám založil. Cizí úkol = chyba (ať ho změní jeho řešitel).
//
// Audit: DB trigger 0064 zapíše task.updated (status s hodnotou) jménem
// vlastníka klíče (hlavička aktéra na admin klientovi).

export const taskStatusInput = z.object({
  task_id: z.number().int().positive('task_id musí být kladné celé číslo'),
  status: taskStatus,
}).strict()

export const TASK_NOT_FOUND = 'Úkol nenalezen.'
export const TASK_NOT_MINE =
  'Tenhle úkol není tvůj (nejsi jeho řešitel ani ho nezaložil vlastník klíče). Stav cizího úkolu přes konektor neměním.'

export async function updateTaskStatusForApi(
  raw: unknown,
  createdBy: string | null,
): Promise<WriteResult<{ id: number; status: string; previous: string; changed: boolean }>> {
  const parsed = taskStatusInput.safeParse(raw)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const message = issue?.code === 'unrecognized_keys'
      ? `Tohle pole přes konektor měnit nejde: ${issue.keys.join(', ')}.`
      : issue?.path[0] === 'status' ? 'status musí být jedno z: todo, in_progress, blocked, done.' : issue?.message ?? 'Neplatný vstup.'
    return { ok: false, status: 400, error: message }
  }
  if (!createdBy) return { ok: false, status: 403, error: TASK_NOT_MINE }

  const { data, error } = await createAdminClient()
    .from('task').select('id, status, assignee_id, created_by').eq('id', parsed.data.task_id).maybeSingle()
  if (error) return { ok: false, status: 500, error: dbErrorMessage('apiTasks.status', error) }
  if (!data) return { ok: false, status: 404, error: TASK_NOT_FOUND }
  const task = data as { id: number; status: string; assignee_id: string | null; created_by: string | null }
  if (task.assignee_id !== createdBy && task.created_by !== createdBy) return { ok: false, status: 403, error: TASK_NOT_MINE }
  if (task.status === parsed.data.status) {
    return { ok: true, data: { id: task.id, status: task.status, previous: task.status, changed: false } }
  }

  const admin = createAuditedAdminClient({ actor: { type: 'api_key', id: createdBy } })
  const { data: updated, error: updateError } = await admin
    .from('task').update({ status: parsed.data.status }).eq('id', task.id).select('id').maybeSingle()
  if (updateError) return { ok: false, status: 500, error: dbErrorMessage('apiTasks.status', updateError) }
  if (!updated) return { ok: false, status: 404, error: TASK_NOT_FOUND }
  return { ok: true, data: { id: task.id, status: parsed.data.status, previous: task.status, changed: true } }
}
