// Čtení kontaktů a seznamů k oslovení pro API a MCP (konektor Cockpit
// v Claude Cowork). Servisní klient obchází RLS, proto o přístupu rozhoduje
// volající: lib/mcpServer.ts pustí oba nástroje jen obchodní roli (stejné
// pravidlo jako get_deals a jako RLS can_see_sales() na target_list z 0048).
// Tady se jen čte, nic se nezapisuje. Co smí ven a koho vynechat, řeší čisté
// funkce v domain/crm/outreachContacts.ts.
import { createAdminClient } from '@/lib/supabase/admin'
import { isMissingColumn, isMissingRelation } from '@/core/loopQueries'
import { pragueToday } from '@/lib/pragueDate'
import {
  TARGET_STATUS_LABEL,
  countByStatus,
  countsByList,
  type TargetListCounts,
  type TargetStatus,
} from '@/domain/crm/targetLists'
import {
  CONTACTS_PAGE_DEFAULT,
  OUTREACH_TARGET_STATUSES,
  emptyExcluded,
  mergeLatest,
  outreachBlockReason,
  paginate,
  searchTokens,
  selectOutreachContacts,
  toOutreachContact,
  type ContactCandidate,
  type ExcludedCounts,
  type OutreachBlockReason,
  type OutreachContact,
  type OutreachTargetStatus,
  type TargetRef,
} from '@/domain/crm/outreachContacts'

type Admin = ReturnType<typeof createAdminClient>
type DbError = { code?: string; message: string }
type RangeQuery = { range: (from: number, to: number) => PromiseLike<{ data: unknown; error: DbError | null }> }

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: string }

// PostgREST vrací nejvýš 1000 řádků na dotaz. Čte se po stránkách, dokud
// stránka nepřijde kratší; LOAD_CAP je pojistka proti neomezenému růstu.
// `.in()` jde po dávkách IN_CHUNK, ať adresa dotazu nepřeroste limit.
const LOAD_PAGE = 1000
const LOAD_CAP = 20_000
const IN_CHUNK = 200

export const MISSING_TARGET_LISTS = 'Seznamy k oslovení v databázi ještě nejsou (čekají na migraci 0048).'
export const TARGET_ITEMS_PAGE_DEFAULT = 100
export const TARGET_ITEMS_PAGE_MAX = 500

async function loadAll<T>(make: () => RangeQuery): Promise<{ rows: T[]; truncated: boolean }> {
  const rows: T[] = []
  for (let offset = 0; ; offset += LOAD_PAGE) {
    const { data, error } = await make().range(offset, offset + LOAD_PAGE - 1)
    if (error) throw error
    const page = (data ?? []) as T[]
    rows.push(...page)
    if (page.length < LOAD_PAGE) return { rows, truncated: false }
    if (rows.length >= LOAD_CAP) return { rows, truncated: true }
  }
}

async function loadIn<T>(ids: readonly number[], make: (chunk: number[]) => RangeQuery): Promise<{ rows: T[]; truncated: boolean }> {
  const rows: T[] = []
  let truncated = false
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const chunk = ids.slice(i, i + IN_CHUNK)
    const res = await loadAll<T>(() => make(chunk))
    rows.push(...res.rows)
    truncated ||= res.truncated
  }
  return { rows, truncated }
}

// Políčko „Nesouhlasí s oslovením" (contact.do_not_contact, 0087). Před
// migrací sloupec chybí: čte se bez něj a o nesouhlasu rozhoduje jen
// poznámka (druhá pojistka v outreachContacts.ts) — konektor nespadne.
async function withOptOutColumn<T>(run: (optOut: boolean) => Promise<T>): Promise<T> {
  try {
    return await run(true)
  } catch (e) {
    if (isMissingColumn(e as DbError)) return run(false)
    throw e
  }
}
const optOutColumn = (optOut: boolean) => (optOut ? ', do_not_contact' : '')

const unique = (ids: readonly (number | null | undefined)[]): number[] =>
  [...new Set(ids.filter((v): v is number => v != null).map(Number))]

type AccountRow = { id: number; name: string | null; notes: string | null; snooze_until: string | null }
const ACCOUNT_COLUMNS = 'id, name, notes, snooze_until'

async function loadAccounts(admin: Admin, ids: readonly number[]): Promise<Map<number, AccountRow>> {
  const res = await loadIn<AccountRow>(ids, (chunk) => admin.from('account').select(ACCOUNT_COLUMNS).in('id', chunk).order('id'))
  return new Map(res.rows.map((a) => [Number(a.id), { ...a, id: Number(a.id) }]))
}

// Nejnovější řádky napřed: první výskyt kontaktu je jeho poslední aktivita,
// takže se čte jen tak dlouho, dokud se nenajdou všichni nebo řádky nedojdou.
// Zdroje: záznamy z jednání (sales_activity.contact_id) a e-maily spárované
// přímo na člověka (mail_event.contact_id, 0041 — bez tabulky jen aktivity).
async function loadLastActivity(admin: Admin, contactIds: readonly number[]): Promise<Map<number, string>> {
  const latest = new Map<number, string>()
  if (contactIds.length === 0) return latest
  for (const table of ['sales_activity', 'mail_event'] as const) {
    const seen = new Map<number, string>()
    try {
      for (let offset = 0; offset < LOAD_CAP; offset += LOAD_PAGE) {
        const { data, error } = await admin.from(table).select('contact_id, occurred_at')
          .in('contact_id', [...contactIds])
          .order('occurred_at', { ascending: false })
          .order('id', { ascending: false })
          .range(offset, offset + LOAD_PAGE - 1)
        if (error) throw error
        const rows = (data ?? []) as { contact_id: number | null; occurred_at: string | null }[]
        mergeLatest(seen, rows)
        if (rows.length < LOAD_PAGE || seen.size >= contactIds.length) break
      }
    } catch (e) {
      if (table === 'mail_event' && isMissingRelation(e as DbError)) continue
      throw e
    }
    mergeLatest(latest, [...seen].map(([contact_id, occurred_at]) => ({ contact_id, occurred_at })))
  }
  return latest
}

// ---------------------------------------------------------------------------
// get_contacts

export type ContactsQuery = {
  account_id?: number
  search?: string
  target_list_id?: number
  target_status?: OutreachTargetStatus
  limit?: number
  offset?: number
}

export type ContactsPage = {
  items: OutreachContact[]
  total: number
  next_offset: number | null
  /** Kolik kontaktů odpovídalo dotazu, ale oslovit se nesmí (bez jmen). */
  excluded: ExcludedCounts
  target_list?: { id: number; name: string }
  /** Data přesáhla pojistku načítání; výsledek může být neúplný. */
  truncated?: true
}

type ContactRow = {
  id: number; full_name: string; role: string | null; email: string | null
  phone: string | null; notes: string | null; account_id: number | null; do_not_contact?: boolean | null
}
type ItemRefRow = { id: number; list_id: number; account_id: number; contact_id: number | null; status: TargetStatus }

const CONTACT_COLUMNS = 'id, full_name, role, email, phone, notes, account_id'

/**
 * Kontakty u klientů k oslovení: filtr firmy, hledání, seznam k oslovení
 * a jeho stav, stránka. Kontakty, které se oslovit nesmí, se vynechají
 * a jen spočítají (domain/crm/outreachContacts.ts).
 */
export async function listContactsForApi(q: ContactsQuery, today: string = pragueToday()): Promise<ApiResult<ContactsPage>> {
  const admin = createAdminClient()
  const limit = q.limit ?? CONTACTS_PAGE_DEFAULT
  const offset = q.offset ?? 0
  let truncated = false

  // 1) Seznam k oslovení: které firmy v něm jsou a v jakém stavu.
  let targets: Map<number, TargetRef> | null = null
  let targetList: { id: number; name: string } | undefined
  if (q.target_list_id !== undefined) {
    const listId = q.target_list_id
    const list = await admin.from('target_list').select('id, name').eq('id', listId).maybeSingle()
    if (isMissingRelation(list.error)) return { ok: false, error: MISSING_TARGET_LISTS }
    if (list.error) throw list.error
    if (!list.data) return { ok: false, error: `Seznam k oslovení s id ${listId} neexistuje.` }
    const row = list.data as { id: number; name: string }
    targetList = { id: Number(row.id), name: String(row.name) }
    const statuses: readonly TargetStatus[] = q.target_status ? [q.target_status] : OUTREACH_TARGET_STATUSES
    const items = await loadAll<ItemRefRow>(() => admin.from('target_list_item')
      .select('id, list_id, account_id, contact_id, status')
      .eq('list_id', listId)
      .in('status', [...statuses])
      .order('id'))
    truncated ||= items.truncated
    targets = new Map(items.rows.map((r) => [Number(r.account_id), {
      item_id: Number(r.id),
      list_id: Number(r.list_id),
      account_id: Number(r.account_id),
      contact_id: r.contact_id == null ? null : Number(r.contact_id),
      status: r.status,
    }]))
  }

  // 2) Kontakty u klientů. Partnerské kontakty (account_id null) sem nepatří.
  let accountIds: number[] | null = targets ? [...targets.keys()] : null
  if (q.account_id !== undefined) {
    accountIds = accountIds ? accountIds.filter((id) => id === q.account_id) : [q.account_id]
  }
  const contacts = await withOptOutColumn((optOut) => {
    const contactQuery = () => admin.from('contact').select(CONTACT_COLUMNS + optOutColumn(optOut)).not('account_id', 'is', null)
    return accountIds === null
      ? loadAll<ContactRow>(() => contactQuery().order('id'))
      : loadIn<ContactRow>(accountIds, (chunk) => contactQuery().in('account_id', chunk).order('id'))
  })
  truncated ||= contacts.truncated

  // 3) Firmy kontaktů: název, poznámka, odložené oslovení.
  const accounts = await loadAccounts(admin, unique(contacts.rows.map((c) => c.account_id)))
  const candidates: ContactCandidate[] = contacts.rows.map((c) => ({
    id: Number(c.id),
    full_name: String(c.full_name ?? ''),
    role: c.role ?? null,
    email: c.email ?? null,
    phone: c.phone ?? null,
    notes: c.notes ?? null,
    do_not_contact: c.do_not_contact === true,
    account: c.account_id == null ? null : accounts.get(Number(c.account_id)) ?? null,
  }))

  // 4) Výběr, vynechání těch, kdo nechtějí, a stránka.
  const { selected, excluded } = selectOutreachContacts({ candidates, today, search: searchTokens(q.search), targets })
  const page = paginate(selected, limit, offset)

  // 5) Poslední aktivita jen pro kontakty na stránce.
  const lastActivity = await loadLastActivity(admin, page.items.map((s) => s.candidate.id))

  return {
    ok: true,
    data: {
      items: page.items.map((s) => toOutreachContact(s, lastActivity)),
      total: page.total,
      next_offset: page.next_offset,
      excluded,
      ...(targetList ? { target_list: targetList } : {}),
      ...(truncated ? { truncated: true as const } : {}),
    },
  }
}

// ---------------------------------------------------------------------------
// get_target_list

export type TargetListQuery = { list_id?: number; status?: TargetStatus; limit?: number; offset?: number }

export type ApiTargetList = {
  id: number
  name: string
  segment: string
  rationale: string
  value_hypothesis: string | null
  owner: string | null
  created_at: string
  counts: TargetListCounts
}

export type ApiTargetListItem = {
  id: number
  account: { id: number; name: string | null }
  reason: string
  status: TargetStatus
  status_label: string
  next_step: string | null
  next_step_due: string | null
  /** Koho oslovit (jméno a pozice). E-mail a telefon vrací get_contacts. */
  main_contact: { id: number; full_name: string; role: string | null } | null
  /** Proč se firmu (hlavní kontakt) teď oslovit nesmí; null = smí. */
  outreach_blocked: OutreachBlockReason | null
}

export type TargetListsResult =
  | { lists: ApiTargetList[] }
  | {
    list: ApiTargetList
    items: ApiTargetListItem[]
    total: number
    next_offset: number | null
    /** Položky na této stránce, u kterých se hlavní kontakt nevrací (outreach_blocked), podle důvodu. */
    excluded: ExcludedCounts
    truncated?: true
  }

type ListRow = {
  id: number; name: string; segment: string; rationale: string
  value_hypothesis: string | null; owner_id: string | null; created_at: string
}
type ItemRow = {
  id: number; account_id: number; contact_id: number | null; reason: string
  next_step: string | null; next_step_due: string | null; status: TargetStatus; created_at: string
}
type MainContactRow = { id: number; full_name: string; role: string | null; notes: string | null; do_not_contact?: boolean | null }

const LIST_COLUMNS = 'id, name, segment, rationale, value_hypothesis, owner_id, created_at'
const EMPTY_COUNTS: TargetListCounts = { navrzeno: 0, osloveno: 0, odpovedel: 0, vyrazeno: 0, total: 0 }

async function ownerNames(admin: Admin, ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((v): v is string => !!v))]
  if (wanted.length === 0) return new Map()
  const { data, error } = await admin.from('team_member').select('id, full_name').in('id', wanted)
  if (error) throw error
  return new Map(((data ?? []) as { id: string; full_name: string | null }[]).map((m) => [m.id, m.full_name ?? '']))
}

function toApiList(l: ListRow, counts: TargetListCounts, owners: ReadonlyMap<string, string>): ApiTargetList {
  return {
    id: Number(l.id),
    name: l.name,
    segment: l.segment,
    rationale: l.rationale,
    value_hypothesis: l.value_hypothesis ?? null,
    owner: l.owner_id ? owners.get(l.owner_id) ?? null : null,
    created_at: l.created_at,
    counts,
  }
}

/**
 * Bez list_id: všechny seznamy s počty firem podle stavu oslovení.
 * S list_id: seznam a stránka jeho položek (firma, důvod, stav, další krok,
 * hlavní kontakt). Hlavní kontakt, který se oslovit nesmí, se nevrací.
 */
export async function getTargetListForApi(q: TargetListQuery, today: string = pragueToday()): Promise<ApiResult<TargetListsResult>> {
  const admin = createAdminClient()

  if (q.list_id === undefined) {
    const lists = await admin.from('target_list').select(LIST_COLUMNS).order('created_at', { ascending: false }).order('id')
    if (isMissingRelation(lists.error)) return { ok: false, error: MISSING_TARGET_LISTS }
    if (lists.error) throw lists.error
    const rows = (lists.data ?? []) as ListRow[]
    const items = await loadAll<{ list_id: number; status: TargetStatus }>(() =>
      admin.from('target_list_item').select('list_id, status').order('id'))
    const counts = countsByList(items.rows.map((i) => ({ list_id: Number(i.list_id), status: i.status })))
    const owners = await ownerNames(admin, rows.map((l) => l.owner_id))
    return { ok: true, data: { lists: rows.map((l) => toApiList(l, counts.get(Number(l.id)) ?? EMPTY_COUNTS, owners)) } }
  }

  const listId = q.list_id
  const list = await admin.from('target_list').select(LIST_COLUMNS).eq('id', listId).maybeSingle()
  if (isMissingRelation(list.error)) return { ok: false, error: MISSING_TARGET_LISTS }
  if (list.error) throw list.error
  if (!list.data) return { ok: false, error: `Seznam k oslovení s id ${listId} neexistuje.` }

  const all = await loadAll<ItemRow>(() => admin.from('target_list_item')
    .select('id, account_id, contact_id, reason, next_step, next_step_due, status, created_at')
    .eq('list_id', listId)
    .order('created_at')
    .order('id'))
  const filtered = q.status ? all.rows.filter((r) => r.status === q.status) : all.rows
  const page = paginate(filtered, q.limit ?? TARGET_ITEMS_PAGE_DEFAULT, q.offset ?? 0)

  const [accounts, contacts, owners] = await Promise.all([
    loadAccounts(admin, unique(page.items.map((r) => r.account_id))),
    withOptOutColumn((optOut) => loadIn<MainContactRow>(unique(page.items.map((r) => r.contact_id)), (chunk) =>
      admin.from('contact').select('id, full_name, role, notes' + optOutColumn(optOut)).in('id', chunk).order('id'))),
    ownerNames(admin, [(list.data as ListRow).owner_id]),
  ])
  const contactById = new Map(contacts.rows.map((c) => [Number(c.id), c]))

  const excluded = emptyExcluded()
  const items: ApiTargetListItem[] = page.items.map((r) => {
    const account = accounts.get(Number(r.account_id)) ?? null
    const contact = r.contact_id == null ? null : contactById.get(Number(r.contact_id)) ?? null
    const blocked = outreachBlockReason({ notes: contact?.notes ?? null, do_not_contact: contact?.do_not_contact === true, account }, today)
    if (blocked) {
      excluded.count += 1
      excluded[blocked] += 1
    }
    return {
      id: Number(r.id),
      account: { id: Number(r.account_id), name: account?.name ?? null },
      reason: r.reason,
      status: r.status,
      status_label: TARGET_STATUS_LABEL[r.status] ?? r.status,
      next_step: r.next_step ?? null,
      next_step_due: r.next_step_due ?? null,
      main_contact: contact && !blocked
        ? { id: Number(contact.id), full_name: contact.full_name, role: contact.role ?? null }
        : null,
      outreach_blocked: blocked,
    }
  })

  return {
    ok: true,
    data: {
      list: toApiList(list.data as ListRow, countByStatus(all.rows), owners),
      items,
      total: page.total,
      next_offset: page.next_offset,
      excluded,
      ...(all.truncated || contacts.truncated ? { truncated: true as const } : {}),
    },
  }
}
