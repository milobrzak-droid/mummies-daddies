import { cache } from 'react'
import type { User } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'
import { seesByznys } from '@/lib/domain'
import { readActiveMember } from '@/lib/auth/activeMember'

/** Union of team_member columns needed by layout, dashboard and access checks. */
export const CURRENT_MEMBER_COLUMNS = 'full_name, is_admin, role'

export interface CurrentMemberRow {
  full_name: string | null
  is_admin: boolean | null
  role: string | null
}

export interface CurrentMember {
  user: User | null
  member: CurrentMemberRow | null
}

/** Same rule as the previous isCurrentUserAdmin: truthy is_admin on the row. */
export function memberIsAdmin(member: Pick<CurrentMemberRow, 'is_admin'> | null | undefined): boolean {
  return !!member?.is_admin
}

/** Same rule as the previous canCurrentUserSeeSales: seesByznys(role). */
export function memberSeesSales(
  member: (Pick<CurrentMemberRow, 'role'> & { deactivated_at?: string | null }) | null | undefined,
): boolean {
  // Deaktivovaný člen nevidí obchodní data, ani kdyby řádek s rolí dostal (defenzivně).
  if (member?.deactivated_at) return false
  return seesByznys(member?.role)
}

/**
 * auth.getUser() + one team_member read, memoized per request via React cache()
 * so layout, page and access helpers share a single round trip.
 * Outside a React render (server actions, route handlers) it simply runs uncached.
 */
export const getCurrentMember = cache(async (): Promise<CurrentMember> => {
  const s = await createClient()
  const { data: { user } } = await s.auth.getUser()
  if (!user) return { user: null, member: null }
  // Deaktivovaný člen = žádný člen (member null → žádná role, žádné admin ani sales právo).
  const { row } = await readActiveMember<Record<string, unknown>>(s, user.id, CURRENT_MEMBER_COLUMNS)
  return { user, member: (row as CurrentMemberRow | null) ?? null }
})
