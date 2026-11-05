// Čtení kapacit a alokací (kap. 10, migrace 0062_capacity.sql).
//
// Migrace ještě nemusí běžet:
//   * tabulka allocation chybí (42P01 / PGRST205) → stav 'missing_migration',
//     stránka vykreslí klidnou hlášku,
//   * sloupec team_member.weekly_capacity_hours chybí (42703 / PGRST204) →
//     čte se bez něj a počítá s výchozími 40 h (capacityColumn = false).
//
// Bez peněz: z engagement se čte jen id, firma, druh a fáze — žádné
// roi_czk_year ani jiné částky (ty patří obchodním rolím).
import { createClient } from '@/lib/supabase/server'
import { isMissingColumn, isMissingRelation } from '@/core/loopQueries'
import { engagementKindLabel } from '@/lib/domain'
import { DEFAULT_WEEKLY_CAPACITY, capacityOf, targetKey } from '@/domain/delivery/capacity'
import type { Loaded } from '@/domain/delivery/queries/documents'

type Db = Awaited<ReturnType<typeof createClient>>

export type CapacityMember = { id: string; full_name: string; weekly_capacity_hours: number }

export type AllocationRow = {
  id: number
  member_id: string
  engagement_id: number | null
  work_case_id: number | null
  hours_per_week: number
  starts_on: string
  ends_on: string | null
  substitute_id: string | null
  note: string | null
  created_at: string
}

export type AllocationTargetOption = {
  /** Hodnota pro <select> — „engagement:12" / „case:5". */
  key: string
  kind: 'engagement' | 'work_case'
  label: string
  href: string
  /** Běžící dodávka / otevřený případ — jen ty se nabízí u nové alokace. */
  active: boolean
}

export const ALLOCATION_COLUMNS =
  'id, member_id, engagement_id, work_case_id, hours_per_week, starts_on, ends_on, substitute_id, note, created_at'

const ACTIVE_CASE_STATUSES = new Set(['open', 'in_progress', 'waiting'])

/** Chybí sloupec — SELECT (42703) i zápis přes PostgREST (PGRST204). */
export function isMissingColumnOrSchema(err: { code?: string | null; message?: string | null } | null | undefined): boolean {
  return isMissingColumn(err) || err?.code === 'PGRST204'
}

function toAllocation(r: Record<string, unknown>): AllocationRow {
  return {
    id: Number(r.id),
    member_id: String(r.member_id),
    engagement_id: r.engagement_id == null ? null : Number(r.engagement_id),
    work_case_id: r.work_case_id == null ? null : Number(r.work_case_id),
    hours_per_week: Number(r.hours_per_week),
    starts_on: String(r.starts_on),
    ends_on: r.ends_on == null ? null : String(r.ends_on),
    substitute_id: r.substitute_id == null ? null : String(r.substitute_id),
    note: r.note == null ? null : String(r.note),
    created_at: String(r.created_at ?? ''),
  }
}

/** Tým s kapacitou. Před 0062 bez sloupce → všichni 40 h. */
export async function loadTeamCapacity(
  s: Db,
): Promise<{ ok: true; members: CapacityMember[]; capacityColumn: boolean } | { ok: false; message: string }> {
  const withCap = await s.from('team_member').select('id, full_name, weekly_capacity_hours').order('full_name')
  if (!withCap.error) {
    const members = ((withCap.data ?? []) as Record<string, unknown>[]).map((m) => ({
      id: String(m.id),
      full_name: String(m.full_name ?? ''),
      weekly_capacity_hours: capacityOf({ id: String(m.id), weekly_capacity_hours: m.weekly_capacity_hours as number | string | null }),
    }))
    return { ok: true, members, capacityColumn: true }
  }
  if (!isMissingColumnOrSchema(withCap.error)) return { ok: false, message: withCap.error.message }
  const plain = await s.from('team_member').select('id, full_name').order('full_name')
  if (plain.error) return { ok: false, message: plain.error.message }
  const members = ((plain.data ?? []) as Record<string, unknown>[]).map((m) => ({
    id: String(m.id),
    full_name: String(m.full_name ?? ''),
    weekly_capacity_hours: DEFAULT_WEEKLY_CAPACITY,
  }))
  return { ok: true, members, capacityColumn: false }
}

type EngagementRow = { id: number; account_id: number; kind: string; phase: string; account: { name: string } | null }
type CaseRow = { id: number; title: string; status: string }

function engagementOption(e: EngagementRow): AllocationTargetOption {
  return {
    key: targetKey({ engagement_id: e.id, work_case_id: null }),
    kind: 'engagement',
    label: `${e.account?.name ?? 'Dodávka'} · ${engagementKindLabel(e.kind)}`,
    href: `/cockpit/clients/${e.account_id}/engagements/${e.id}/edit`,
    active: e.phase !== 'uzavreno',
  }
}

function caseOption(c: CaseRow): AllocationTargetOption {
  return {
    key: targetKey({ engagement_id: null, work_case_id: c.id }),
    kind: 'work_case',
    label: c.title,
    href: `/cockpit/pripady/${c.id}`,
    active: ACTIVE_CASE_STATUSES.has(c.status),
  }
}

/** Dodávky a případy, na které jde alokovat, s popiskem a odkazem. */
export async function loadAllocationTargets(s: Db): Promise<AllocationTargetOption[]> {
  const [engagements, cases] = await Promise.all([
    s.from('engagement').select('id, account_id, kind, phase, account(name)').order('id', { ascending: false }),
    s.from('work_case').select('id, title, status').order('updated_at', { ascending: false }),
  ])
  const out: AllocationTargetOption[] = []
  if (!engagements.error) {
    for (const e of (engagements.data ?? []) as unknown as EngagementRow[]) {
      out.push(engagementOption(e))
    }
  }
  // work_case (0039) může chybět jen v neúplné DB — pak prostě bez případů.
  if (!cases.error) {
    for (const c of (cases.data ?? []) as CaseRow[]) {
      out.push(caseOption(c))
    }
  }
  return out.sort((a, b) => (a.kind === b.kind ? a.label.localeCompare(b.label, 'cs') : a.kind === 'engagement' ? -1 : 1))
}

export type CapacityOverview = {
  members: CapacityMember[]
  capacityColumn: boolean
  /** Alokace platné od `from` dál (+ skončené, pokud o ně stránka požádala). */
  allocations: AllocationRow[]
  /** Kolik alokací skončilo před dneškem (null = počet se nepodařilo zjistit). */
  endedCount: number | null
  targets: AllocationTargetOption[]
}

/** Kolik skončených alokací se při „Včetně skončených" načte (nejnovější). */
export const ENDED_ALLOCATIONS_LIMIT = 200

/**
 * Chybějící popisky: alokace může mířit na dodávku nebo případ, který
 * v nabídce cílů není (starší, mimo první stránku PostgREST). Dočte se
 * jen ta id, na která se alokace skutečně odkazují.
 */
async function addMissingTargets(s: Db, allocations: readonly AllocationRow[], targets: AllocationTargetOption[]): Promise<void> {
  const known = new Set(targets.map((t) => t.key))
  const engIds = [...new Set(allocations.map((a) => a.engagement_id).filter((id): id is number => id !== null))]
    .filter((id) => !known.has(targetKey({ engagement_id: id, work_case_id: null })))
  const caseIds = [...new Set(allocations.map((a) => a.work_case_id).filter((id): id is number => id !== null))]
    .filter((id) => !known.has(targetKey({ engagement_id: null, work_case_id: id })))
  const [engagements, cases] = await Promise.all([
    engIds.length ? s.from('engagement').select('id, account_id, kind, phase, account(name)').in('id', engIds) : null,
    caseIds.length ? s.from('work_case').select('id, title, status').in('id', caseIds) : null,
  ])
  if (engagements && !engagements.error) {
    for (const e of (engagements.data ?? []) as unknown as EngagementRow[]) {
      targets.push(engagementOption(e))
    }
  }
  if (cases && !cases.error) {
    for (const c of (cases.data ?? []) as CaseRow[]) {
      targets.push(caseOption(c))
    }
  }
}

/**
 * Vše pro /kapacity: tým s kapacitou, alokace a cíle.
 *
 * Skončené alokace se nemažou, tabulka roste. Aby odpověď PostgREST (strop
 * ~1000 řádků) neořízla právě ty běžící, čte se jen to, co platí od `from`
 * (začátek prvního týdne plánu) dál. Skončené dřív jen při `includeEnded`,
 * nejnovější a s limitem.
 */
export async function getCapacityOverview(opts: {
  from: string
  today: string
  includeEnded?: boolean
  /** Klient databáze; výchozí session přihlášeného (RLS). Provozní přehled pro cron předá service role. */
  db?: Db
}): Promise<Loaded<CapacityOverview>> {
  const s = opts.db ?? await createClient()
  const allocs = await s
    .from('allocation')
    .select(ALLOCATION_COLUMNS)
    .or(`ends_on.is.null,ends_on.gte.${opts.from}`)
    .order('starts_on')
    .order('id')
  if (isMissingRelation(allocs.error)) return { state: 'missing_migration' }
  if (allocs.error) return { state: 'error', message: allocs.error.message }
  const [team, targets, ended, endedCount] = await Promise.all([
    loadTeamCapacity(s),
    loadAllocationTargets(s),
    opts.includeEnded
      ? s
          .from('allocation')
          .select(ALLOCATION_COLUMNS)
          .lt('ends_on', opts.from)
          .order('ends_on', { ascending: false })
          .order('id', { ascending: false })
          .limit(ENDED_ALLOCATIONS_LIMIT)
      : null,
    s.from('allocation').select('id', { count: 'exact', head: true }).lt('ends_on', opts.today),
  ])
  if (!team.ok) return { state: 'error', message: team.message }
  if (ended?.error) return { state: 'error', message: ended.error.message }
  const allocations = [...((allocs.data ?? []) as Record<string, unknown>[]), ...((ended?.data ?? []) as Record<string, unknown>[])].map(
    toAllocation,
  )
  await addMissingTargets(s, allocations, targets)
  const count = (endedCount as { count?: number | null; error: unknown }).count
  return {
    state: 'ok',
    members: team.members,
    capacityColumn: team.capacityColumn,
    allocations,
    endedCount: endedCount.error || typeof count !== 'number' ? null : count,
    targets,
  }
}

/** Alokace jedné dodávky (sekce „Kdo na tom pracuje"). */
export async function getEngagementAllocations(engagementId: number): Promise<Loaded<{ allocations: AllocationRow[] }>> {
  const s = await createClient()
  const { data, error } = await s
    .from('allocation')
    .select(ALLOCATION_COLUMNS)
    .eq('engagement_id', engagementId)
    .order('starts_on')
    .order('id')
  if (isMissingRelation(error)) return { state: 'missing_migration' }
  if (error) return { state: 'error', message: error.message }
  return { state: 'ok', allocations: ((data ?? []) as Record<string, unknown>[]).map(toAllocation) }
}
