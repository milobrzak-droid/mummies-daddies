'use server'
// „Zkontrolovat změny v Outlooku" na /schuzky — ruční spuštění kontroly,
// která jinak běží denně v cronu. Jen obchodní role (schůzky jsou obchodní
// data) a jen schůzky přihlášeného člena. Jádro: ./calendarCheck.ts.
import { AUTH_ERROR_MESSAGE, tryRequireUser } from '@/lib/auth/requireUser'
import { canCurrentUserSeeSales } from '@/lib/queries/access'
import type { CalendarCheckResult } from '@/domain/crm/meetingCalendar'
import { checkMyMeetingsInOutlook } from './calendarCheck'

export async function checkMeetingsInOutlook(): Promise<CalendarCheckResult> {
  const user = await tryRequireUser({ aal2: true })
  if (!user) return { ok: false, error: AUTH_ERROR_MESSAGE }
  if (!(await canCurrentUserSeeSales())) return { ok: false, error: 'Nemáš oprávnění.' }
  return checkMyMeetingsInOutlook(user.id)
}
