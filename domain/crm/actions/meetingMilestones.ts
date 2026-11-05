'use server'
// Čtecí akce pro formulář „Naplánovat schůzku": otevřené milníky dodávek
// vybraného klienta, ke kterým může schůzka patřit (0085). Akce je globálně
// volatelná POSTem, proto i čtení hlídá přihlášení s AAL2; data jdou přes
// RLS klienta uživatele (milníky a dodávky vidí tým).
//
// Bez migrace 0085 vrací { available: false } — formulář pak výběr milníku
// neukáže a schůzka se naplánuje jako dřív.
import { AUTH_ERROR_MESSAGE, tryRequireUser } from '@/lib/auth/requireUser'
import { createClient } from '@/lib/supabase/server'
import { entityId } from '@/lib/validation/schemas'
import { engagementKindLabel } from '@/lib/domain'
import { logError } from '@/lib/log'

export type MeetingMilestoneOption = {
  id: number
  title: string
  /** „Workshop · EDU" — druh dodávky, ke které milník patří. */
  engagementLabel: string
  dueOn: string | null
  /** Termín už je převzatý z jiné schůzky. */
  dueFromMeeting: boolean
}

export type MeetingMilestoneOptions =
  | { ok: true; available: boolean; options: MeetingMilestoneOption[] }
  | { ok: false; error: string }

const OPEN_STATUSES = ['pripraveno', 'v_praci', 'ceka_na_vstup', 'ceka_na_schvaleni']
const MISSING = new Set(['42703', 'PGRST204', '42P01', 'PGRST205'])

export async function findMeetingMilestones(accountId: unknown): Promise<MeetingMilestoneOptions> {
  if (!await tryRequireUser({ aal2: true })) return { ok: false, error: AUTH_ERROR_MESSAGE }
  const parsed = entityId.safeParse(accountId)
  if (!parsed.success) return { ok: false, error: 'Neplatné ID.' }
  const s = await createClient()

  const engagements = await s.from('engagement').select('id, kind').eq('account_id', parsed.data)
  if (engagements.error) {
    logError('action.meetingMilestones.engagement', engagements.error)
    return { ok: false, error: 'Dodávky klienta se nepodařilo načíst.' }
  }
  const kinds = new Map(((engagements.data ?? []) as { id: number; kind: string | null }[]).map((e) => [e.id, e.kind]))
  if (kinds.size === 0) return { ok: true, available: true, options: [] }

  const { data, error } = await s.from('engagement_milestone')
    .select('id, title, status, due_on, due_from_activity_id, engagement_id')
    .in('engagement_id', [...kinds.keys()])
    .in('status', OPEN_STATUSES)
    .order('due_on', { ascending: true, nullsFirst: false })
    .order('id', { ascending: true })
  if (error) {
    if (MISSING.has(String((error as { code?: unknown }).code ?? ''))) return { ok: true, available: false, options: [] }
    logError('action.meetingMilestones.milestone', error)
    return { ok: false, error: 'Milníky se nepodařilo načíst.' }
  }
  type Row = { id: number; title: string; due_on: string | null; due_from_activity_id: number | null; engagement_id: number }
  return {
    ok: true,
    available: true,
    options: ((data ?? []) as Row[]).map((r) => ({
      id: r.id,
      title: r.title,
      engagementLabel: engagementKindLabel(kinds.get(r.engagement_id) ?? null),
      dueOn: r.due_on,
      dueFromMeeting: r.due_from_activity_id != null,
    })),
  }
}
