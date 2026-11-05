import { createClient } from '@/lib/supabase/server'
import type { Task, TeamMember } from '@/lib/types'

export async function getTasks(): Promise<Task[]> {
  const s = await createClient()
  const { data, error } = await s.from('task')
    .select('*, account:account!task_account_id_fkey(id, name), deal:deal!task_deal_id_fkey(id, title)')
    .order('created_at', { ascending: false })
  if (error) throw error
  return (data ?? []) as Task[]
}
export async function getMyTasks(): Promise<Task[]> {
  const s = await createClient()
  const { data: { user } } = await s.auth.getUser()
  if (!user) return []
  const { data, error } = await s.from('task')
    .select('*, account:account!task_account_id_fkey(id, name), deal:deal!task_deal_id_fkey(id, title)')
    .eq('assignee_id', user.id)
    .order('due_on', { ascending: true, nullsFirst: false })
  if (error) throw error
  return (data ?? []) as Task[]
}
export async function listAssignableMembers(): Promise<TeamMember[]> {
  const s = await createClient()
  const { data, error } = await s.from('team_member').select('id, full_name, email, role, is_admin, created_at').order('full_name')
  if (error) throw error
  return (data ?? []) as TeamMember[]
}

// Otevřené (nedokončené) úkoly klienta, seřazené podle termínu — nejbližší
// termín je to, na co se má člověk podívat první. Úkoly bez termínu (due_on
// null) jdou na konec, ne na začátek, aby nezakryly to, co už hoří.
export async function getOpenTasksForAccount(accountId: number): Promise<Task[]> {
  const s = await createClient()
  const { data, error } = await s.from('task')
    .select('*, account:account!task_account_id_fkey(id, name), deal:deal!task_deal_id_fkey(id, title)')
    .eq('account_id', accountId)
    .neq('status', 'done')
    .order('due_on', { ascending: true, nullsFirst: false })
  if (error) throw error
  return (data ?? []) as Task[]
}

// Počet hotových úkolů klienta — dokončené úkoly se v sekci nezobrazují
// jednotlivě (nejsou akční), ale skryjí se za počet, aby historie nezmizela.
export async function getDoneTaskCountForAccount(accountId: number): Promise<number> {
  const s = await createClient()
  const { count, error } = await s.from('task')
    .select('id', { count: 'exact', head: true })
    .eq('account_id', accountId)
    .eq('status', 'done')
  if (error) throw error
  return count ?? 0
}

// Totéž jako výše, ale pro konkrétní obchod/projekt — úkol tak může viset
// na dealu, ne jen na klientovi obecně.
export async function getOpenTasksForDeal(dealId: number): Promise<Task[]> {
  const s = await createClient()
  const { data, error } = await s.from('task')
    .select('*, account:account!task_account_id_fkey(id, name), deal:deal!task_deal_id_fkey(id, title)')
    .eq('deal_id', dealId)
    .neq('status', 'done')
    .order('due_on', { ascending: true, nullsFirst: false })
  if (error) throw error
  return (data ?? []) as Task[]
}

export async function getDoneTaskCountForDeal(dealId: number): Promise<number> {
  const s = await createClient()
  const { count, error } = await s.from('task')
    .select('id', { count: 'exact', head: true })
    .eq('deal_id', dealId)
    .eq('status', 'done')
  if (error) throw error
  return count ?? 0
}
