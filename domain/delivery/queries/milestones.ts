// Čtení milníků a předávacího balíčku dodávky. Tabulka engagement_milestone
// je v 0042, sloupce balíčku v 0054 — obě migrace ještě nemusí být
// aplikované. Chybějící relace (42P01 / PGRST205) nebo sloupec (42703 /
// PGRST204) je stav „čeká na migraci", ne chyba (vzor queries/documents.ts).
import { createClient } from '@/lib/supabase/server'
import { isMissingRelation } from '@/core/loopQueries'
import { isMissingColumnError } from '@/domain/crm/dealInvariant'
import type { MilestoneStatus } from '@/domain/delivery/milestone'
import type { Loaded } from '@/domain/delivery/queries/documents'

export type EngagementMilestone = {
  id: number
  engagement_id: number
  title: string
  owner_id: string | null
  deputy_id: string | null
  status: MilestoneStatus
  due_on: string | null
  accepted_at: string | null
  accepted_by_contact_id: number | null
  acceptance_evidence_id: number | null
  created_at: string
}

export const MILESTONE_COLUMNS =
  'id, engagement_id, title, owner_id, deputy_id, status, due_on, accepted_at, accepted_by_contact_id, acceptance_evidence_id, created_at'

export async function getEngagementMilestones(
  engagementId: number,
): Promise<Loaded<{ milestones: EngagementMilestone[] }>> {
  const s = await createClient()
  const { data, error } = await s
    .from('engagement_milestone')
    .select(MILESTONE_COLUMNS)
    .eq('engagement_id', engagementId)
    .order('due_on', { ascending: true, nullsFirst: false })
    .order('id', { ascending: true })
  if (isMissingRelation(error)) return { state: 'missing_migration' }
  if (error) return { state: 'error', message: error.message }
  return { state: 'ok', milestones: (data ?? []) as EngagementMilestone[] }
}

/**
 * Verze dokumentu, kterou klient přijal (engagement_milestone.
 * acceptance_document_version_id, 0094): id milníku → číslo verze (null, když ho
 * SharePoint nevrátil). Doplněk k přehledu milníků: bez migrace 0094 nebo při
 * chybě je to prázdné a milníky se ukážou jako dřív.
 */
export async function getMilestoneAcceptedVersions(engagementId: number): Promise<Record<number, string | null>> {
  const s = await createClient()
  const { data, error } = await s
    .from('engagement_milestone')
    .select('id, acceptance_document_version_id')
    .eq('engagement_id', engagementId)
    .not('acceptance_document_version_id', 'is', null)
  if (error) return {}
  const rows = (data ?? []) as unknown as { id: number; acceptance_document_version_id: number }[]
  if (rows.length === 0) return {}
  const { data: versions, error: versionsError } = await s
    .from('engagement_document_version')
    .select('id, version_label')
    .in('id', [...new Set(rows.map((r) => r.acceptance_document_version_id))])
  const labels = new Map<number, string | null>()
  if (!versionsError) {
    for (const v of (versions ?? []) as unknown as { id: number; version_label: string | null }[]) labels.set(v.id, v.version_label)
  }
  return Object.fromEntries(rows.map((r) => [r.id, labels.get(r.acceptance_document_version_id) ?? null]))
}

export type HandoffRow = {
  goal: string | null
  scope: string | null
  client_sponsor_contact_id: number | null
  financial_frame: string | null
  risks: string[] | null
  handoff_completed_at: string | null
  handoff_by: string | null
}

export const HANDOFF_COLUMNS =
  'goal, scope, client_sponsor_contact_id, financial_frame, risks, handoff_completed_at, handoff_by'

export async function getEngagementHandoff(engagementId: number): Promise<Loaded<{ handoff: HandoffRow }>> {
  const s = await createClient()
  const { data, error } = await s.from('engagement').select(HANDOFF_COLUMNS).eq('id', engagementId).maybeSingle()
  if (isMissingColumnError(error)) return { state: 'missing_migration' }
  if (error) return { state: 'error', message: error.message }
  if (!data) return { state: 'error', message: 'engagement nenalezen' }
  return { state: 'ok', handoff: data as HandoffRow }
}
