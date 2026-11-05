import { createClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import type { TeamMember } from '@/lib/types'
import { getCurrentMember, memberIsAdmin } from '@/lib/queries/currentMember'
import { logError } from '@/lib/log'

/**
 * Kdo má nastavené dvoufázové ověření (aspoň jeden ověřený faktor) — pro
 * správce na stránce Tým, ať ví, komu je co rušit. Čte Supabase Auth přes
 * service role, proto nejdřív znovu ověří, že se ptá správce. null =
 * nezjištěno (není správce, chyba Auth); stránka pak stav jen nezobrazí.
 */
export async function getMfaStatusByMember(): Promise<Map<string, boolean> | null> {
  if (!(await isCurrentUserAdmin())) return null
  try {
    const { data, error } = await createAdminClient().auth.admin.listUsers({ page: 1, perPage: 1000 })
    if (error || !data) {
      if (error) logError('team.mfaStatus', error)
      return null
    }
    return new Map(data.users.map((u) => [u.id, (u.factors ?? []).some((f) => f.status === 'verified')]))
  } catch (e) {
    logError('team.mfaStatus', e)
    return null
  }
}

export async function isCurrentUserAdmin(): Promise<boolean> {
  const { user, member } = await getCurrentMember()
  if (!user) return false
  return memberIsAdmin(member)
}

export async function listTeamMembers(): Promise<TeamMember[]> {
  const s = await createClient()
  const { data, error } = await s.from('team_member')
    .select('id, full_name, email, role, is_admin, created_at').order('created_at')
  if (error) throw error
  return (data ?? []) as TeamMember[]
}

export type TeamMemberStatus = TeamMember & { deactivated_at: string | null }

// Členové i s příznakem deaktivace (0069). Před 0069 sloupec chybí — pak
// jsou všichni aktivní. Pro „Předat práci" (výběr, komu předat).
export async function listTeamMembersWithStatus(): Promise<TeamMemberStatus[]> {
  const s = await createClient()
  const base = 'id, full_name, email, role, is_admin, created_at'
  const res = await s.from('team_member').select(`${base}, deactivated_at`).order('created_at')
  if (res.error && (res.error.code === '42703' || res.error.code === 'PGRST204')) {
    return (await listTeamMembers()).map((m) => ({ ...m, deactivated_at: null }))
  }
  if (res.error) throw res.error
  return ((res.data ?? []) as TeamMemberStatus[]).map((m) => ({ ...m, deactivated_at: m.deactivated_at ?? null }))
}
