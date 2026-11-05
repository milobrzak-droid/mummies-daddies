// Čtení cílových seznamů. Tabulky jsou v 0048_target_list.sql, která ještě
// nemusí být aplikovaná — chybějící relace (42P01 / PGRST205) je stav
// „čeká na migraci", ne chyba (vzor core/loopQueries.ts).
import { createClient } from '@/lib/supabase/server'
import { isMissingColumn, isMissingRelation } from '@/core/loopQueries'
import { countsByList, type TargetListCounts, type TargetStatus } from '@/domain/crm/targetLists'
import { contactOptOut, type AccountOptOut } from '@/domain/crm/outreachContacts'
import { loadAccountOptOut } from '@/domain/crm/queries/outreachOptOut'

export type TargetList = {
  id: number
  name: string
  segment: string
  rationale: string
  value_hypothesis: string | null
  owner_id: string | null
  created_at: string
}
export type TargetListRow = TargetList & { counts: TargetListCounts }

export type TargetListItem = {
  id: number
  list_id: number
  account_id: number
  reason: string
  contact_id: number | null
  next_step: string | null
  next_step_due: string | null
  status: TargetStatus
  account: { name: string } | null
  contact: { full_name: string } | null
  /** Hlavní kontakt nesouhlasí s oslovením: políčko (0087), nebo poznámka (druhá pojistka). */
  contact_opt_out: 'flag' | 'note' | null
  /** Kolik lidí u firmy nesouhlasí (a jestli to říká poznámka firmy). */
  account_opt_out: AccountOptOut | null
}

type ItemRow = Omit<TargetListItem, 'account' | 'contact' | 'contact_opt_out' | 'account_opt_out'> & {
  account: { name: string; notes: string | null } | null
  contact: { full_name: string; notes: string | null; do_not_contact?: boolean | null } | null
}

export type Loaded<T> = { state: 'missing_migration' } | { state: 'error'; message: string } | ({ state: 'ok' } & T)

const EMPTY: TargetListCounts = { navrzeno: 0, osloveno: 0, odpovedel: 0, vyrazeno: 0, total: 0 }

export async function getTargetLists(): Promise<Loaded<{ lists: TargetListRow[] }>> {
  const s = await createClient()
  const [lr, ir] = await Promise.all([
    s.from('target_list').select('id, name, segment, rationale, value_hypothesis, owner_id, created_at')
      .order('created_at', { ascending: false }),
    s.from('target_list_item').select('list_id, status'),
  ])
  if (isMissingRelation(lr.error) || isMissingRelation(ir.error)) return { state: 'missing_migration' }
  const err = lr.error ?? ir.error
  if (err) return { state: 'error', message: err.message }
  const counts = countsByList((ir.data ?? []) as { list_id: number; status: TargetStatus }[])
  const lists = ((lr.data ?? []) as TargetList[]).map((l) => ({ ...l, counts: counts.get(l.id) ?? EMPTY }))
  return { state: 'ok', lists }
}

const ITEM_COLUMNS = 'id, list_id, account_id, reason, contact_id, next_step, next_step_due, status, account(name, notes)'

export async function getTargetList(id: number): Promise<Loaded<{ list: TargetList | null; items: TargetListItem[] }>> {
  const s = await createClient()
  // Políčko nesouhlasu (contact.do_not_contact, 0087); bez migrace jen poznámka.
  const items = (optOut: boolean) => s.from('target_list_item')
    .select(`${ITEM_COLUMNS}, contact(full_name, notes${optOut ? ', do_not_contact' : ''})`)
    .eq('list_id', id).order('created_at', { ascending: true })
  const [lr, first] = await Promise.all([
    s.from('target_list').select('id, name, segment, rationale, value_hypothesis, owner_id, created_at')
      .eq('id', id).maybeSingle(),
    items(true),
  ])
  const ir = isMissingColumn(first.error) ? await items(false) : first
  if (isMissingRelation(lr.error) || isMissingRelation(ir.error)) return { state: 'missing_migration' }
  const err = lr.error ?? ir.error
  if (err) return { state: 'error', message: err.message }
  const rows = (ir.data ?? []) as unknown as ItemRow[]

  // Kdo u firmy nesouhlasí s oslovením — štítek u firmy v seznamu. Chyba
  // tohoto čtení seznam neshodí: štítek chybí, ale hlavní kontakt se dál
  // posuzuje z řádku výš a změna stavu na „osloveno" si to ověří sama.
  const notes = new Map(rows.map((r) => [Number(r.account_id), r.account?.notes ?? null]))
  const byAccount = await loadAccountOptOut(s, rows.map((r) => Number(r.account_id)), notes).catch(() => new Map<number, AccountOptOut>())

  return {
    state: 'ok',
    list: (lr.data as TargetList | null) ?? null,
    items: rows.map((r) => ({
      ...r,
      account: r.account ? { name: r.account.name } : null,
      contact: r.contact ? { full_name: r.contact.full_name } : null,
      contact_opt_out: r.contact ? contactOptOut(r.contact) : null,
      account_opt_out: byAccount.get(Number(r.account_id)) ?? null,
    })),
  }
}

export async function listContactOptions(): Promise<{ id: number; full_name: string; account_id: number | null }[]> {
  const s = await createClient()
  const { data, error } = await s.from('contact').select('id, full_name, account_id')
    .not('account_id', 'is', null).order('full_name')
  if (error) throw error
  return data ?? []
}
