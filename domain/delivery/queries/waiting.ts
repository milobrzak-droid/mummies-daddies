// Čtení pro hlídání čekání: milníky dodávek, které čekají na klienta.
// Skládá čisté funkce z domain/delivery/waiting.ts nad skutečnými daty.
//
// Hlavní dotaz (milníky ve stavu čekání) je povinný: když selže, karta ukáže
// chybu. Vedlejší zdroje (audit → od kdy čekáme, úkoly → připomínka už je,
// kontakt klienta) jen zpřesňují; když selžou, karta se ukáže bez nich
// (čas čekání se pak bere z updated_at) a chyba se zaloguje.
import { createClient } from '@/lib/supabase/server'
import { isMissingRelation } from '@/core/loopQueries'
import { isMissingColumnError } from '@/domain/crm/dealInvariant'
import { logError } from '@/lib/log'
import { pragueToday } from '@/lib/pragueDate'
import type { Loaded } from '@/domain/delivery/queries/documents'
import {
  MILESTONE_MOVE_ACTIONS,
  REMINDER_TITLE_PREFIX,
  WAITING_STATUSES,
  buildWaitingItems,
  lastStatusMoves,
  type ClientContact,
  type MilestoneAuditEvent,
  type WaitingItem,
  type WaitingMilestoneRow,
} from '@/domain/delivery/waiting'

type Joined<T> = T | T[] | null
const one = <T,>(v: Joined<T>): T | null => (Array.isArray(v) ? (v[0] ?? null) : v)
type Db = Awaited<ReturnType<typeof createClient>>

type RawMilestone = {
  id: number
  engagement_id: number
  title: string
  owner_id: string | null
  status: string
  due_on: string | null
  updated_at: string | null
  created_at: string | null
  engagement: Joined<{
    id: number
    account_id: number
    kind: string
    phase: string
    account: Joined<{ name: string | null }>
  }>
}

export const WAITING_MILESTONE_COLUMNS =
  'id, engagement_id, title, owner_id, status, due_on, updated_at, created_at, engagement(id, account_id, kind, phase, account(name))'

/** Tvar řádku z dotazu → tvar pro čistou funkci. Nejdřív dodávka a klient, ať chybějící vazba nic neshodí. */
export function shapeWaitingMilestones(rows: readonly RawMilestone[]): WaitingMilestoneRow[] {
  return rows.map((r) => {
    const eng = one(r.engagement)
    return {
      id: r.id,
      engagement_id: r.engagement_id,
      title: r.title,
      owner_id: r.owner_id,
      status: r.status,
      due_on: r.due_on,
      updated_at: r.updated_at,
      created_at: r.created_at,
      engagement: eng
        ? { id: eng.id, account_id: eng.account_id, kind: eng.kind, phase: eng.phase, account_name: one(eng.account)?.name ?? null }
        : null,
    }
  })
}

/**
 * Milníky, které čekají na klienta (na podklady nebo na schválení).
 * `engagementId` zúží výběr na jednu dodávku (karta v přehledu dodávky).
 * `db` = klient databáze; výchozí session přihlášeného (RLS), provozní
 * přehled pro cron předá service role.
 */
export async function getWaitingItems(opts: { engagementId?: number; today?: string; db?: Db } = {}): Promise<Loaded<{ items: WaitingItem[] }>> {
  const s = opts.db ?? await createClient()
  let q = s.from('engagement_milestone').select(WAITING_MILESTONE_COLUMNS).in('status', [...WAITING_STATUSES])
  if (opts.engagementId !== undefined) q = q.eq('engagement_id', opts.engagementId)
  const { data, error } = await q
  if (isMissingRelation(error)) return { state: 'missing_migration' }
  if (error) return { state: 'error', message: error.message }

  const milestones = shapeWaitingMilestones((data ?? []) as unknown as RawMilestone[])
    .filter((m) => m.engagement !== null && m.engagement.phase !== 'uzavreno')
  if (milestones.length === 0) return { state: 'ok', items: [] }

  const ids = milestones.map((m) => m.id)
  const engIds = [...new Set(milestones.map((m) => m.engagement_id))]

  const [audit, tasks, sponsors] = await Promise.all([
    s.from('audit_event')
      .select('entity_id, action, occurred_at, after')
      .eq('entity_table', 'engagement_milestone')
      .in('entity_id', ids)
      .in('action', [...MILESTONE_MOVE_ACTIONS])
      .order('occurred_at', { ascending: false })
      .limit(1000),
    s.from('task')
      .select('engagement_id, title')
      .in('engagement_id', engIds)
      .neq('status', 'done')
      .like('title', `${REMINDER_TITLE_PREFIX}%`),
    s.from('engagement').select('id, client_sponsor_contact_id').in('id', engIds),
  ])

  if (audit.error) logError('waiting.audit', audit.error)
  if (tasks.error) logError('waiting.tasks', tasks.error)
  if (sponsors.error && !isMissingColumnError(sponsors.error)) logError('waiting.sponsors', sponsors.error)

  const moves = audit.error ? new Map<number, string>() : lastStatusMoves((audit.data ?? []) as unknown as MilestoneAuditEvent[])

  const openReminders = new Map<number, Set<string>>()
  for (const t of (tasks.error ? [] : (tasks.data ?? [])) as { engagement_id: number | null; title: string }[]) {
    if (t.engagement_id === null) continue
    const set = openReminders.get(t.engagement_id) ?? new Set<string>()
    set.add(t.title)
    openReminders.set(t.engagement_id, set)
  }

  const contacts = new Map<number, ClientContact>()
  const sponsorRows = (sponsors.error ? [] : (sponsors.data ?? [])) as { id: number; client_sponsor_contact_id: number | null }[]
  const contactIds = [...new Set(sponsorRows.map((r) => r.client_sponsor_contact_id).filter((v): v is number => v !== null))]
  if (contactIds.length > 0) {
    const { data: cs, error: ce } = await s.from('contact').select('id, full_name, email').in('id', contactIds)
    if (ce) logError('waiting.contacts', ce)
    const byId = new Map(((ce ? [] : (cs ?? [])) as { id: number; full_name: string | null; email: string | null }[]).map((c) => [c.id, c]))
    for (const r of sponsorRows) {
      const c = r.client_sponsor_contact_id === null ? undefined : byId.get(r.client_sponsor_contact_id)
      if (c) contacts.set(r.id, { name: c.full_name, email: c.email })
    }
  }

  return {
    state: 'ok',
    items: buildWaitingItems({ milestones, moves, openReminders, contacts, today: opts.today ?? pragueToday() }),
  }
}
