// Přehled otevřené práce člena týmu pro „Předat práci" a pro kontrolu před
// deaktivací (lib/actions/team.ts). Čte se servisním klientem: správce týmu
// nemusí mít obchodní roli, ale musí vidět, že člověk nějaké obchody má.
// Volat JEN po requireAdmin (stránka /tym/[id]/predat a akce správce).
// Názvy obchodů bez obchodní role nevydáváme (can_see_sales, 0058) — jen počet.
//
// Každý druh se čte zvlášť; chybějící tabulka nebo sloupec (migrace ještě
// neběžela) = 'unavailable', jiná chyba = 'error' (kontrola před deaktivací
// pak nepustí bez výslovného potvrzení).
import { createAdminClient } from '@/lib/supabase/admin'
import { COMPANY } from '@/config'
import { engagementKindLabel } from '@/lib/domain'
import { logError } from '@/lib/log'
import {
  CLOSED_DEAL_STAGES,
  CLOSED_ENGAGEMENT_PHASE,
  CLOSED_MILESTONE_STATUS,
  DONE_TASK_STATUS,
  OPEN_CASE_STATUSES,
  allocationIsOpen,
  buildMemberWork,
  type MemberWork,
  type WorkGroup,
  type WorkItem,
  type WorkKind,
} from '@/lib/memberWork'

type Admin = ReturnType<typeof createAdminClient>
type Err = { code?: string | null; message?: string | null } | null
type Joined<T> = T | T[] | null
const one = <T,>(v: Joined<T>): T | null => (Array.isArray(v) ? (v[0] ?? null) : v)

// lib/ nesmí importovat core/ — kopie isMissingRelation/isMissingColumn (core/loopQueries.ts).
function isMissing(err: Err): boolean {
  if (!err) return false
  if (['42P01', 'PGRST205', '42703', 'PGRST204'].includes(err.code ?? '')) return true
  return /relation .* does not exist|could not find the table|column .* does not exist/i.test(err.message ?? '')
}

async function group(kind: WorkKind, load: () => Promise<{ items: WorkItem[]; error: Err; hiddenTitles?: boolean }>): Promise<WorkGroup> {
  try {
    const r = await load()
    if (r.error) {
      if (isMissing(r.error)) return { kind, state: 'unavailable', items: [] }
      logError(`memberWork.${kind}`, r.error)
      return { kind, state: 'error', items: [] }
    }
    return { kind, state: 'ok', items: r.items, hiddenTitles: r.hiddenTitles }
  } catch (e) {
    logError(`memberWork.${kind}`, e)
    return { kind, state: 'error', items: [] }
  }
}

const roleOf = (id: string, owner: string | null, ownerWord = 'vlastník') => (owner === id ? ownerWord : 'zástupce')
const orOwner = (id: string, ownerCol: string, deputyCol: string) => `${ownerCol}.eq.${id},${deputyCol}.eq.${id}`

export async function loadMemberOpenWork(
  memberId: string,
  opts: { canSeeSales: boolean; today: string; admin?: Admin },
): Promise<MemberWork> {
  const db = opts.admin ?? createAdminClient()
  const id = memberId

  const groups = await Promise.all([
    group('klienti', async () => {
      const { data, error } = await db.from('account').select('id, name').eq('owner_id', id).order('name')
      const items = ((data ?? []) as { id: number; name: string | null }[]).map((a) => ({
        id: String(a.id), title: a.name?.trim() || `Klient č. ${a.id}`, href: `/cockpit/clients/${a.id}`, role: 'vlastník firmy',
      }))
      return { items, error }
    }),
    group('obchody', async () => {
      const { data, error } = await db
        .from('deal')
        .select('id, title, stage, account_id, account:account!deal_account_id_fkey(name)')
        .eq('owner_id', id)
        .order('id')
      const rows = ((data ?? []) as unknown as { id: number; title: string | null; stage: string; account_id: number; account: Joined<{ name: string | null }> }[])
        .filter((d) => !CLOSED_DEAL_STAGES.includes(d.stage))
      const items = rows.map((d) => opts.canSeeSales
        ? {
            id: String(d.id),
            title: d.title?.trim() || `Obchod č. ${d.id}`,
            href: `/cockpit/clients/${d.account_id}/deals/${d.id}`,
            role: 'obchodník',
            detail: one(d.account)?.name ?? null,
          }
        : { id: String(d.id), title: 'Obchod (název vidí jen obchodní role)', href: null, role: 'obchodník' })
      return { items, error, hiddenTitles: !opts.canSeeSales && items.length > 0 }
    }),
    group('seznamy', async () => {
      // Cílový seznam nemá stav „uzavřeno": předává se každý seznam člověka.
      const { data, error } = await db.from('target_list').select('id, name, segment').eq('owner_id', id).order('name')
      const rows = (data ?? []) as { id: number; name: string | null; segment: string | null }[]
      const items = rows.map((l) => opts.canSeeSales
        ? {
            id: String(l.id),
            title: l.name?.trim() || `Seznam č. ${l.id}`,
            href: `/cockpit/cilove-seznamy/${l.id}`,
            role: 'vlastník seznamu',
            detail: l.segment?.trim() || null,
          }
        : { id: String(l.id), title: 'Cílový seznam (název vidí jen obchodní role)', href: null, role: 'vlastník seznamu' })
      return { items, error, hiddenTitles: !opts.canSeeSales && items.length > 0 }
    }),
    group('dodavky', async () => {
      const { data, error } = await db
        .from('engagement')
        .select('id, kind, phase, account_id, owner_id, deputy_id, account(name)')
        .or(orOwner(id, 'owner_id', 'deputy_id'))
        .neq('phase', CLOSED_ENGAGEMENT_PHASE)
        .order('id')
      const items = ((data ?? []) as unknown as { id: number; kind: string; account_id: number; owner_id: string | null; account: Joined<{ name: string | null }> }[])
        .map((e) => ({
          id: String(e.id),
          title: [one(e.account)?.name?.trim(), engagementKindLabel(e.kind)].filter(Boolean).join(' · '),
          href: `/cockpit/clients/${e.account_id}/engagements/${e.id}/edit?zalozka=tym`,
          role: roleOf(id, e.owner_id),
        }))
      return { items, error }
    }),
    group('milniky', async () => {
      const { data, error } = await db
        .from('engagement_milestone')
        .select('id, title, status, due_on, engagement_id, owner_id, deputy_id, engagement(account_id, account(name))')
        .or(orOwner(id, 'owner_id', 'deputy_id'))
        .neq('status', CLOSED_MILESTONE_STATUS)
        .order('due_on', { ascending: true, nullsFirst: false })
      const items = ((data ?? []) as unknown as {
        id: number; title: string; due_on: string | null; engagement_id: number; owner_id: string | null
        engagement: Joined<{ account_id: number | null; account: Joined<{ name: string | null }> }>
      }[]).map((m) => {
        const eng = one(m.engagement)
        return {
          id: String(m.id),
          title: m.title,
          href: eng?.account_id ? `/cockpit/clients/${eng.account_id}/engagements/${m.engagement_id}/edit?zalozka=milniky` : null,
          role: roleOf(id, m.owner_id),
          detail: [one(eng?.account ?? null)?.name, m.due_on ? `termín ${m.due_on}` : null].filter(Boolean).join(' · ') || null,
        }
      })
      return { items, error }
    }),
    group('ukoly', async () => {
      const { data, error } = await db
        .from('task')
        .select('id, title, due_on, status')
        .eq('assignee_id', id)
        .neq('status', DONE_TASK_STATUS)
        .order('due_on', { ascending: true, nullsFirst: false })
      const items = ((data ?? []) as { id: number; title: string; due_on: string | null }[]).map((t) => ({
        id: String(t.id), title: t.title, href: '/cockpit/tasks', role: 'řešitel', detail: t.due_on ? `termín ${t.due_on}` : null,
      }))
      return { items, error }
    }),
    group('pripady', async () => {
      const { data, error } = await db
        .from('work_case')
        .select('id, title, status, lead_owner_id')
        .or(orOwner(id, 'lead_owner_id', 'deputy_id'))
        .in('status', [...OPEN_CASE_STATUSES])
        .order('id')
      const items = ((data ?? []) as { id: number; title: string; lead_owner_id: string | null }[]).map((c) => ({
        id: String(c.id), title: c.title, href: `/cockpit/pripady/${c.id}`, role: roleOf(id, c.lead_owner_id),
      }))
      return { items, error }
    }),
    group('alokace', async () => {
      const { data, error } = await db
        .from('allocation')
        .select('id, member_id, substitute_id, engagement_id, work_case_id, hours_per_week, starts_on, ends_on, engagement(account_id, kind, account(name)), work_case(title)')
        .or(orOwner(id, 'member_id', 'substitute_id'))
        .order('starts_on')
      const items = ((data ?? []) as unknown as {
        id: number; member_id: string; engagement_id: number | null; work_case_id: number | null; hours_per_week: number | string
        starts_on: string; ends_on: string | null
        engagement: Joined<{ account_id: number; kind: string; account: Joined<{ name: string | null }> }>; work_case: Joined<{ title: string }>
      }[])
        .filter((a) => allocationIsOpen(a, opts.today))
        .map((a) => {
          const eng = one(a.engagement)
          const wc = one(a.work_case)
          const title = eng
            ? [one(eng.account)?.name?.trim(), engagementKindLabel(eng.kind)].filter(Boolean).join(' · ')
            : wc?.title ?? 'Alokace'
          const href = eng && a.engagement_id ? `/cockpit/clients/${eng.account_id}/engagements/${a.engagement_id}/edit?zalozka=tym` : a.work_case_id ? `/cockpit/pripady/${a.work_case_id}` : null
          return {
            id: String(a.id),
            title,
            href,
            role: a.member_id === id ? 'pracuje' : 'zástup',
            detail: `${Number(a.hours_per_week).toLocaleString('cs-CZ')} h/týden · od ${a.starts_on}${a.ends_on ? ` do ${a.ends_on}` : ''}`,
          }
        })
      return { items, error }
    }),
    group('oblasti', async () => {
      const { data, error } = await db.from('loop_node').select('node, owner_id, deputy_id').or(orOwner(id, 'owner_id', 'deputy_id'))
      const labels = COMPANY.nodeLabels as Readonly<Record<string, string>>
      const items = ((data ?? []) as { node: string; owner_id: string | null }[]).map((n) => ({
        id: n.node, title: labels[n.node] ?? n.node, href: null, role: roleOf(id, n.owner_id, 'vlastník oblasti'),
      }))
      return { items, error }
    }),
  ])

  return buildMemberWork(groups)
}
