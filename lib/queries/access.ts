import { getCurrentMember, memberSeesSales } from '@/lib/queries/currentMember'

export async function canCurrentUserSeeSales(): Promise<boolean> {
  const { user, member } = await getCurrentMember()
  if (!user) return false
  return memberSeesSales(member)
}
