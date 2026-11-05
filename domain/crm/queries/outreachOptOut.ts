// Kdo u firmy nesouhlasí s oslovením — pro frontu Oslovování (stránka,
// přehled Obchodů, ranní přehled e-mailem) a seznamy k oslovení v aplikaci.
// Čte kontakty firem (políčko do_not_contact z 0087 a poznámku jako druhou
// pojistku) a poznámky firem; rozhodují čisté funkce
// v domain/crm/outreachContacts.ts. Funguje s uživatelským i servisním
// klientem (volající rozhoduje, kdo smí číst).
import type { SupabaseClient } from '@supabase/supabase-js'
import { isMissingColumn } from '@/core/loopQueries'
import { summarizeAccountOptOut, type AccountOptOut, type OptOutFields } from '@/domain/crm/outreachContacts'

type Db = Pick<SupabaseClient, 'from'>
type DbError = { code?: string; message: string }

const IN_CHUNK = 200
const PAGE = 1000

type ContactOptOutRow = OptOutFields & { account_id: number | null }

async function readPaged<T>(run: (from: number, to: number) => PromiseLike<{ data: unknown; error: DbError | null }>): Promise<T[]> {
  const rows: T[] = []
  for (let offset = 0; ; offset += PAGE) {
    const { data, error } = await run(offset, offset + PAGE - 1)
    if (error) throw error
    const page = (Array.isArray(data) ? data : []) as T[]
    rows.push(...page)
    if (page.length < PAGE) return rows
  }
}

async function loadContacts(db: Db, ids: readonly number[], optOut: boolean): Promise<ContactOptOutRow[]> {
  const cols = optOut ? 'id, account_id, notes, do_not_contact' : 'id, account_id, notes'
  const out: ContactOptOutRow[] = []
  for (let i = 0; i < ids.length; i += IN_CHUNK) {
    const chunk = ids.slice(i, i + IN_CHUNK)
    out.push(...await readPaged<ContactOptOutRow>((from, to) =>
      db.from('contact').select(cols).in('account_id', chunk).order('id').range(from, to)))
  }
  return out
}

/**
 * Souhrn nesouhlasu podle firmy. Firmy bez kontaktů i bez zákazu v poznámce
 * v mapě jsou taky (0 z 0) — volající se nemusí ptát, jestli chybí.
 * Před migrací 0087 (sloupec chybí) rozhoduje jen poznámka.
 */
export async function loadAccountOptOut(
  db: Db,
  accountIds: readonly number[],
  accountNotes?: ReadonlyMap<number, string | null>,
): Promise<Map<number, AccountOptOut>> {
  const ids = [...new Set(accountIds)]
  const result = new Map<number, AccountOptOut>()
  if (ids.length === 0) return result

  let notes = accountNotes
  if (!notes) {
    const rows: { id: number; notes: string | null }[] = []
    for (let i = 0; i < ids.length; i += IN_CHUNK) {
      const { data, error } = await db.from('account').select('id, notes').in('id', ids.slice(i, i + IN_CHUNK))
      if (error) throw error
      if (Array.isArray(data)) rows.push(...(data as { id: number; notes: string | null }[]))
    }
    notes = new Map(rows.map((r) => [Number(r.id), r.notes ?? null]))
  }

  let contacts: ContactOptOutRow[]
  try {
    contacts = await loadContacts(db, ids, true)
  } catch (e) {
    if (!isMissingColumn(e as DbError)) throw e
    contacts = await loadContacts(db, ids, false)
  }
  const byAccount = new Map<number, ContactOptOutRow[]>()
  for (const c of contacts) {
    if (c.account_id == null) continue
    const key = Number(c.account_id)
    const list = byAccount.get(key) ?? []
    list.push(c)
    byAccount.set(key, list)
  }
  for (const id of ids) result.set(id, summarizeAccountOptOut(notes.get(id) ?? null, byAccount.get(id) ?? []))
  return result
}
